import {
  BaseError,
  ContractFunctionRevertedError,
  RpcRequestError,
  TransactionReceiptNotFoundError,
  encodeFunctionData,
  keccak256,
  parseEther,
  type Abi,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type LocalAccount,
  type Transport
} from 'viem';
import {
  call,
  getBalance,
  getBlock,
  getBlockNumber,
  getTransactionCount,
  getTransactionReceipt,
  sendRawTransactionSync,
  simulateContract
} from 'viem/actions';
import { GAS, feeQuote, maxCostWei, type FeeQuote } from './gas.ts';
import type { Logger } from './log.ts';
import type { SentRow, SpendGovernor } from './spendGovernor.ts';

/** Monad user_reserve_balance (docs reserve-balance). */
export const RESERVE_BALANCE_WEI = parseEther('10');
/** k: consensus checks inflight spend over the last 3 blocks; an emptying tx needs no other tx from the sender in them. */
export const RESERVE_WINDOW_BLOCKS = 3n;
/** Dedupe window after a send (spec §4.1 "mark inflight for 3 blocks"). */
export const INFLIGHT_BLOCKS = 3n;

export const SEND_DEFAULTS = {
  sendTimeoutMs: 2_000,
  // A timed-out send not seen after this many blocks is treated as dropped (excluded txs never land).
  unknownTtlBlocks: 10n,
  pollMs: 150,
  maxQueue: 8,
  // Headroom above 10 MON before a non-emptying send is allowed (lagged balance, incoming funds).
  reserveMarginWei: parseEther('0.5'),
  driftCheckEvery: 50,
  // Restart seeding: settled sends this recent can still hold a dedupe key or the reserve window.
  seedWindowMs: 10 * 60_000,
  // A balance read stays usable this long (about the keeper's 30 s poll), less our own billed sends: only this key
  // spends from it (lease), so the cached value is a lower bound and an attempt needs no read (SE2-H1).
  balanceCacheBlocks: 100n,
  // F-1: a landed receipt missing on the read node counts as vanished only this many blocks after inclusion.
  vanishConfirmBlocks: 10n
} as const;

export type ChainClient = Client<Transport, Chain>;

export interface HeadInfo {
  number: bigint;
  baseFeePerGas: bigint | null;
}

interface SendBase {
  /** Action name for logs and the governor ledger. */
  label: string;
  ref?: string;
  /** Skip while a send with this key is within INFLIGHT_BLOCKS of inclusion. */
  dedupeKey?: string;
  /** Hot path: may use the governor's reserved headroom. */
  exempt?: boolean;
  /** Wait up to this long for the reserve-balance window instead of skipping (relay). */
  waitForWindowMs?: number;
  /** Runs after signing, before broadcast. Persist the hash here; a throw cancels the send. */
  onSigned?: (tx: { hash: Hex; nonce: number }) => void;
}

/** true sends as requested; an object re-books the send under another label and exemption. */
export type AcceptDecision = boolean | { label: string; exempt: boolean };

export interface ContractSend extends SendBase {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  gas: bigint;
  /** Decides from the simulated return value whether the send is worth its gas. Default: send. */
  accept?: (result: unknown) => AcceptDecision | Promise<AcceptDecision>;
}

export interface TransferSend extends SendBase {
  to: Address;
  value: bigint;
}

export type SkipReason =
  | 'inflight'
  | 'blocked'
  | 'busy'
  | 'reserve_window'
  | 'reserve_budget'
  | 'insufficient_balance'
  | 'simulation_reverted'
  | 'not_needed'
  | 'governor_cap'
  | 'rpc_error'
  | 'rejected'
  | 'halted';

export interface ReceiptLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

export type SendOutcome =
  | { status: 'confirmed'; hash: Hex; nonce: number; blockNumber: bigint; gasUsed: bigint; costWei: bigint; result?: unknown; logs: readonly ReceiptLog[] }
  | { status: 'reverted'; hash: Hex; nonce: number; blockNumber: bigint; costWei: bigint }
  | { status: 'pending'; hash: Hex; nonce: number }
  | { status: 'skipped'; reason: SkipReason; detail?: string };

