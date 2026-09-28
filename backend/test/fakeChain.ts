import { Writable } from 'node:stream';
import pino from 'pino';
import {
  RpcRequestError,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  multicall3Abi,
  numberToHex,
  parseGwei,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex
} from 'viem';
import { monad } from 'viem/chains';
import type { Logger } from '../src/lib/log.ts';

export interface SentTx {
  hash: Hex;
  from: Address;
  raw: Hex;
  nonce: number;
  to: Address | null;
  data: Hex | undefined;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  chainId: number;
  sentAtHead: bigint;
}

export interface EthCall {
  to: Address;
  data: Hex;
  from?: Address;
  value?: bigint;
  gas?: bigint;
  /** eth_call block parameter: a tag or a hex number. */
  block?: string;
}

/** Return encoded data, `{ revert }` with encoded error data, or undefined to fall through. */
export type CallHandler = (c: EthCall) => Hex | { revert: Hex } | undefined;

export type SendBehavior =
  | { kind: 'success' }
  | { kind: 'revert' }
  | { kind: 'timeout' }
  | { kind: 'error'; code: number; message: string; data?: Hex }
  | { kind: 'transport' };

const MULTICALL3 = monad.contracts.multicall3.address.toLowerCase();

function rpcError(code: number, message: string, data?: Hex): RpcRequestError {
  return new RpcRequestError({ body: { method: 'fake' }, error: { code, message, data }, url: 'http://fake.local' });
}

/**
 * In-memory Monad for viem's custom transport. Only the methods the keeper and relay use.
 * Sync sends land in head + 1 and do not advance the head; tests move it with `setHead`.
 */
export class FakeChain {
  head = 1_000n;
  finalized = 998n;
  baseFee = parseGwei('100');
  readonly balances = new Map<string, bigint>();
  readonly nonces = new Map<string, number>();
  readonly receipts = new Map<Hex, Record<string, unknown>>();
  readonly sent: SentTx[] = [];
  readonly methods: string[] = [];
  handlers: CallHandler[] = [];
  /** Next sends' behavior, consumed in order; defaults to success. */
  sendQueue: SendBehavior[] = [];
  /** Called on every eth_blockNumber / latest block read (lets tests advance time while polling). */
  onHeadRead: (() => void) | null = null;
  logs: Record<string, unknown>[] = [];
  /** Emulates a tx's state change (the fake executes nothing). */
  onSent: ((tx: SentTx) => void) | null = null;
  /** Receipt logs for a landed tx (default none). */
  logsFor: ((tx: SentTx) => Record<string, unknown>[]) | null = null;
  /** Move the head to each sync send's landing block (a later send from the same key lands in a later block). */
  advanceOnSend = false;
  /** Bytecode per address (an EIP-7702 delegated EOA has code); default empty. */
  readonly codes = new Map<string, Hex>();
  /** Overrides for the `pending` and `finalized` nonce tags; default is the latest nonce. */
  readonly pendingNonces = new Map<string, number>();
  readonly finalizedNonces = new Map<string, number>();
  /** Lagging read node (F-1): receipts and nonce reads see blocks up to this height only; sends still land. */
  readHead: bigint | null = null;
  /** Reject a send whose nonce a landed tx already used, like a real node ("nonce too low"). */
  strictNonces = false;

  setHead(n: bigint): void {
    this.head = n;
  }

  balance(addr: Address, wei: bigint): void {
    this.balances.set(addr.toLowerCase(), wei);
  }

  /** Includes a pending (timed-out) tx now, as if it landed late. */
  mine(hash: Hex, status: 'success' | 'revert' = 'success', block = this.head): void {
    const tx = this.sent.find((t) => t.hash === hash);
    if (!tx) throw new Error('unknown tx');
    this.receipts.set(hash, this.receiptFor(tx, status, block));
  }

  /** Drops a receipt, as if its proposal was abandoned. */
  forget(hash: Hex): void {
    this.receipts.delete(hash);
  }

