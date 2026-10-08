import type { CommandIO } from "@metamask/agent-wallet/plugin";
import {
  type Abi,
  type Address,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  keccak256,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { vi } from "vitest";
import {
  IAUSDAbi,
  ICoverManagerAbi,
  IGaplessAccountAbi,
  IGaplessFactoryAbi,
  IPerplMinAbi,
} from "../../src/abi/index.js";
import type { Host } from "../../src/lib/host.js";

export const A = {
  // Canary deployment (deployments/143.json); must equal the packaged src/addresses.ts.
  manager: "0xb07C20cb5328d5208A1453521b94beeB3Faa1771",
  factory: "0xB1a255e9D4CEdC20998ddC67a7Ec5e0B71bd8777",
  exchange: "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F",
  ausd: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
  account: "0x3333333333333333333333333333333333333333",
  owner: "0x4444444444444444444444444444444444444444",
  agent: "0x5555555555555555555555555555555555555555",
  other: "0x6666666666666666666666666666666666666666",
} as const satisfies Record<string, Address>;

export const TX_HASH: Hex = `0x${"ab".repeat(32)}`;
export const COVER_ID: Hex = `0x${"cd".repeat(32)}`;

export class Revert {
  constructor(
    readonly abi: Abi,
    readonly errorName: string,
    readonly args: readonly unknown[],
  ) {}
}

export const MARKET_PARAMS = {
  slipAllowanceBps: 5, maxGapBpsCap: 200, floorSlackBps: 100, refTolBps: 50, minStopDistanceBps: 10, kDistE2: 300,
  loadBps: 5000, rentAprBps: 2000, uKinkBps: 5000, slope1Bps: 5000, slope2Bps: 40000, marketCapBps: 10000,
  perBlockPayoutCapBps: 2500, maxLossToDepositBps: 4000, impactBpsPerKE2: 10, maxMatchesClose: 8, warmupBlocks: 200,
  armTtlBlocks: 200, exclusiveBlocks: 3, windowBlocks: 40, minDurationBlocks: 1000, maxDurationBlocks: 48000,
  sigmaMaxAgeBlocks: 6000, refFreshSec: 60, feedMaxAgeSec: 120, minFeeCNS: 20000n, maxCoverNotionalCNS: 20_000_000n,
  zEdgesE2: [50, 100, 150, 200, 250, 300, 400, 600], gapBpsE2: [194, 91, 101, 143, 229, 452, 492, 999, 950],
} as const;

export type World = {
  chainId: number;
  blockNumber: bigint;
  timestamp: bigint;
  owner: Address;
  operator: { key: Address; expiry: bigint; maxNotionalPerTradeCNS: bigint; maxNotionalPerDayCNS: bigint };
  usage: [bigint, bigint];
  opNonce: bigint;
  perplAccountId: bigint;
  isAccount: (a: Address) => boolean;
  accountOf: Address;
  markPNS: bigint;
  bidONS: bigint;
  askONS: bigint;
  quote: { notionalCNS: bigint; capCNS: bigint; escrowCNS: bigint; rentCNS: bigint; feeBpsE2: bigint; utilAfterBps: bigint; distanceBps: bigint; minDistanceBps: bigint; expiryBlock: bigint };
  quoteRevert?: Revert;
  probeNeed: bigint;
  activeCover: Hex;
  cover: { account: Address; status: number };
  gasEstimate: bigint;
  /** Reverts the signed path (non-probe simulation and estimate) of any account or factory write. */
  writeRevert?: Revert;
  ausdBalance: bigint;
  ausdAllowance: bigint;
  receiptLogs: { address: Address; topics: Hex[]; data: Hex }[];
  receiptStatus: "0x1" | "0x0";
};

export function world(over: Partial<World> = {}): World {
  return {
    chainId: 143,
    blockNumber: 1_000_000n,
    timestamp: 1_760_000_000n,
    owner: A.owner,
    operator: { key: A.agent, expiry: 1_760_014_400n, maxNotionalPerTradeCNS: 25_000_000n, maxNotionalPerDayCNS: 100_000_000n },
    usage: [0n, 100_000_000n],
    opNonce: 7n,
    perplAccountId: 42n,
    isAccount: (a) => a.toLowerCase() === A.account.toLowerCase(),
    accountOf: A.account,
    markPNS: 852_750n,
    bidONS: 852_740n,
    askONS: 852_760n,
    quote: {
      notionalCNS: 18_480_000n, capCNS: 369_600n, escrowCNS: 9_770n, rentCNS: 20_000n, feeBpsE2: 5_285n,
      utilAfterBps: 1_200n, distanceBps: 149n, minDistanceBps: 60n, expiryBlock: 1_012_000n,
    },
    probeNeed: 29_770n,
    activeCover: zeroHash,
    cover: { account: A.account, status: 1 },
    gasEstimate: 1_000_001n,
    ausdBalance: 50_000_000n,
    ausdAllowance: 0n,
    receiptLogs: [],
    receiptStatus: "0x1",
    ...over,
  };
}

function perpInfo(w: World) {
  return {
    name: "Bitcoin", symbol: "BTC", priceDecimals: 1n, lotDecimals: 5n, linkFeedId: zeroHash, priceTolPer100K: 0n,
    marginTol: 0n, marginTolDecimals: 0n, refPriceMaxAgeSec: 60n, positionBalanceCNS: 0n, insuranceBalanceCNS: 0n,
    markPNS: w.markPNS, markTimestamp: w.timestamp, lastPNS: w.markPNS, lastTimestamp: w.timestamp, oraclePNS: w.markPNS,
    oracleTimestampSec: w.timestamp, longOpenInterestLNS: 0n, shortOpenInterestLNS: 0n, fundingStartBlock: 0n,
    fundingRatePct100k: 0, absFundingClampPctPer100K: 0n, status: 4, basePricePNS: 0n, maxBidPriceONS: w.bidONS,
    minBidPriceONS: w.bidONS, maxAskPriceONS: w.askONS, minAskPriceONS: w.askONS, numOrders: 2n, ignOracle: false,
  };
}

function coverStruct(w: World) {
  return {
    account: w.cover.account, perpId: 1, status: w.cover.status, isLong: true, maxGapBps: 200, observed: false,
    lots: 22n, filledLots: 0n, stopPNS: 840_000, startBlock: 999_000, expiryBlock: 1_011_000, armedBlock: 0,
    capCNS: 369_600n, escrowCNS: 9_770n, rentCNS: 20_000n, triggerBlock: 0, triggerTs: 0n, refTrigPNS: 0, refPostPNS: 0,
    paidCNS: 0n, armer: zeroAddress, owedCNS: 0n, gRealCumCNS: 0n, slipAllowanceBps: 5, floorSlackBps: 100,
    shortBlock: 0, shortSteps: 0, minDistanceBps: 60, warmupBlocks: 200, windowBlocks: 40,
  };
}

type Handler = (args: readonly unknown[], from: Address | undefined, w: World) => unknown;

function contracts(w: World): Record<string, { abi: Abi; fns: Record<string, Handler> }> {
  const write = (ok: unknown): Handler => () => {
    if (w.writeRevert) throw w.writeRevert;
    return ok;
  };
  return {
    [A.manager.toLowerCase()]: {
      abi: ICoverManagerAbi,
      fns: {
        factory: () => A.factory,
        EXCHANGE: () => A.exchange,
        AUSD: () => A.ausd,
        listedPerps: () => [1n],
        marketConfig: () => ({ listed: true, priceDecimals: 1, lotDecimals: 5, scale: 1n, feed: zeroAddress, feedDecimals: 8, creRefStore: zeroAddress }),
        marketParams: () => MARKET_PARAMS,
        quote: () => {
          if (w.quoteRevert) throw w.quoteRevert;
          return w.quote;
        },
        activeCoverOf: () => w.activeCover,
        getCover: () => coverStruct(w),
        isLocked: () => false,
        refundOwed: () => 0n,
      },
    },
    [A.factory.toLowerCase()]: {
      abi: IGaplessFactoryAbi,
      fns: {
        accountOf: () => w.accountOf,
        isAccount: ([a]) => w.isAccount(a as Address),
        createAccount: write(A.account),
      },
    },
    [A.exchange.toLowerCase()]: { abi: IPerplMinAbi, fns: { getPerpetualInfo: () => perpInfo(w) } },
    [A.ausd.toLowerCase()]: {
      abi: IAUSDAbi,
      fns: { balanceOf: () => w.ausdBalance, allowance: () => w.ausdAllowance, approve: write(true) },
    },
    [A.account.toLowerCase()]: {
      abi: IGaplessAccountAbi,
      fns: {
        owner: () => w.owner,
        operator: () => w.operator,
        operatorUsage: () => w.usage,
        opNonce: () => w.opNonce,
        perplAccountId: () => w.perplAccountId,
        eip712Domain: () => ["0x0f", "GaplessAccount", "1", BigInt(w.chainId), A.account, zeroHash, []],
        tradeAndCover: ([, , maxPremium]) => {
          if (maxPremium === 0n) throw new Revert(ICoverManagerAbi, "PremiumTooHigh", [w.probeNeed, 0n]);
          if (w.writeRevert) throw w.writeRevert;
          return COVER_ID;
        },
        buyCover: write(COVER_ID),
        cancelCover: write(undefined),
        setOperatorWithSig: write(undefined),
      },
    },
  };
}

export type RpcCall = { method: string; params: unknown[] };

function rpcRevert(r: Revert): Error {
  const err = new Error("execution reverted") as Error & { code: number; data: Hex };
  err.code = 3;
  err.data = encodeErrorResult({ abi: r.abi, errorName: r.errorName, args: r.args as never });
  return err;
}

function ethCall(w: World, tx: { to?: Address; from?: Address; data?: Hex }): Hex {
  const c = contracts(w)[(tx.to ?? "").toLowerCase()];
  if (!c || !tx.data) throw new Error(`fake: no contract at ${tx.to}`);
  const { functionName, args } = decodeFunctionData({ abi: c.abi, data: tx.data });
  const fn = c.fns[functionName];
  if (!fn) throw new Error(`fake: ${functionName} not modeled`);
  try {
    const out = fn(args ?? [], tx.from, w);
    return encodeFunctionResult({ abi: c.abi, functionName, result: out as never });
  } catch (e) {
    if (e instanceof Revert) throw rpcRevert(e);
    throw e;
  }
}

export function makeLog(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>) {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName);
  if (!ev || ev.type !== "event") throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name ?? ""]) as never);
  return { address, topics, data };
}