export interface SendQueueOptions {
  /** Reads: simulate, balance, nonce, receipts. */
  client: ChainClient;
  /** eth_sendRawTransactionSync; defaults to `client`. Use createMonadSendClient (no failover on node errors). */
  sendClient?: ChainClient;
  account: LocalAccount;
  governor: SpendGovernor;
  log: Logger;
  /** Current head; defaults to getBlock('latest'). The keeper passes its monadNewHeads head. */
  head?: () => Promise<HeadInfo>;
  sendTimeoutMs?: number;
  unknownTtlBlocks?: bigint;
  pollMs?: number;
  maxQueue?: number;
  reserveMarginWei?: bigint;
  /**
   * STRICT_RESERVE_SPACING: space every send below 10 MON as an emptying tx, value or not.
   * Off by default: Monad reverts only on value spend, so gas-only calls need just the consensus budget.
   */
  strictReserveSpacing?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Tracked {
  hash: Hex;
  nonce: number;
  label: string;
  ref?: string;
  governorId: number;
  dedupeKey?: string;
  gas: bigint;
  value: bigint;
  maxFeePerGas: bigint;
  sentAtBlock: bigint;
  includedBlock: bigint | null;
  /** Recovered from the ledger after a restart: gas and value unknown, settle at the reserved amount. */
  recoveredWei?: bigint;
  /** F-1: its receipt was missing at a reconcile (logged once). */
  unseen?: boolean;
}

/** A send that may have landed but is no longer tracked: settled or released once the finalized nonce passes it. */
interface Unresolved {
  hash: Hex;
  nonce: number;
  governorId: number;
  label: string;
  costWei: bigint;
  /** Zero when recovered from the ledger (gas unknown): settles at costWei. */
  gas: bigint;
  value: bigint;
}

/** `raise` never lowers the local nonce (a lagging read node must not undo our own receipts, SE3-M1). */
type Resync = 'raise' | 'exact';

export interface SendQueueStatus {
  address: Address;
  nonce: number | null;
  pending: number;
  tracked: number;
  inflightKeys: number;
  unresolved: number;
  halted: string | null;
  lastIncludedBlock: string | null;
  balanceWei: string | null;
  belowReserve: boolean | null;
}

/**
 * One nonce stream per key. Every send: dedupe, reserve-balance window, simulate with the explicit
 * gas limit, governor reservation, local sign, eth_sendRawTransactionSync, settle. Sends are
 * serialized, so the local nonce only moves on our own receipts and is reconciled from chain state
 * after drops, rejections and on Finalized heads.
 */
export class SendQueue {
  readonly address: Address;
  private readonly o: SendQueueOptions & Required<Pick<SendQueueOptions, 'sendTimeoutMs' | 'unknownTtlBlocks' | 'pollMs' | 'maxQueue' | 'reserveMarginWei'>>;
  private nonce: number | null = null;
  private needsResync: Resync | null = null;
  private readonly tracked = new Map<Hex, Tracked>();
  private readonly unresolved = new Map<Hex, Unresolved>();
  private readonly inflight = new Map<string, bigint>();
  private haltReason: string | null = null;
  private readonly recent: { block: bigint; costWei: bigint }[] = [];
  private lastIncludedBlock: bigint | null = null;
  private balance: { wei: bigint; block: bigint } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private reconciles = 0;
  private reconcileTarget: bigint | null = null;
  private pendingReconcile: Promise<void> | null = null;

  constructor(opts: SendQueueOptions) {
    this.o = {
      sendTimeoutMs: SEND_DEFAULTS.sendTimeoutMs,
      unknownTtlBlocks: SEND_DEFAULTS.unknownTtlBlocks,
      pollMs: SEND_DEFAULTS.pollMs,
      maxQueue: SEND_DEFAULTS.maxQueue,
      reserveMarginWei: SEND_DEFAULTS.reserveMarginWei,
      ...opts
    };
    this.address = opts.account.address;
  }

  /**
   * Loads the nonce, then seeds the reserve window and dedupe keys from chain and the ledger,
   * so a restart neither resends an inflight action nor breaks emptying-tx spacing.
   */
  async init(): Promise<number> {
    this.nonce = await this.chainNonce();
    await this.seed();
    this.o.log.info({ address: this.address, nonce: this.nonce, lastIncludedBlock: this.lastIncludedBlock?.toString() ?? null }, 'send.nonce_init');
    return this.nonce;
  }

