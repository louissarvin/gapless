import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult, toEventSelector, numberToHex, type Address, type Hex } from 'viem';
import { ICoverManagerAbi, IGaplessAccountAbi, IGaplessFactoryAbi, IPerplMinAbi, IAUSDAbi } from '../src/abi/index.ts';
import { PERPL_EVENTS_ABI } from '../src/jobs/perpl.ts';
import { SPEC_DEFAULT_PARAMS } from '../src/jobs/config.ts';
import { AUSD, PERPL_EXCHANGE } from '../src/lib/addresses.ts';
import { CREATE_ACCOUNT_TYPEHASH } from '../src/relay/sponsor/eip712.ts';
import type { CallHandler, EthCall, FakeChain } from './fakeChain.ts';

export const MANAGER: Address = '0x00000000000000000000000000000000000c0de1';
export const FACTORY: Address = '0x00000000000000000000000000000000000fac70';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

export const coverId = (n: number) => numberToHex(n, { size: 32 });

export interface FakeCover {
  status: number;
  isLong: boolean;
  stopPNS: number;
  armer: Address;
  armedBlock: number;
  lots: number;
  filledLots?: number;
  expiryBlock?: number;
  maxGapBps?: number;
  triggerBlock?: number;
  refTrigPNS?: number;
  capCNS?: number;
  paidCNS?: number;
  /** Deferred payout still owed (M-4). */
  owedCNS?: number;
  /** Purchase-time snapshots (C4 L-03); default to the market defaults. */
  slipAllowanceBps?: number;
  floorSlackBps?: number;
  /** Last short attempt with R through the stop (C5 N-01); 0 = none. */
  shortBlock?: number;
  /** Chain length behind shortBlock (C5 N-01). */
  shortSteps?: number;
  startBlock?: number;
  /** Purchase-time snapshots (C5 L-03, N-02); default to the market defaults. */
  warmupBlocks?: number;
  windowBlocks?: number;
  minDistanceBps?: number;
}

/** 'revert_raw' reverts with empty data (out of gas or a Perpl revert without a reason). */
type Result<T> = T | 'revert' | 'revert_raw';

/** CoverManager surface the keeper reads and calls, dispatched by selector. */
export class FakeManager {
  /** marketParams overrides on the contract defaults; the canary lists with maxMatchesClose 8 (SA4-01). */
  params: Partial<typeof SPEC_DEFAULT_PARAMS> = { maxMatchesClose: 8 };
  watch = new Map<number, { toArm: Hex[]; toTrigger: Hex[] }>();
  hk = new Map<number, { toObserve: Hex[]; toFinalize: Hex[]; toExpire: Hex[]; toVoid: Hex[] }>();
  covers = new Map<Hex, FakeCover>();
  trigger = new Map<Hex, Result<bigint>>();
  /** A trigger simulated below this gas reverts with empty data (out of gas). */
  triggerMinGas = 0n;
  arm = new Map<Hex, Result<boolean>>();
  observe = new Map<Hex, Result<boolean>>();
  /** finalize() return (topUpCNS); default 0. */
  finalize = new Map<Hex, Result<bigint>>();
  sigma = { e2: 27, postedBlock: 0n };
  live = 0n;
  /** Perpl getPerpetualInfo book fields. */
  book = { basePricePNS: 0n, maxBidPriceONS: 0n, minAskPriceONS: 0n };
  markPNS = 0n;
  markTimestamp = 0n;
  /** Perpl perp status (4 = active) and exchange halt. */
  perpStatus = 4;
  halted = false;
  /** Global buy pause and per-market pause (C4 I-02). */
  paused = false;
  marketPaused = new Set<number>();
  /** referencePrice(perpId, isLong, minTs). */
  ref = { refPNS: 0n, nFresh: 0 };
  readonly calls: string[] = [];

  install(chain: FakeChain): void {
    chain.handlers.push(this.handler);
  }

  readonly handler: CallHandler = (c: EthCall) => {
    if (c.to.toLowerCase() === MANAGER.toLowerCase()) return this.manager(c);
    if (c.to.toLowerCase() === PERPL_EXCHANGE.toLowerCase()) return this.exchange(c);
    return undefined;
  };

  private revert(): { revert: Hex } {
    return { revert: encodeErrorResult({ abi: ICoverManagerAbi, errorName: 'ConditionNotMet' }) };
  }

