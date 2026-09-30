import { decodeEventLog, type Address, type Hex } from 'viem';
import { ICoverManagerAbi } from '../abi/index.ts';
import type { ReceiptLog } from '../lib/sendQueue.ts';

/** CoverStatus (GaplessTypes.sol). */
export const COVER_STATUS = { None: 0, Live: 1, Armed: 2, Triggered: 3 } as const;

export type ActionKind = 'trigger' | 'arm' | 'observe' | 'finalize' | 'expire' | 'voidCover';

export interface PlannedAction {
  kind: ActionKind;
  coverId: Hex;
  perpId: number;
  dedupeKey: string;
}

/** One perp's watchList and housekeeping reads at the current head. */
export interface PerpWatch {
  perpId: number;
  toArm: readonly Hex[];
  toTrigger: readonly Hex[];
  toObserve: readonly Hex[];
  toFinalize: readonly Hex[];
  toExpire: readonly Hex[];
  toVoid: readonly Hex[];
  exclusiveBlocks: number;
}

export interface CoverView {
  status: number;
  armer: Address;
  armedBlock: bigint;
  expiryBlock: bigint;
  filledLots: bigint;
  shortBlock: bigint;
  /** Triggered covers: remainder and observe close at triggerBlock + windowBlocks. */
  triggerBlock?: bigint;
  windowBlocks?: number;
}

export interface SelectInput {
  head: bigint;
  keeper: Address;
  perps: readonly PerpWatch[];
  /** getCover for every toTrigger, toArm and toObserve id; a missing trigger or observe entry is left to the simulation, a missing arm is skipped. */
  covers: ReadonlyMap<Hex, CoverView>;
  /** Covers whose fast path holds (fresh mark at or through the stop): open to anyone (L-02). */
  fast?: ReadonlySet<Hex>;
  inflight: (key: string) => boolean;
  /** Spec §4.1: finalize, expire and void are capped per block. */
  maxLowPriority: number;
}

export const MAX_LOW_PRIORITY_PER_BLOCK = 4;

export const actionKey = (kind: ActionKind, coverId: Hex) => `${kind}:${coverId}`;

/**
 * Trigger dedupe keyed by close progress: a remainder fill or a short close changes it, so the follow-up
 * call (remainder or widened floor) goes at the next head instead of waiting out the inflight window.
 */
export function triggerDedupeKey(coverId: Hex, c?: Pick<CoverView, 'filledLots' | 'shortBlock'>): string {
  return c ? `trigger:${coverId}:${c.filledLots}:${c.shortBlock}` : actionKey('trigger', coverId);
}

/** True when the armer-only window binds: it applies only if it ends before expiryBlock (L-02). */
export function inExclusiveWindow(c: CoverView, head: bigint, keeper: Address, exclusiveBlocks: number): boolean {
  if (c.status !== COVER_STATUS.Armed || c.armer.toLowerCase() === keeper.toLowerCase()) return false;
  const end = c.armedBlock + BigInt(exclusiveBlocks);
  // Our tx lands at head + 1 at the earliest; the contract blocks others while block <= end.
  return end < c.expiryBlock && head + 1n <= end;
}

/** Open to us when we armed it, the window passed or never applied, or the fast path holds (anyone, L-02). */
export function triggerAllowed(c: CoverView | undefined, head: bigint, keeper: Address, exclusiveBlocks: number, fast = false): boolean {
  return !c || fast || !inExclusiveWindow(c, head, keeper, exclusiveBlocks);
}

/** A send can land a block after head + 1, so an arm must clear the expiry block by that much (SA3-01). */
export const ARM_EXPIRY_MARGIN_BLOCKS = 2n;

/**
 * SA3-01: an arm landing at or after expiryBlock can never be followed by a trigger, yet it sets armedBlock, which
 * forfeits the escrow at expiry (C5 N-02). Without a cover read the arm is skipped: the fast path needs no arm.
 */
export function armAllowed(c: Pick<CoverView, 'expiryBlock'> | undefined, head: bigint): boolean {
  return c !== undefined && head + ARM_EXPIRY_MARGIN_BLOCKS < c.expiryBlock;
}

/**
 * SE2-L1: eth_call runs at head, the tx lands at head + 1 at the earliest. A trigger landing after expiryBlock
 * reverts CoverExpired; a remainder or observe landing after triggerBlock + windowBlocks reverts ConditionNotMet.
 */