  /** Stops every later send (lease lost). */
  halt(reason: string): void {
    this.haltReason = reason;
    this.o.log.error({ address: this.address, reason }, 'send.halted');
  }

  /**
   * Startup check for a second sender on this key: pending txs we have no ledger row for.
   * Returns how many nonces between latest and pending are not ours.
   */
  async foreignPending(): Promise<number> {
    const [latest, pending] = await Promise.all([
      getTransactionCount(this.o.client, { address: this.address, blockTag: 'latest' }),
      getTransactionCount(this.o.client, { address: this.address, blockTag: 'pending' }).catch(() => null)
    ]);
    if (pending === null || pending <= latest) return 0;
    const ours = new Set(this.o.governor.sentRows(null).map((r) => r.nonce));
    let foreign = 0;
    for (let n = latest; n < pending; n++) if (!ours.has(n)) foreign++;
    return foreign;
  }

  isInflight(key: string, head: bigint): boolean {
    const until = this.inflight.get(key);
    if (until === undefined) return false;
    if (head > until) {
      this.inflight.delete(key);
      return false;
    }
    return true;
  }

  /** Frees a dedupe key early: the caller knows its landed send changed nothing (a reverted keeper step, SA4-03). */
  releaseKey(key: string): void {
    this.inflight.delete(key);
  }

  send(req: ContractSend | TransferSend): Promise<SendOutcome> {
    if (this.depth >= this.o.maxQueue) return Promise.resolve({ status: 'skipped', reason: 'busy' });
    return this.serial(() => this.run(req));
  }

  /**
   * Finalized head: settle timed-out sends, confirm receipts survived, resync the nonce when needed.
   * Calls coalesce: heads arrive faster than a sync send, so at most one reconcile waits in line.
   */
  reconcile(finalized: bigint): Promise<void> {
    if (this.reconcileTarget === null || finalized > this.reconcileTarget) this.reconcileTarget = finalized;
    this.pendingReconcile ??= this.serial(async () => {
      this.pendingReconcile = null;
      const target = this.reconcileTarget!;
      await this.refreshPending(target);
      await this.resolveUnresolved();
      let finalizedNonce: number | null = null;
      for (const t of [...this.tracked.values()]) {
        if (t.includedBlock === null || t.includedBlock > target) continue;
        if (await this.receipt(t.hash)) {
          this.tracked.delete(t.hash);
          continue;
        }
        // F-1: a read node behind the node that took our send has no receipt yet. Only a finalized nonce still at or
        // below ours, past the confirm window, proves an abandoned proposal; until then the local nonce stays.
        finalizedNonce ??= await getTransactionCount(this.o.client, { address: this.address, blockTag: 'finalized' });
        const fields = { label: t.label, ref: t.ref, hash: t.hash, nonce: t.nonce, block: t.includedBlock.toString(), finalizedNonce };
        if (finalizedNonce > t.nonce) {
          this.tracked.delete(t.hash);
          this.o.log.debug(fields, 'send.receipt_nonce_final');
          continue;
        }
        if (target < t.includedBlock + SEND_DEFAULTS.vanishConfirmBlocks) {
          if (!t.unseen) this.o.log.warn(fields, 'send.receipt_lagging');
          t.unseen = true;
          continue;
        }
        this.tracked.delete(t.hash);
        this.o.log.error(fields, 'send.receipt_vanished');
        this.needsResync = 'exact';
      }
      this.reconciles++;
      const drift = this.reconciles % SEND_DEFAULTS.driftCheckEvery === 0 && this.tracked.size === 0;
      if (this.needsResync) await this.resync(this.needsResync === 'raise' ? 'after_revert' : 'after_drop', this.needsResync);
      else if (drift) await this.resync('drift_check', 'raise');
    }, false);
    return this.pendingReconcile;
  }