  client() {
    return createPublicClient({ chain: monad, transport: custom({ request: (a: { method: string; params?: unknown[] }) => this.request(a) }, { retryCount: 0 }) });
  }

  async request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
    this.methods.push(method);
    switch (method) {
      case 'eth_chainId':
        return numberToHex(monad.id);
      case 'eth_blockNumber':
        this.onHeadRead?.();
        return numberToHex(this.head);
      case 'eth_getBlockByNumber': {
        const tag = params[0];
        if (tag === 'latest') this.onHeadRead?.();
        const n = tag === 'latest' ? this.head : tag === 'finalized' ? this.finalized : BigInt(tag as string);
        return this.block(n);
      }
      case 'eth_getBalance':
        return numberToHex(this.balances.get(String(params[0]).toLowerCase()) ?? 0n);
      case 'eth_getTransactionCount':
        return numberToHex(this.nonceAt(String(params[0]).toLowerCase(), params[1]));
      case 'eth_getCode':
        return this.codes.get(String(params[0]).toLowerCase()) ?? '0x';
      case 'eth_getTransactionReceipt': {
        const r = this.receipts.get(params[0] as Hex);
        if (r && this.readHead !== null && BigInt(r.blockNumber as Hex) > this.readHead) return null;
        return r ?? null;
      }
      case 'eth_call':
        return this.call(params[0] as Record<string, string>, params[1] as string | undefined);
      case 'eth_getLogs': {
        const f = params[0] as { fromBlock: Hex; toBlock: Hex };
        const from = BigInt(f.fromBlock);
        const to = BigInt(f.toBlock);
        return this.logs.filter((l) => BigInt(l.blockNumber as Hex) >= from && BigInt(l.blockNumber as Hex) <= to);
      }
      case 'eth_sendRawTransactionSync':
        return this.sendSync(params[0] as Hex);
      default:
        throw rpcError(-32601, `method not found: ${method}`);
    }
  }

  /** Latest nonce minus this sender's receipts above a block number; tags use the override maps and `readHead`. */
  private nonceAt(addr: string, tag: unknown): number {
    const lag = this.readHead;
    const latest = lag === null ? (this.nonces.get(addr) ?? 0) : this.nonceAtBlock(addr, lag);
    if (tag === 'pending') return this.pendingNonces.get(addr) ?? latest;
    if (tag === 'finalized') return this.finalizedNonces.get(addr) ?? (lag === null ? latest : this.nonceAtBlock(addr, lag < this.finalized ? lag : this.finalized));
    if (typeof tag !== 'string' || !tag.startsWith('0x')) return latest;
    return this.nonceAtBlock(addr, BigInt(tag));
  }

  private nonceAtBlock(addr: string, n: bigint): number {
    let later = 0;
    for (const r of this.receipts.values()) if (String(r.from).toLowerCase() === addr && BigInt(r.blockNumber as Hex) > n) later++;
    return (this.nonces.get(addr) ?? 0) - later;
  }

  private block(n: bigint) {
    return {
      number: numberToHex(n),
      hash: keccak256(numberToHex(n, { size: 32 })),
      parentHash: keccak256(numberToHex(n - 1n, { size: 32 })),
      timestamp: numberToHex(1_791_000_000n + n / 3n),
      baseFeePerGas: numberToHex(this.baseFee),
      gasLimit: numberToHex(150_000_000n),
      gasUsed: '0x0',
      transactions: [],
      uncles: []
    };
  }

  private call(p: Record<string, string>, block?: string): Hex {
    const c: EthCall = {
      to: p.to as Address,
      data: (p.data ?? p.input) as Hex,
      from: p.from as Address | undefined,
      value: p.value ? BigInt(p.value) : undefined,
      gas: p.gas ? BigInt(p.gas) : undefined,
      block
    };
    if (c.to.toLowerCase() === MULTICALL3) return this.multicall(c);
    const out = this.dispatch(c);
    if (out === undefined) {
      // Plain value transfer to an EOA.
      if (!c.data || c.data === '0x') return '0x';
      throw rpcError(-32000, `no fake handler for call to ${c.to}`);
    }
    if (typeof out === 'object') throw rpcError(3, 'execution reverted', out.revert);
    return out;
  }

  private dispatch(c: EthCall) {
    for (const h of this.handlers) {
      const out = h(c);
      if (out !== undefined) return out;
    }
    return undefined;
  }

  private multicall(c: EthCall): Hex {
    const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data: c.data });
    if (functionName !== 'aggregate3') throw rpcError(-32000, 'only aggregate3');
    const calls = args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
    const results = calls.map((x) => {
      const out = this.dispatch({ to: x.target, data: x.callData, from: c.from, block: c.block });
      if (out === undefined) return { success: false, returnData: '0x' as Hex };
      if (typeof out === 'object') {
        if (!x.allowFailure) throw rpcError(3, 'execution reverted', out.revert);
        return { success: false, returnData: out.revert };
      }
      return { success: true, returnData: out };
    });
    return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results });
  }

  private async sendSync(raw: Hex) {
    const tx = parseTransaction(raw);
    const hash = keccak256(raw);
    const from = await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction'] });
    const sent: SentTx = {
      hash,
      from,
      raw,
      nonce: tx.nonce ?? 0,
      to: tx.to ?? null,
      data: tx.data,
      value: tx.value ?? 0n,
      gas: tx.gas ?? 0n,
      maxFeePerGas: tx.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n,
      chainId: tx.chainId ?? 0,
      sentAtHead: this.head
    };
    if (this.strictNonces && sent.nonce < (this.nonces.get(from.toLowerCase()) ?? 0)) throw rpcError(-32000, 'nonce too low');
    const behavior = this.sendQueue.shift() ?? { kind: 'success' };
    if (behavior.kind === 'error') throw rpcError(behavior.code, behavior.message, behavior.data);
    this.sent.push(sent);
    if (behavior.kind === 'transport') throw new Error('socket hang up');
    if (behavior.kind === 'timeout') throw rpcError(4, 'transaction added to mempool but not processed within timeout', hash);
    const receipt = this.receiptFor(sent, behavior.kind === 'revert' ? 'revert' : 'success', this.head + 1n);
    this.receipts.set(hash, receipt);
    if (behavior.kind === 'success') this.onSent?.(sent);
    if (this.advanceOnSend) this.head += 1n;
    return receipt;
  }

  private receiptFor(tx: SentTx, status: 'success' | 'revert', block: bigint) {
    const key = tx.from.toLowerCase();
    this.nonces.set(key, Math.max(this.nonces.get(key) ?? 0, tx.nonce + 1));
    const price = this.baseFee + tx.maxPriorityFeePerGas < tx.maxFeePerGas ? this.baseFee + tx.maxPriorityFeePerGas : tx.maxFeePerGas;
    return {
      blockHash: keccak256(numberToHex(block, { size: 32 })),
      blockNumber: numberToHex(block),
      contractAddress: null,
      cumulativeGasUsed: numberToHex(tx.gas / 2n),
      effectiveGasPrice: numberToHex(price),
      from: tx.from,
      gasUsed: numberToHex(tx.gas / 2n),
      logs: status === 'success' ? (this.logsFor?.(tx) ?? []) : [],
      logsBloom: `0x${'00'.repeat(256)}`,
      status: status === 'success' ? '0x1' : '0x0',
      to: tx.to,
      transactionHash: tx.hash,
      transactionIndex: '0x0',
      type: '0x2'
    };
  }
}

/** Logger that keeps parsed lines for assertions. */
export function captureLogger(): { log: Logger; lines: Record<string, unknown>[]; events: () => string[] } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n')) if (l.trim()) lines.push(JSON.parse(l));
      cb();
    }
  });
  const log = pino({ level: 'debug' }, stream) as unknown as Logger;
  return { log, lines, events: () => lines.map((l) => String(l.msg)) };
}

/** Well-known Anvil dev keys (public). Test-only; never hold value. */
export const TEST_KEYS = {
  keeper: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  relay: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  owner: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  other: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'
} as const;