export function fakeChain(w: World) {
  const calls: RpcCall[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    const p = (params ?? []) as unknown[];
    calls.push({ method, params: p });
    switch (method) {
      case "eth_chainId":
        return toHex(w.chainId);
      case "eth_blockNumber":
        return toHex(w.blockNumber);
      case "eth_getBlockByNumber":
        return {
          number: toHex(w.blockNumber), hash: keccak256(toHex(w.blockNumber)), parentHash: zeroHash, timestamp: toHex(w.timestamp),
          nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1", gasUsed: "0x0", miner: zeroAddress, extraData: "0x",
          logsBloom: `0x${"0".repeat(512)}`, transactionsRoot: zeroHash, stateRoot: zeroHash, receiptsRoot: zeroHash,
          sha3Uncles: zeroHash, size: "0x1", totalDifficulty: "0x0", transactions: [], uncles: [], baseFeePerGas: "0x1",
        };
      case "eth_call":
        return ethCall(w, p[0] as { to: Address; from?: Address; data: Hex });
      case "eth_estimateGas": {
        ethCall(w, p[0] as { to: Address; from?: Address; data: Hex });
        return toHex(w.gasEstimate);
      }
      case "eth_getTransactionReceipt":
        return {
          blockHash: zeroHash, blockNumber: toHex(w.blockNumber), contractAddress: null, cumulativeGasUsed: "0x1",
          effectiveGasPrice: "0x1", from: A.agent, gasUsed: "0x1", logsBloom: `0x${"0".repeat(512)}`, status: w.receiptStatus,
          to: A.account, transactionHash: p[0], transactionIndex: "0x0", type: "0x2",
          logs: w.receiptLogs.map((l, i) => ({
            ...l, blockHash: zeroHash, blockNumber: toHex(w.blockNumber), transactionHash: p[0], transactionIndex: "0x0",
            logIndex: toHex(i), removed: false,
          })),
        };
      default:
        throw new Error(`fake: unexpected RPC ${method}`);
    }
  };
  // No retries: a reverting fake call surfaces as UnknownRpcError, which viem would otherwise retry with backoff.
  const client = createPublicClient({ transport: custom({ request }, { retryCount: 0 }), pollingInterval: 10 });
  return { client, calls };
}