  status(): SendQueueStatus {
    const pending = [...this.tracked.values()].filter((t) => t.includedBlock === null).length;
    return {
      address: this.address,
      nonce: this.nonce,
      pending,
      tracked: this.tracked.size,
      inflightKeys: this.inflight.size,
      unresolved: this.unresolved.size,
      halted: this.haltReason,
      lastIncludedBlock: this.lastIncludedBlock?.toString() ?? null,
      balanceWei: this.balance?.wei.toString() ?? null,
      belowReserve: this.balance ? this.balance.wei < RESERVE_BALANCE_WEI : null
    };
  }

  /** Balance read at most balanceCacheBlocks ago, less our own billed sends since. `fresh` forces a read (a refill). */
  async balanceAt(block: bigint, fresh = false): Promise<bigint> {
    if (!fresh && this.balance && block >= this.balance.block && block - this.balance.block <= SEND_DEFAULTS.balanceCacheBlocks) return this.balance.wei;
    const wei = await getBalance(this.o.client, { address: this.address, blockTag: 'latest' });
    this.balance = { wei, block };
    return wei;
  }

  /** @param counted sends count toward maxQueue; reconciles do not. */
  private serial<T>(fn: () => Promise<T>, counted = true): Promise<T> {
    if (counted) this.depth++;
    const p = this.tail.then(fn, fn).finally(() => {
      if (counted) this.depth -= 1;
    });
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async run(req: ContractSend | TransferSend): Promise<SendOutcome> {
    const log = this.o.log;
    const isContract = 'abi' in req;
    const gas = isContract ? req.gas : GAS.transfer;
    const value = req.value ?? 0n;
    if (this.haltReason) return { status: 'skipped', reason: 'halted', detail: this.haltReason };
    try {
      if (this.nonce === null) await this.init();
    } catch (err) {
      log.error({ err, label: req.label }, 'send.nonce_init_failed');
      return { status: 'skipped', reason: 'rpc_error', detail: 'nonce' };
    }

    let head: HeadInfo;
    let fee: FeeQuote;
    const deadline = (this.o.now ?? Date.now)() + (req.waitForWindowMs ?? 0);
    for (;;) {
      try {
        head = await this.headNow();
        if (this.hasPending()) await this.refreshPending(head.number);
        if (this.needsResync && !this.hasPending()) await this.resync(this.needsResync === 'raise' ? 'after_revert' : 'after_drop', this.needsResync);
        // Free provably dropped reservations before this send asks the governor.
        if (this.unresolved.size > 0) await this.resolveUnresolved();
      } catch (err) {
        log.warn({ err, label: req.label }, 'send.head_failed');
        return { status: 'skipped', reason: 'rpc_error', detail: 'head' };
      }
      if (req.dedupeKey && this.isInflight(req.dedupeKey, head.number)) return { status: 'skipped', reason: 'inflight' };
      fee = feeQuote(head.baseFeePerGas);
      const cost = maxCostWei(gas, fee, value);
      let balance: bigint;
      try {
        balance = await this.balanceAt(head.number);
        // A refill is invisible to the cache for up to balanceCacheBlocks: re-read once before refusing.
        if (balance < cost) balance = await this.balanceAt(head.number, true);
      } catch (err) {
        log.warn({ err, label: req.label }, 'send.balance_failed');
        return { status: 'skipped', reason: 'rpc_error', detail: 'balance' };
      }
      if (balance < cost) {
        log.error({ label: req.label, balanceWei: balance.toString(), costWei: cost.toString() }, 'send.insufficient_balance');
        return { status: 'skipped', reason: 'insufficient_balance' };
      }
      const gate: SkipReason | null = this.hasPending() ? 'blocked' : this.windowCheck(head.number, balance, gas * fee.maxFeePerGas, value);
      if (gate === null) break;
      if ((this.o.now ?? Date.now)() >= deadline || gate === 'reserve_budget') {
        log.debug({ label: req.label, reason: gate, head: head.number.toString() }, 'send.deferred');
        return { status: 'skipped', reason: gate };
      }
      await this.sleep(this.o.pollMs);
    }

    let result: unknown;
    let data: Hex | undefined;
    let to: Address;
    let label = req.label;
    let exempt = req.exempt ?? false;
    try {
      if (isContract) {
        to = req.address;
        data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args ?? [] } as Parameters<typeof encodeFunctionData>[0]);
        const sim = await simulateContract(this.o.client, {
          account: this.o.account,
          address: req.address,
          abi: req.abi,
          functionName: req.functionName,
          args: req.args ?? [],
          value,
          gas
        } as unknown as Parameters<typeof simulateContract>[1]);
        result = sim.result;
        if (req.accept) {
          const decision = await req.accept(result);
          if (decision === false) return { status: 'skipped', reason: 'not_needed' };
          if (decision !== true) ({ label, exempt } = decision);
        }
      } else {
        to = req.to;
        await call(this.o.client, { account: this.o.account, to, value, gas });
      }
    } catch (err) {
      const reason = revertReason(err);
      if (reason !== null) {
        log.info({ label: req.label, ref: req.ref, reason }, 'send.simulation_reverted');
        return { status: 'skipped', reason: 'simulation_reverted', detail: reason };
      }
      log.warn({ err, label: req.label, ref: req.ref }, 'send.simulation_failed');
      return { status: 'skipped', reason: 'rpc_error', detail: 'simulate' };
    }