  private manager(c: EthCall): Hex | { revert: Hex } {
    const { functionName, args } = decodeFunctionData({ abi: ICoverManagerAbi, data: c.data });
    this.calls.push(functionName);
    const enc = (result: unknown) => encodeFunctionResult({ abi: ICoverManagerAbi, functionName, result } as never);
    const id = args?.[0] as Hex;
    switch (functionName) {
      case 'marketParams':
        return enc(paramsStruct(this.params));
      case 'watchList': {
        const w = this.watch.get(Number(args![0])) ?? { toArm: [], toTrigger: [] };
        return enc([w.toArm, w.toTrigger]);
      }
      case 'housekeeping': {
        const h = this.hk.get(Number(args![0])) ?? { toObserve: [], toFinalize: [], toExpire: [], toVoid: [] };
        return enc([h.toObserve, h.toFinalize, h.toExpire, h.toVoid]);
      }
      case 'getCover': {
        const cv = this.covers.get(id);
        return cv ? enc(coverStruct(cv)) : this.revert();
      }
      case 'trigger': {
        if (c.gas !== undefined && c.gas < this.triggerMinGas) return { revert: '0x' };
        const r = this.trigger.get(id) ?? 'revert';
        if (r === 'revert_raw') return { revert: '0x' };
        return r === 'revert' ? this.revert() : enc(r);
      }
      case 'arm': {
        const r = this.arm.get(id) ?? 'revert';
        return r === 'revert' || r === 'revert_raw' ? this.revert() : enc(r);
      }
      case 'observe': {
        const r = this.observe.get(id) ?? 'revert';
        return r === 'revert' || r === 'revert_raw' ? this.revert() : enc(r);
      }
      case 'finalize': {
        const r = this.finalize.get(id) ?? 0n;
        return r === 'revert' || r === 'revert_raw' ? this.revert() : enc(r);
      }
      case 'referencePrice':
        return enc([this.ref.refPNS, this.ref.nFresh]);
      case 'expire':
      case 'voidCover':
      case 'postSigma':
        return '0x';
      case 'sigmaOf':
        return enc([this.sigma.e2, Number(this.sigma.postedBlock)]);
      case 'liveCount':
        return enc(this.live);
      case 'paused':
        return enc(this.paused);
      case 'marketPaused':
        return enc(this.marketPaused.has(Number(args![0])));
      default:
        throw new Error(`FakeManager: unhandled ${functionName}`);
    }
  }

  private exchange(c: EthCall): Hex | { revert: Hex } | undefined {
    const { functionName } = decodeFunctionData({ abi: IPerplMinAbi, data: c.data });
    this.calls.push(`perpl.${functionName}`);
    if (functionName === 'isHalted') return encodeFunctionResult({ abi: IPerplMinAbi, functionName, result: this.halted });
    if (functionName !== 'getPerpetualInfo') return undefined;
    const info = { ...perpInfo(this.book, this.markPNS), markTimestamp: this.markTimestamp, status: this.perpStatus };
    return encodeFunctionResult({ abi: IPerplMinAbi, functionName, result: info } as never);
  }
}

/** Receipt log for a CoverManager event (`Triggered`, `Disarmed`, `Finalized`, ...). */
export function managerLog(eventName: string, args: Record<string, unknown>, data: Hex = '0x'): Record<string, unknown> {
  const topics = encodeEventTopics({ abi: ICoverManagerAbi, eventName, args } as never);
  return { address: MANAGER, topics, data, blockHash: `0x${'00'.repeat(32)}`, blockNumber: '0x1', logIndex: '0x0', removed: false, transactionHash: `0x${'00'.repeat(32)}`, transactionIndex: '0x0' };
}

/** Triggered log with its data, so the keeper can tell a full fill from a partial one. */
export function triggeredLog(coverId: Hex, filledLots: bigint, paidNowCNS = 0n): Record<string, unknown> {
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [0n, filledLots, 0n, 0n, 0n, paidNowCNS, 0n]
  );
  return managerLog('Triggered', { coverId, perpId: 1n }, data);
}

export function paramsStruct(over: Partial<typeof SPEC_DEFAULT_PARAMS> = {}) {
  const p = { ...SPEC_DEFAULT_PARAMS, ...over };
  return { ...p, minFeeCNS: BigInt(p.minFeeCNS), maxCoverNotionalCNS: BigInt(p.maxCoverNotionalCNS), zEdgesE2: [...p.zEdgesE2], gapBpsE2: [...p.gapBpsE2] };
}