export type ExecFn = (req: unknown, opts?: unknown) => Promise<unknown>;

export const SERVER_STATE = {
  selectedWallet: { mode: "server", namespace: "evm", ref: { id: "w1" } },
  remoteWallets: [{ id: "w1", address: A.agent, name: "agent" }],
  byokWallets: [],
};

export function fakeHost(w: World, opts: { state?: unknown; exec?: ExecFn } = {}) {
  const { client, calls } = fakeChain(w);
  const exec = vi.fn<ExecFn>(opts.exec ?? (async () => ({ kind: "transaction", hash: TX_HASH, status: "CONFIRMED" })));
  const walletExecutor = vi.fn(async (_io: CommandIO, _source: string) => exec);
  const publicClient = vi.fn((_chainId: number) => client);
  const host: Host = {
    publicClient: publicClient as unknown as Host["publicClient"],
    walletStateManager: { read: () => opts.state ?? SERVER_STATE },
    walletExecutor,
  };
  return { host, exec, walletExecutor, publicClient, calls };
}

export const io = {
  signal: new AbortController().signal,
  isInteractive: false,
  progress: () => {},
  log: () => {},
  emit: () => {},
  notify: () => {},
} as unknown as CommandIO;

/** eth_call payloads sent to `to` (simulations and reads). */
export function callsTo(calls: RpcCall[], to: Address, method = "eth_call"): Hex[] {
  return calls
    .filter((c) => c.method === method && (c.params[0] as { to?: string })?.to?.toLowerCase() === to.toLowerCase())
    .map((c) => (c.params[0] as { data: Hex }).data);
}