    const cost = maxCostWei(gas, fee, value);
    const reservation = this.o.governor.reserve({ action: label, ref: req.ref, amountWei: cost, exempt, dedupeKey: req.dedupeKey });
    if (!reservation.ok) return { status: 'skipped', reason: 'governor_cap', detail: reservation.reason };

    const nonce = this.nonce!;
    let serialized: Hex;
    try {
      serialized = await this.o.account.signTransaction({
        chainId: this.o.client.chain.id,
        type: 'eip1559',
        nonce,
        to,
        data,
        value,
        gas,
        maxFeePerGas: fee.maxFeePerGas,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas
      });
    } catch (err) {
      this.o.governor.release(reservation.id);
      log.error({ err: errorSummary(err), label }, 'send.sign_failed');
      return { status: 'skipped', reason: 'rejected', detail: 'sign' };
    }
    const hash = keccak256(serialized);
    this.o.governor.attach(reservation.id, hash, nonce);
    try {
      req.onSigned?.({ hash, nonce });
    } catch (err) {
      // Never broadcast a tx the caller could not record.
      this.o.governor.release(reservation.id);
      log.error({ err, label, hash }, 'send.persist_failed');
      return { status: 'skipped', reason: 'rejected', detail: 'persist' };
    }
    const t: Tracked = {
      hash,
      nonce,
      label,
      ref: req.ref,
      governorId: reservation.id,
      dedupeKey: req.dedupeKey,
      gas,
      value,
      maxFeePerGas: fee.maxFeePerGas,
      sentAtBlock: head.number,
      includedBlock: null
    };

    try {
      const receipt = await sendRawTransactionSync(this.o.sendClient ?? this.o.client, {
        serializedTransaction: serialized,
        timeout: this.o.sendTimeoutMs,
        throwOnReceiptRevert: false
      });
      this.nonce = nonce + 1;
      const costWei = this.include(t, receipt.blockNumber, receipt.effectiveGasPrice, receipt.status === 'success');
      if (receipt.status !== 'success') {
        // A revert consumes the nonce: resync only upward, a lagging read node must not lower it.
        this.needsResync ??= 'raise';
        log.error({ label, ref: req.ref, hash, nonce, block: receipt.blockNumber.toString(), gasLimit: gas.toString() }, 'send.reverted');
        return { status: 'reverted', hash, nonce, blockNumber: receipt.blockNumber, costWei };
      }
      log.info(
        {
          label,
          ref: req.ref,
          hash,
          nonce,
          block: receipt.blockNumber.toString(),
          gasLimit: gas.toString(),
          gasUsed: receipt.gasUsed.toString(),
          costWei: costWei.toString()
        },
        'send.confirmed'
      );
      const logs = receipt.logs.map((l) => ({ address: l.address, topics: l.topics as readonly Hex[], data: l.data }));
      return { status: 'confirmed', hash, nonce, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, costWei, result, logs };
    } catch (err) {
      const kind = classifySendError(err);
      if (kind === 'rejected') {
        this.o.governor.release(reservation.id);
        this.needsResync = 'exact';
        // The full viem error carries the signed raw tx (rebroadcastable until the nonce is used): summary only.
        log.error({ err: errorSummary(err), label, ref: req.ref, hash, nonce }, 'send.rejected');
        return { status: 'skipped', reason: 'rejected' };
      }
      // Possibly accepted: assume the nonce is used and hold every later send until we know.
      this.nonce = nonce + 1;
      this.o.governor.markUnknown(reservation.id);
      this.tracked.set(hash, t);
      if (req.dedupeKey) this.inflight.set(req.dedupeKey, head.number + this.o.unknownTtlBlocks + INFLIGHT_BLOCKS);
      log.warn({ err: errorSummary(err), label, ref: req.ref, hash, nonce }, 'send.pending');
      return { status: 'pending', hash, nonce };
    }
  }