export function landsInTime(c: CoverView | undefined, landing: bigint): boolean {
  if (!c) return true;
  if (c.status === COVER_STATUS.Triggered) {
    return c.triggerBlock === undefined || c.windowBlocks === undefined || landing <= c.triggerBlock + BigInt(c.windowBlocks);
  }
  return landing <= c.expiryBlock;
}

/** Spec §4.1 order: trigger, arm, observe, then at most `maxLowPriority` of finalize, expire, void (rotating). */
export function selectActions(input: SelectInput): PlannedAction[] {
  const out: PlannedAction[] = [];
  const seen = new Set<string>();
  const push = (kind: ActionKind, coverId: Hex, perpId: number, dedupeKey = actionKey(kind, coverId)) => {
    if (seen.has(dedupeKey) || input.inflight(dedupeKey)) return false;
    seen.add(dedupeKey);
    out.push({ kind, coverId, perpId, dedupeKey });
    return true;
  };

  for (const p of input.perps) {
    for (const id of p.toTrigger) {
      const c = input.covers.get(id);
      if (!landsInTime(c, input.head + 1n)) continue;
      if (triggerAllowed(c, input.head, input.keeper, p.exclusiveBlocks, input.fast?.has(id) ?? false)) {
        push('trigger', id, p.perpId, triggerDedupeKey(id, c));
      }
    }
  }
  for (const p of input.perps) for (const id of p.toArm) if (armAllowed(input.covers.get(id), input.head)) push('arm', id, p.perpId);
  for (const p of input.perps) for (const id of p.toObserve) if (landsInTime(input.covers.get(id), input.head + 1n)) push('observe', id, p.perpId);

  // Low priority slots rotate across kinds, so a backlog of finalizes never starves expire (SA2 go-condition 3).
  const queues = (['finalize', 'expire', 'voidCover'] as const).map((kind) => ({
    kind,
    items: input.perps.flatMap((p) => (kind === 'finalize' ? p.toFinalize : kind === 'expire' ? p.toExpire : p.toVoid).map((id) => ({ id, perpId: p.perpId })))
  }));
  let low = 0;
  for (let progressed = true; progressed && low < input.maxLowPriority; ) {
    progressed = false;
    for (const q of queues) {
      while (q.items.length > 0 && low < input.maxLowPriority) {
        const next = q.items.shift()!;
        if (push(q.kind, next.id, next.perpId)) {
          low++;
          progressed = true;
          break;
        }
      }
    }
  }
  return out;
}

/** Perpl book side is empty when its ONS is 0 (measured) or max uint (defensive), INTERFACES C1. */
const MAX_UINT = (1n << 256n) - 1n;
const BPS = 10_000n;
/** Perpl limit price range (Constants.PERPL_MIN_PRICE_PNS / PERPL_MAX_PRICE_PNS, mainnet PriceOutOfRange). */
export const PERPL_MIN_PRICE_PNS = 1n;
export const PERPL_MAX_PRICE_PNS = 16_777_215n;
/** Constants.PERP_STATUS_ACTIVE and REF_TS_TOLERANCE_SEC. */
const PERP_STATUS_ACTIVE = 4;
const REF_TS_TOLERANCE_SEC = 2n;

export interface PerpBook {
  bestBidPNS: bigint | null;
  bestAskPNS: bigint | null;
}

export function bookFromPerpInfo(info: { basePricePNS: bigint; maxBidPriceONS: bigint; minAskPriceONS: bigint }): PerpBook {
  const side = (ons: bigint) => (ons === 0n || ons === MAX_UINT ? null : info.basePricePNS + ons);
  return { bestBidPNS: side(info.maxBidPriceONS), bestAskPNS: side(info.minAskPriceONS) };
}

export interface MarkInfo {
  markPNS: bigint;
  markTimestamp: bigint;
  status: number;
}

/** CoverManager._venueOk. */
export function venueOk(info: { status: number }, halted: boolean): boolean {
  return info.status === PERP_STATUS_ACTIVE && !halted;
}

/** CoverManager._fastPath for a cover past warm-up: venue up and a fresh mark at or through the stop. */
export function fastPath(c: { isLong: boolean; stopPNS: bigint }, info: MarkInfo, halted: boolean, refFreshSec: number, nowSec: bigint): boolean {
  const m = info.markPNS;
  if (!venueOk(info, halted) || m === 0n || info.markTimestamp + BigInt(refFreshSec) + REF_TS_TOLERANCE_SEC < nowSec) return false;
  return c.isLong ? m <= c.stopPNS : m >= c.stopPNS;
}