function coverStruct(c: FakeCover) {
  return {
    account: '0x00000000000000000000000000000000000acc01' as Address,
    perpId: 1,
    status: c.status,
    isLong: c.isLong,
    maxGapBps: c.maxGapBps ?? 200,
    observed: false,
    lots: BigInt(c.lots),
    filledLots: BigInt(c.filledLots ?? 0),
    stopPNS: c.stopPNS,
    startBlock: BigInt(c.startBlock ?? 0),
    expiryBlock: BigInt(c.expiryBlock ?? 10_000_000),
    armedBlock: BigInt(c.armedBlock),
    capCNS: BigInt(c.capCNS ?? 0),
    escrowCNS: 0n,
    rentCNS: 0n,
    triggerBlock: BigInt(c.triggerBlock ?? 0),
    triggerTs: 0n,
    refTrigPNS: c.refTrigPNS ?? 0,
    refPostPNS: 0,
    paidCNS: BigInt(c.paidCNS ?? 0),
    armer: c.armer,
    owedCNS: BigInt(c.owedCNS ?? 0),
    gRealCumCNS: 0n,
    slipAllowanceBps: c.slipAllowanceBps ?? SPEC_DEFAULT_PARAMS.slipAllowanceBps,
    floorSlackBps: c.floorSlackBps ?? SPEC_DEFAULT_PARAMS.floorSlackBps,
    shortBlock: BigInt(c.shortBlock ?? 0),
    shortSteps: c.shortSteps ?? (c.shortBlock ? 1 : 0),
    minDistanceBps: c.minDistanceBps ?? 11,
    warmupBlocks: c.warmupBlocks ?? SPEC_DEFAULT_PARAMS.warmupBlocks,
    windowBlocks: c.windowBlocks ?? SPEC_DEFAULT_PARAMS.windowBlocks
  };
}

function perpInfo(book: FakeManager['book'], markPNS = 0n) {
  return {
    name: 'BTC Perp', symbol: 'BTC', priceDecimals: 1n, lotDecimals: 5n, linkFeedId: `0x${'00'.repeat(32)}` as Hex,
    priceTolPer100K: 0n, marginTol: 0n, marginTolDecimals: 0n, refPriceMaxAgeSec: 0n, positionBalanceCNS: 0n,
    insuranceBalanceCNS: 0n, markPNS, markTimestamp: 0n, lastPNS: 0n, lastTimestamp: 0n, oraclePNS: 0n,
    oracleTimestampSec: 0n, longOpenInterestLNS: 0n, shortOpenInterestLNS: 0n, fundingStartBlock: 0n,
    fundingRatePct100k: 0, absFundingClampPctPer100K: 0n, status: 4, basePricePNS: book.basePricePNS,
    maxBidPriceONS: book.maxBidPriceONS, minBidPriceONS: 0n, maxAskPriceONS: 0n, minAskPriceONS: book.minAskPriceONS,
    numOrders: 0n, ignOracle: false
  };
}

const MARK_UPDATED_TOPIC = toEventSelector(PERPL_EVENTS_ABI.find((e) => e.name === 'MarkUpdated')!);

/** RPC log for Perpl MarkUpdated(perpId, pricePNS) (no indexed params). */
export function markLog(block: bigint, logIndex: number, perpId: number, price: number): Record<string, unknown> {
  return {
    address: PERPL_EXCHANGE,
    blockHash: numberToHex(block, { size: 32 }),
    blockNumber: numberToHex(block),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(perpId), BigInt(price)]),
    logIndex: numberToHex(logIndex),
    removed: false,
    topics: [MARK_UPDATED_TOPIC],
    transactionHash: numberToHex(block * 1000n + BigInt(logIndex), { size: 32 }),
    transactionIndex: '0x0'
  };
}

/** Factory, account, AUSD and Perpl account reads for the relay sponsor and activate routes. */
export class FakeOnboarding {
  accounts = new Map<string, Address>(); // owner -> predicted clone
  deployed = new Set<string>();
  perplAccountId = new Map<string, bigint>();
  walletAusd = new Map<string, bigint>();
  perplBalance = new Map<bigint, bigint>();
  operator = new Map<string, { key: Address; expiry: bigint; maxNotionalPerTradeCNS: bigint; maxNotionalPerDayCNS: bigint }>();
  /** account -> owner (GaplessAccount.owner()). */
  owners = new Map<string, Address>();
  /** `${perpId}:${perplAccountId}` -> open lots (Perpl getPosition). */
  positions = new Map<string, bigint>();
  createReverts = false;
  minOpen = 10_000_000n;
  domain = { fields: '0x0f' as Hex, name: 'GaplessFactory', version: '1', chainId: 143n, typehash: CREATE_ACCOUNT_TYPEHASH, extensions: [] as bigint[] };
  readonly calls: string[] = [];