  /** Records an inclusion and settles the governor. Returns the billed wei. */
  private include(t: Tracked, block: bigint, effectiveGasPrice: bigint | undefined, success: boolean): bigint {
    const price = effectiveGasPrice ?? t.maxFeePerGas;
    // Monad bills the gas limit; value moves only on success.
    const costWei = t.recoveredWei ?? t.gas * price + (success ? t.value : 0n);
    this.o.governor.settle(t.governorId, costWei);
    t.includedBlock = block;
    this.tracked.set(t.hash, t);
    if (this.lastIncludedBlock === null || block > this.lastIncludedBlock) this.lastIncludedBlock = block;
    // Consensus budgets gas_bid x gas_limit, and an emptying tx's value lowers the budget for k blocks.
    this.recent.push({ block, costWei: t.recoveredWei ?? t.gas * t.maxFeePerGas + t.value });
    if (t.dedupeKey) this.inflight.set(t.dedupeKey, block + INFLIGHT_BLOCKS);
    // Monad bills exactly this, so the cached balance stays exact without another read.
    if (this.balance) this.balance = { wei: this.balance.wei > costWei ? this.balance.wei - costWei : 0n, block: this.balance.block };
    return costWei;
  }

  /**
   * Null when the send may go now, else why not (docs.monad.xyz reserve-balance).
   * Execution reverts only on value spend that ends below 10 MON, unless the tx is emptying (no other tx
   * from the sender in the last k blocks). Consensus caps inflight gas_bid x gas_limit at min(10 MON, balance).
   */
  private windowCheck(head: bigint, balance: bigint, gasBid: bigint, value: bigint): SkipReason | null {
    while (this.recent.length > 0 && this.recent[0]!.block <= head - RESERVE_WINDOW_BLOCKS) this.recent.shift();
    const recentSpend = this.recent.reduce((s, r) => s + r.costWei, 0n);
    const spacing = value > 0n || this.o.strictReserveSpacing === true;
    if (spacing && balance - recentSpend - gasBid - value < RESERVE_BALANCE_WEI + this.o.reserveMarginWei) {
      if (this.lastIncludedBlock !== null && head - this.lastIncludedBlock < RESERVE_WINDOW_BLOCKS) return 'reserve_window';
      return null;
    }
    const budget = balance < RESERVE_BALANCE_WEI ? balance : RESERVE_BALANCE_WEI;
    return recentSpend + gasBid > budget ? 'reserve_budget' : null;
  }

  private hasPending(): boolean {
    for (const t of this.tracked.values()) if (t.includedBlock === null) return true;
    return false;
  }

  private async refreshPending(head: bigint): Promise<void> {
    for (const t of [...this.tracked.values()]) {
      if (t.includedBlock !== null) continue;
      const receipt = await this.receipt(t.hash);
      if (receipt) {
        this.include(t, receipt.blockNumber, receipt.effectiveGasPrice, receipt.status === 'success');
        this.o.log.info({ label: t.label, ref: t.ref, hash: t.hash, status: receipt.status }, 'send.pending_resolved');
        if (receipt.status !== 'success') this.needsResync ??= 'raise';
        continue;
      }
      if (head < t.sentAtBlock + this.o.unknownTtlBlocks) continue;
      // Not seen within the TTL: most likely excluded, but a lagging RPC can hide a landed tx.
      // Unblock the queue and keep the reservation counted until the finalized nonce passes it.
      this.tracked.delete(t.hash);
      this.unresolved.set(t.hash, {
        hash: t.hash,
        nonce: t.nonce,
        governorId: t.governorId,
        label: t.label,
        costWei: t.recoveredWei ?? t.gas * t.maxFeePerGas + t.value,
        gas: t.recoveredWei === undefined ? t.gas : 0n,
        value: t.value
      });
      this.needsResync = 'exact';
      this.o.log.warn({ label: t.label, ref: t.ref, hash: t.hash, nonce: t.nonce }, 'send.dropped');
    }
  }