/** CoverManager._fastPath also needs the cover's own warm-up (L-03 snapshot) to have passed. */
export function pastWarmup(c: { startBlock: bigint; warmupBlocks: number }, landing: bigint): boolean {
  return landing >= c.startBlock + BigInt(c.warmupBlocks);
}

/** CoverManager._through: R at or through the stop; R = 0 never is. */
export function through(c: { isLong: boolean; stopPNS: bigint }, ref: bigint): boolean {
  if (ref === 0n) return false;
  return c.isLong ? ref <= c.stopPNS : ref >= c.stopPNS;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Constants.STEP_MAX_GAP_BLOCKS (C7, was SHORT_CHAIN_MAX_GAP_BLOCKS 3): most blocks between consecutive attempts of
 * one touch, measured from the most recent attempt (a match-limited partial fill refreshes it and keeps its step).
 */
export const STEP_MAX_GAP_BLOCKS = 10n;
/** Constants.CLOSE_FLOOR_MAX_STEPS (C5 N-01). */
export const CLOSE_FLOOR_MAX_STEPS = 6;
/** No-fill attempts the keeper spends per touch (CANARY_PARAMS: A 5, slack 100 reaches floorSlack at step 5). */
export const MAX_NO_FILL_STEPS_PER_TOUCH = 5;

/** Per-cover close terms; A and floorSlack are the purchase-time snapshot (L-03), never market params. */
export interface CloseTerms {
  isLong: boolean;
  stopPNS: bigint;
  maxGapBps: number;
  slipAllowanceBps: number;
  floorSlackBps: number;
}

/** Cover.shortBlock and shortSteps: the block of the touch's most recent attempt (C7) and the step a later block runs at. */
export interface ShortChain {
  shortBlock: bigint;
  shortSteps: number;
}

/** CoverManager._allowanceBps: min(floorSlack, A x 2^k). */
export function allowanceBps(c: Pick<CloseTerms, 'slipAllowanceBps' | 'floorSlackBps'>, k: number): number {
  return Math.min(c.floorSlackBps, c.slipAllowanceBps * 2 ** k);
}

/**
 * CoverManager._step for a tx landing in `landing`: the chain continues only while R is through the stop and the
 * touch's most recent attempt is at most STEP_MAX_GAP_BLOCKS back. Same-block (C5 encoding) is shortSteps - 1; the
 * keeper never targets it, since it always lands after the block it read.
 */
export function closeStep(chain: ShortChain, through: boolean, landing: bigint): number {
  if (!through || chain.shortBlock === 0n || landing - chain.shortBlock > STEP_MAX_GAP_BLOCKS) return 0;
  return landing === chain.shortBlock ? Math.max(chain.shortSteps - 1, 0) : chain.shortSteps;
}

/** Widest step worth walking to: the first step at floorSlack, capped by the per-touch no-fill budget. */
export function lastWalkStep(c: Pick<CloseTerms, 'slipAllowanceBps' | 'floorSlackBps'>): number {
  let k = 1;
  while (k < CLOSE_FLOOR_MAX_STEPS && allowanceBps(c, k) < c.floorSlackBps) k++;
  return Math.min(k, MAX_NO_FILL_STEPS_PER_TOUCH);
}

/**
 * CoverManager._closeLimit: step 0 is R x (1 -/+ A); step k >= 1 is min(stop, R) x (1 -/+ min(floorSlack, A x 2^k));
 * R = 0 keeps the D49 floor from stop and maxGap at floorSlack. Clamped to Perpl's price range (L-06).
 */
export function closeLimitPNS(c: CloseTerms, ref: bigint, k: number): bigint {
  let limit: bigint;
  if (ref === 0n || k > 0) {
    const allow = BigInt(ref === 0n ? c.floorSlackBps : allowanceBps(c, k));
    const gap = BigInt(c.maxGapBps);
    if (c.isLong) {
      const base = ref > 0n ? (ref < c.stopPNS ? ref : c.stopPNS) : (c.stopPNS * (BPS - gap)) / BPS;
      limit = (base * (BPS - allow)) / BPS;
    } else {
      const base = ref > 0n ? (ref > c.stopPNS ? ref : c.stopPNS) : ceilDiv(c.stopPNS * (BPS + gap), BPS);
      limit = ceilDiv(base * (BPS + allow), BPS);
    }
  } else {
    const a = BigInt(c.slipAllowanceBps);
    limit = c.isLong ? (ref * (BPS - a)) / BPS : ceilDiv(ref * (BPS + a), BPS);
  }
  return limit < PERPL_MIN_PRICE_PNS ? PERPL_MIN_PRICE_PNS : limit > PERPL_MAX_PRICE_PNS ? PERPL_MAX_PRICE_PNS : limit;
}

/**
 * A close that fills starts at the best opposing level; below the stop (long) that fill adds gReal > 0, so the
 * attempt pays (or owes, past the per-block cap). Used to book the walk's final close on the hot path (SE2-M1).
 */
export function closePays(c: { isLong: boolean; stopPNS: bigint }, book: PerpBook): boolean {
  if (c.isLong) return book.bestBidPNS !== null && book.bestBidPNS < c.stopPNS;
  return book.bestAskPNS !== null && book.bestAskPNS > c.stopPNS;
}

/** The IOC fills at least one lot when the best opposing level is at or inside the limit. */
export function fillsAt(c: { isLong: boolean }, book: PerpBook, limitPNS: bigint): boolean {
  if (c.isLong) return book.bestBidPNS !== null && book.bestBidPNS >= limitPNS;
  return book.bestAskPNS !== null && book.bestAskPNS <= limitPNS;
}

export interface RefRead {
  refPNS: bigint;
  /** Fresh sources behind refPNS; 0 means no fresh reference (the contract then skips the tolerance check). */
  nFresh: number;
}

/**
 * CoverManager.trigger re-check for an Armed cover: book still crossed at the stop (an empty closing side
 * counts) and, with a fresh reference, the reference within refTolBps. False means the trigger only disarms.
 */
export function stillArmed(c: { isLong: boolean; stopPNS: bigint }, book: PerpBook, ref: RefRead, refTolBps: number): boolean {
  const crossed = c.isLong
    ? book.bestBidPNS === null || book.bestBidPNS <= c.stopPNS
    : book.bestAskPNS === null || book.bestAskPNS >= c.stopPNS;
  if (!crossed) return false;
  if (ref.nFresh === 0) return true;
  const tol = BigInt(refTolBps);
  // _refWithinTol: long R <= floor(stop x (1e4 + tol) / 1e4), short R >= ceil(stop x (1e4 - tol) / 1e4).
  if (c.isLong) return ref.refPNS <= (c.stopPNS * (BPS + tol)) / BPS;
  return ref.refPNS >= ceilDiv(c.stopPNS * (BPS - tol), BPS);
}

export interface TriggerCover extends CloseTerms, ShortChain {
  status: number;
  armedBlock: bigint;
  /** Stored at the first fill; remainder closes use it, not the live reference. */
  refTrigPNS: bigint;
}

export interface ZeroPaidInput {
  cover: TriggerCover;
  book: PerpBook;
  /** fastPath() (and pastWarmup) at this head. */
  fast: boolean;
  /** venueOk() at this head. */
  venueOk: boolean;
  ref: RefRead;
  params: { refTolBps: number; armTtlBlocks: number };
  /** Block the tx lands in at the earliest (after head and after the last short attempt we read). */
  landing: bigint;
}

/**
 * closes: fills at the step the contract will use. step: no fill now, but R is through the stop, so the attempt
 * extends the chain toward a wider step the current book fills (N-01). disarm_only: the re-check fails.
 */
export type ZeroPaidVerdict = 'closes' | 'step' | 'disarm_only' | 'no_fill';

export interface ZeroPaidDecision {
  verdict: ZeroPaidVerdict;
  /** Step the attempt runs at (0 = tight R x (1 - A)). */
  step: number;
  limitPNS: bigint;
}

/** Earliest landing block: the next block, and never a block whose state (a short attempt) we already read. */
export function landingBlock(head: bigint, c: ShortChain): bigint {
  return c.shortBlock >= head + 1n ? c.shortBlock + 1n : head + 1n;
}

/**
 * Offchain mirror of CoverManager.trigger for a simulation that returned paidNow 0, which is also a disarm or
 * a no-fill. A no-fill step costs a call, so it is sent only when it moves the chain toward a step that fills.
 */
export function zeroPaidTriggerCloses(i: ZeroPaidInput): ZeroPaidDecision {
  const c = i.cover;
  const remainder = c.status === COVER_STATUS.Triggered;
  let chain: ShortChain = c;
  if (!remainder) {
    const lapsed = c.status === COVER_STATUS.Armed && i.landing > c.armedBlock + BigInt(i.params.armTtlBlocks);
    // Without the fast path only an effectively Armed cover that passes the re-check closes.
    if (!i.fast && (c.status !== COVER_STATUS.Armed || lapsed || !i.venueOk || !stillArmed(c, i.book, i.ref, i.params.refTolBps))) {
      return { verdict: 'disarm_only', step: 0, limitPNS: 0n };
    }
    // A lapsed arm disarms first, which clears the chain; the fast path then closes at step 0.
    if (lapsed) chain = { shortBlock: 0n, shortSteps: 0 };
  }
  const refNow = i.ref.nFresh > 0 ? i.ref.refPNS : 0n;
  // _close `through` (a remainder also needs R_trig through, _triggerRemainder).
  const thru = through(c, refNow) && (!remainder || through(c, c.refTrigPNS));
  const ref = remainder ? c.refTrigPNS : refNow;
  const step = closeStep(chain, thru, i.landing);
  const limitPNS = closeLimitPNS(c, ref, step);
  if (fillsAt(c, i.book, limitPNS)) return { verdict: 'closes', step, limitPNS };
  const last = lastWalkStep(c);
  if (thru && ref !== 0n && step < last && fillsAt(c, i.book, closeLimitPNS(c, ref, last))) return { verdict: 'step', step, limitPNS };
  return { verdict: 'no_fill', step, limitPNS };
}

/** Lots filled by Triggered events for one cover in a receipt; null when an event's data does not decode. */
export function coverFilledLots(logs: readonly ReceiptLog[], manager: Address, coverId: Hex): bigint | null {
  let total = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() !== manager.toLowerCase() || l.topics.length === 0) continue;
    try {
      const ev = decodeEventLog({ abi: ICoverManagerAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: false });
      if (ev.eventName !== 'Triggered') continue;
      const args = ev.args as { coverId?: Hex; filledLots?: bigint };
      if (args.coverId?.toLowerCase() !== coverId.toLowerCase()) continue;
      if (typeof args.filledLots !== 'bigint') return null;
      total += args.filledLots;
    } catch {
      // Not a manager event this ABI knows.
    }
  }
  return total;
}