  install(chain: FakeChain): void {
    chain.handlers.push(this.handler);
  }

  readonly handler: CallHandler = (c: EthCall) => {
    const to = c.to.toLowerCase();
    if (to === FACTORY.toLowerCase()) return this.factory(c);
    if (to === AUSD.toLowerCase()) return this.ausd(c);
    if (to === PERPL_EXCHANGE.toLowerCase()) return this.perpl(c);
    if ([...this.deployed].includes(to)) return this.account(c);
    return undefined;
  };

  private factory(c: EthCall): Hex | { revert: Hex } {
    const { functionName, args } = decodeFunctionData({ abi: IGaplessFactoryAbi, data: c.data });
    this.calls.push(`factory.${functionName}`);
    const enc = (result: unknown) => encodeFunctionResult({ abi: IGaplessFactoryAbi, functionName, result } as never);
    switch (functionName) {
      case 'accountOf':
        return enc(this.accounts.get(String(args![0]).toLowerCase()) ?? ZERO);
      case 'isAccount':
        return enc(this.deployed.has(String(args![0]).toLowerCase()));
      case 'eip712Domain':
        return enc([this.domain.fields, this.domain.name, this.domain.version, this.domain.chainId, FACTORY, `0x${'00'.repeat(32)}`, this.domain.extensions]);
      case 'CREATE_ACCOUNT_TYPEHASH':
        return enc(this.domain.typehash);
      case 'createAccountFor': {
        if (this.createReverts) return { revert: encodeErrorResult({ abi: IGaplessFactoryAbi, errorName: 'BadSig' }) };
        const owner = String(args![0]).toLowerCase();
        return enc(this.accounts.get(owner) ?? ZERO);
      }
      default:
        throw new Error(`FakeOnboarding: unhandled factory.${functionName}`);
    }
  }

  private account(c: EthCall): Hex {
    const { functionName } = decodeFunctionData({ abi: IGaplessAccountAbi, data: c.data });
    this.calls.push(`account.${functionName}`);
    const to = c.to.toLowerCase();
    const enc = (result: unknown) => encodeFunctionResult({ abi: IGaplessAccountAbi, functionName, result } as never);
    switch (functionName) {
      case 'perplAccountId':
        return enc(this.perplAccountId.get(to) ?? 0n);
      case 'operator':
        return enc(this.operator.get(to) ?? { key: ZERO, expiry: 0n, maxNotionalPerTradeCNS: 0n, maxNotionalPerDayCNS: 0n });
      case 'owner':
        return enc(this.owners.get(to) ?? ZERO);
      case 'sweep':
        return '0x';
      default:
        throw new Error(`FakeOnboarding: unhandled account.${functionName}`);
    }
  }

  private ausd(c: EthCall): Hex {
    const { functionName, args } = decodeFunctionData({ abi: IAUSDAbi, data: c.data });
    this.calls.push(`ausd.${functionName}`);
    if (functionName !== 'balanceOf') throw new Error(`FakeOnboarding: unhandled ausd.${functionName}`);
    return encodeFunctionResult({ abi: IAUSDAbi, functionName, result: this.walletAusd.get(String(args![0]).toLowerCase()) ?? 0n });
  }

  private perpl(c: EthCall): Hex | undefined {
    const { functionName, args } = decodeFunctionData({ abi: IPerplMinAbi, data: c.data });
    this.calls.push(`perpl.${functionName}`);
    const enc = (result: unknown) => encodeFunctionResult({ abi: IPerplMinAbi, functionName, result } as never);
    switch (functionName) {
      case 'getMinAccountOpenCNS':
        return enc(this.minOpen);
      case 'getAccountById': {
        const id = args![0] as bigint;
        return enc({
          accountId: id,
          balanceCNS: this.perplBalance.get(id) ?? 0n,
          lockedBalanceCNS: 0n,
          frozen: 0,
          accountAddr: ZERO,
          positions: { bank1: 0n, bank2: 0n, bank3: 0n, bank4: 0n }
        });
      }
      case 'getPosition': {
        const [perpId, accountId] = args as readonly [bigint, bigint];
        const lots = this.positions.get(`${perpId}:${accountId}`) ?? 0n;
        const pos = {
          accountId, nextNodeId: 0n, prevNodeId: 0n, positionType: 0, depositCNS: 0n, pricePNS: 0n,
          lotLNS: lots, entryBlock: 0n, pnlCNS: 0n, deltaPnlCNS: 0n, premiumPnlCNS: 0n
        };
        return enc([pos, 0n, false]);
      }
      default:
        return undefined;
    }
  }
}