  /** Settles a late-landed send, or releases it once a finalized tx used its nonce. */
  private async resolveUnresolved(): Promise<void> {
    if (this.unresolved.size === 0) return;
    const finalizedNonce = await getTransactionCount(this.o.client, { address: this.address, blockTag: 'finalized' });
    for (const u of [...this.unresolved.values()]) {
      const receipt = await this.receipt(u.hash);
      if (receipt) {
        this.unresolved.delete(u.hash);
        const price = receipt.effectiveGasPrice;
        const billed = u.gas > 0n && price !== undefined ? u.gas * price + (receipt.status === 'success' ? u.value : 0n) : u.costWei;
        this.o.governor.settle(u.governorId, billed);
        // SE3-I5: the cache never saw this spend.
        if (this.balance) this.balance = { wei: this.balance.wei > billed ? this.balance.wei - billed : 0n, block: this.balance.block };
        this.o.log.error({ label: u.label, hash: u.hash, nonce: u.nonce, block: receipt.blockNumber.toString(), billedWei: billed.toString() }, 'send.landed_after_drop');
        continue;
      }
      if (finalizedNonce > u.nonce) {
        this.unresolved.delete(u.hash);
        this.o.governor.release(u.governorId);
        this.o.log.info({ label: u.label, hash: u.hash, nonce: u.nonce }, 'send.drop_confirmed');
      }
    }
  }

  /** L-1: a restart must not forget the last inclusion, open sends or dedupe keys. */
  private async seed(): Promise<void> {
    const head = await getBlockNumber(this.o.client, { cacheTime: 0 });
    if (head > RESERVE_WINDOW_BLOCKS) {
      const [now, before] = await Promise.all([
        getTransactionCount(this.o.client, { address: this.address, blockTag: 'latest' }),
        getTransactionCount(this.o.client, { address: this.address, blockNumber: head - RESERVE_WINDOW_BLOCKS })
      ]);
      // Something from this key landed in the last k blocks; assume the latest block.
      if (now > before) this.lastIncludedBlock = head;
    }
    const since = new Date((this.o.now ?? Date.now)() - SEND_DEFAULTS.seedWindowMs).toISOString();
    const rows = this.o.governor.sentRows(since);
    if (rows.length === 0) return;
    const finalizedNonce = await getTransactionCount(this.o.client, { address: this.address, blockTag: 'finalized' });
    for (const row of rows) await this.seedRow(row, head, finalizedNonce);
  }

  private async seedRow(row: SentRow, head: bigint, finalizedNonce: number): Promise<void> {
    if (row.txHash === null || row.nonce === null) {
      // Reserved but never signed (the hash is attached before broadcast): nothing reached the chain.
      if (row.status !== 'settled') this.o.governor.release(row.id);
      return;
    }
    const hash = row.txHash as Hex;
    const receipt = await this.receipt(hash);
    if (receipt) {
      if (row.status !== 'settled') this.o.governor.settle(row.id, row.reservedWei);
      if (head - receipt.blockNumber < RESERVE_WINDOW_BLOCKS) this.recent.push({ block: receipt.blockNumber, costWei: row.reservedWei });
      if (this.lastIncludedBlock === null || receipt.blockNumber > this.lastIncludedBlock) this.lastIncludedBlock = receipt.blockNumber;
      if (row.dedupeKey && receipt.blockNumber + INFLIGHT_BLOCKS >= head) this.inflight.set(row.dedupeKey, receipt.blockNumber + INFLIGHT_BLOCKS);
      return;
    }
    if (row.status === 'settled') return;
    if (row.nonce < finalizedNonce) {
      // A finalized tx used this nonce and it is not ours: it can never land.
      this.o.governor.release(row.id);
      this.o.log.info({ label: row.action, hash, nonce: row.nonce }, 'send.drop_confirmed');
      return;
    }
    // Sent by the previous process with no receipt yet: it may still land, so hold the queue like a pending send.
    this.tracked.set(hash, {
      hash,
      nonce: row.nonce,
      label: row.action,
      ref: row.ref ?? undefined,
      governorId: row.id,
      dedupeKey: row.dedupeKey ?? undefined,
      gas: 0n,
      value: 0n,
      maxFeePerGas: 0n,
      sentAtBlock: head,
      includedBlock: null,
      recoveredWei: row.reservedWei
    });
    if (row.dedupeKey) this.inflight.set(row.dedupeKey, head + this.o.unknownTtlBlocks + INFLIGHT_BLOCKS);
    // Its nonce counts as used until it lands or is dropped (then the queue resyncs).
    if (this.nonce === null || this.nonce <= row.nonce) this.nonce = row.nonce + 1;
    this.o.log.warn({ label: row.action, hash, nonce: row.nonce }, 'send.recovered_pending');
  }