/** Manager events in a receipt that concern one cover. */
export function coverEvents(logs: readonly ReceiptLog[], manager: Address, coverId: Hex): Set<string> {
  const names = new Set<string>();
  for (const l of logs) {
    if (l.address.toLowerCase() !== manager.toLowerCase() || l.topics.length === 0) continue;
    try {
      // coverId is indexed in every cover event; non-strict decoding only needs the topics.
      const ev = decodeEventLog({ abi: ICoverManagerAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: false });
      const args = ev.args as { coverId?: Hex };
      if (args.coverId?.toLowerCase() === coverId.toLowerCase()) names.add(ev.eventName);
    } catch {
      // Not a manager event this ABI knows.
    }
  }
  return names;
}

/** Per-key exponential backoff in blocks (no-op receipts, deferred payouts). */
export class BlockBackoff {
  private readonly m = new Map<string, { level: number; until: bigint }>();

  constructor(
    private readonly baseBlocks = 8n,
    private readonly maxBlocks = 600n
  ) {}

  blocked(key: string, head: bigint): boolean {
    const e = this.m.get(key);
    return e !== undefined && head < e.until;
  }

  /** Doubles the wait for `key`; returns the first block it may act again. */
  bump(key: string, head: bigint): bigint {
    const level = (this.m.get(key)?.level ?? 0) + 1;
    const span = this.baseBlocks << BigInt(Math.min(level - 1, 16));
    const until = head + (span < this.maxBlocks ? span : this.maxBlocks);
    this.m.set(key, { level, until });
    if (this.m.size > 4_096) for (const [k, v] of this.m) if (v.until < head) this.m.delete(k);
    return until;
  }

  clear(key: string): void {
    this.m.delete(key);
  }

  size(): number {
    return this.m.size;
  }
}