  /** `exact` follows the chain (after a drop or rejection); `raise` only ever moves the local nonce up. */
  private async resync(reason: string, mode: Resync): Promise<void> {
    const chain = await this.chainNonce();
    const local = this.nonce ?? 0;
    const next = mode === 'raise' && chain < local ? local : chain;
    if (chain !== this.nonce) {
      // Higher than ours means another sender used this key (CRE broadcast must only run while the keeper is stopped).
      this.o.log[chain > local ? 'error' : 'warn']({ address: this.address, local: this.nonce, chain, reason, mode, kept: next === local }, 'send.nonce_resync');
    }
    this.nonce = next;
    this.needsResync = null;
  }

  private async chainNonce(): Promise<number> {
    const [latest, pending] = await Promise.all([
      getTransactionCount(this.o.client, { address: this.address, blockTag: 'latest' }),
      getTransactionCount(this.o.client, { address: this.address, blockTag: 'pending' }).catch(() => 0)
    ]);
    return Math.max(latest, pending);
  }

  private async receipt(hash: Hex) {
    try {
      return await getTransactionReceipt(this.o.client, { hash });
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) return null;
      throw err;
    }
  }

  private async headNow(): Promise<HeadInfo> {
    if (this.o.head) return this.o.head();
    const b = await getBlock(this.o.client, { blockTag: 'latest' });
    return { number: b.number, baseFeePerGas: b.baseFeePerGas ?? null };
  }

  private sleep(ms: number): Promise<void> {
    return this.o.sleep ? this.o.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }
}

/** Name, RPC code and short message only: viem's full message embeds the request body (the signed tx). */
export function errorSummary(err: unknown): { name: string; code?: number; message: string } {
  if (err instanceof BaseError) {
    const rpc = err.walk((e) => e instanceof RpcRequestError);
    if (rpc instanceof RpcRequestError) return { name: rpc.name, code: rpc.code, message: rpc.details.slice(0, 200) };
    return { name: err.name, message: err.shortMessage.slice(0, 200) };
  }
  if (err instanceof Error) return { name: err.name, message: err.message.slice(0, 200) };
  return { name: 'unknown', message: String(err).slice(0, 200) };
}

/** Decoded revert name or reason for a simulation failure; null when the failure was not a revert. */
export function revertReason(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    return revert.data?.errorName ?? revert.reason ?? revert.signature ?? 'reverted';
  }
  const rpc = err.walk((e) => e instanceof RpcRequestError);
  if (rpc instanceof RpcRequestError && (rpc.code === 3 || /revert/i.test(rpc.message))) return 'reverted';
  return null;
}

/**
 * EIP-7966: code 4 means accepted but not yet included (pending). Any other node error means
 * the tx was not accepted, except "already known". No node answer at all: it may have landed.
 */
export function classifySendError(err: unknown): 'pending' | 'rejected' {
  const rpc = err instanceof BaseError ? err.walk((e) => e instanceof RpcRequestError) : null;
  if (!(rpc instanceof RpcRequestError)) return 'pending';
  if (rpc.code === 4 || /already known|known transaction/i.test(rpc.message)) return 'pending';
  return 'rejected';
}
