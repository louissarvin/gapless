import type { MarketParams } from './config.ts';
import { minDistanceBps } from './premium.ts';
import type { OracleSeries, Prints, StepSeries } from './store.ts';

export type Side = 'long' | 'short';

export interface SimConfig {
  startStepBlocks: number;
  horizonsBlocks: readonly number[];
  /** Ascending. */
  distancesBps: readonly number[];
  execWindowBlocks: number;
  maxStartMarkAgeBlocks: number;
  fromBlock: number;
  /** Exclusive end of the data. */
  endBlock: number;
}

export interface StopSample {
  startBlock: number;
  side: Side;
  distanceBps: number;
  horizonBlocks: number;
  hit: boolean;
  triggerBlock: number | null;
  /** Stop vs the first mark at or through it (what a mark-triggered stop sees). >= 0. */
  markGapBps: number | null;
  /** Stop vs the worst maker print in (trigger, trigger + execWindow]; null when nothing traded. */
  printGapBps: number | null;
}

export interface SimStats {
  starts: number;
  skippedNoMark: number;
  skippedStaleMark: number;
}

const firstStart = (cfg: Pick<SimConfig, 'fromBlock' | 'startStepBlocks'>) =>
  Math.ceil(cfg.fromBlock / cfg.startStepBlocks) * cfg.startStepBlocks;

/** Index of the last element <= v in an ascending array, or -1. */
export function lastAtOrBefore(xs: readonly number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Native-stop analogue: stops at m0 -/+ d from block-aligned starts, triggered by the first later
 * mark at or through them. Starts whose horizon plus execution window pass the data are dropped.
 */
export function simulateStops(
  marks: Pick<StepSeries, 'block' | 'price'>,
  prints: Prints,
  cfg: SimConfig,
  visit: (s: StopSample) => void
): SimStats {
  const stats: SimStats = { starts: 0, skippedNoMark: 0, skippedStaleMark: 0 };
  const n = marks.block.length;
  if (n === 0) return stats;
  const D = cfg.distancesBps;
  const maxH = Math.max(...cfg.horizonsBlocks);
  const longCross = new Int32Array(D.length);
  const shortCross = new Int32Array(D.length);
  const longStop = new Float64Array(D.length);
  const shortStop = new Float64Array(D.length);

  let i0 = -1;
  for (let s = firstStart(cfg); s + maxH + cfg.execWindowBlocks < cfg.endBlock; s += cfg.startStepBlocks) {
    while (i0 + 1 < n && marks.block[i0 + 1]! <= s) i0++;
    if (i0 < 0) {
      stats.skippedNoMark++;
      continue;
    }
    if (s - marks.block[i0]! > cfg.maxStartMarkAgeBlocks) {
      stats.skippedStaleMark++;
      continue;
    }
    stats.starts++;
    const m0 = marks.price[i0]!;
    for (let k = 0; k < D.length; k++) {
      longStop[k] = m0 * (1 - D[k]! / 1e4);
      shortStop[k] = m0 * (1 + D[k]! / 1e4);
    }
    longCross.fill(-1);
    shortCross.fill(-1);
    // Stops are ordered by distance, so each side's crossings arrive in distance order.
    let nl = 0;
    let ns = 0;
    for (let j = i0 + 1; j < n && marks.block[j]! <= s + maxH && (nl < D.length || ns < D.length); j++) {
      const p = marks.price[j]!;
      while (nl < D.length && p <= longStop[nl]!) longCross[nl++] = j;
      while (ns < D.length && p >= shortStop[ns]!) shortCross[ns++] = j;
    }
    for (const side of ['long', 'short'] as const) {
      const cross = side === 'long' ? longCross : shortCross;
      const stops = side === 'long' ? longStop : shortStop;
      for (let k = 0; k < D.length; k++) {
        const j = cross[k]!;
        const stop = stops[k]!;
        let tb: number | null = null;
        let markGap: number | null = null;
        let printGap: number | null = null;
        if (j >= 0) {
          tb = marks.block[j]!;
          markGap = adverseBps(side, stop, marks.price[j]!);
          const worst = worstPrint(prints, tb, tb + cfg.execWindowBlocks, side);
          if (worst !== null) printGap = Math.max(0, adverseBps(side, stop, worst));
        }
        for (const h of cfg.horizonsBlocks) {
          const hit = tb !== null && tb <= s + h;
          visit({
            startBlock: s,
            side,
            distanceBps: D[k]!,
            horizonBlocks: h,
            hit,
            triggerBlock: hit ? tb : null,
            markGapBps: hit ? markGap : null,
            printGapBps: hit ? printGap : null
          });
        }
      }
    }
  }
  return stats;
}

/** How far `price` is past `stop` against the stop holder, in bps of the stop. */
const adverseBps = (side: Side, stop: number, price: number) =>
  ((side === 'long' ? stop - price : price - stop) / stop) * 1e4;

/** Lowest (long) or highest (short) print in blocks (after, until]. */
export function worstPrint(prints: Prints, after: number, until: number, side: Side): number | null {
  let worst: number | null = null;
  for (let i = lastAtOrBefore(prints.block, after) + 1; i < prints.block.length && prints.block[i]! <= until; i++) {
    const p = prints.price[i]!;
    if (worst === null || (side === 'long' ? p < worst : p > worst)) worst = p;
  }
  return worst;
}

export interface CoverSample {
  startBlock: number;
  side: Side;
  distanceBps: number;
  horizonBlocks: number;
  /** sigmaBlkBpsE2 the cover was quoted with (postSigma bounds applied). */
  sigmaE2: number;
  hit: boolean;
  triggerBlock: number | null;
  /** 'book': a print at or through the stop armed it (trigger next block); 'mark': the Live fast path. */
  via: 'book' | 'mark' | null;
  /** Stop vs the worst print in [trigger, trigger + execWindow], floored at 0; null when nothing traded. */
  gRealBps: number | null;
  /** max(gRefTrig, gRefPost) in bps of the stop. */
  gRefBps: number | null;
  /** min(gReal, gRef + A, cap); gReal unknown counts at its bound. */
  payoutBps: number | null;
}

export interface CoverStats {
  starts: number;
  skippedNoMark: number;
  skippedStaleMark: number;
  skippedNoSigma: number;
  /** Start x side x distance cells the contract would refuse (d < minDist). */
  rejectedStopTooClose: number;
}

export interface CoverSeries {
  marks: StepSeries;
  oracle: OracleSeries;
  prints: Prints;
}

/** Reference sources at a block: freshness per spec §3.6, timestamps interpolated between marks. */
class References {
  private readonly secPerBlock: number;

  constructor(
    private readonly s: CoverSeries,
    private readonly freshSec: number
  ) {
    const m = s.marks;
    const n = m.block.length;
    const span = n > 1 ? m.block[n - 1]! - m.block[0]! : 0;
    this.secPerBlock = span > 0 ? (m.ts[n - 1]! - m.ts[0]!) / span : 0.3;
  }

  tsAt(block: number): number {
    const i = lastAtOrBefore(this.s.marks.block, block);
    if (i < 0) return -Infinity;
    return this.s.marks.ts[i]! + (block - this.s.marks.block[i]!) * this.secPerBlock;
  }

  isFreshMark(i: number, block: number): boolean {
    return this.s.marks.ts[i]! + this.freshSec >= this.tsAt(block);
  }

  /** Fresh mark and oracle at `block`. */
  sources(block: number): number[] {
    const now = this.tsAt(block);
    const out: number[] = [];
    const im = lastAtOrBefore(this.s.marks.block, block);
    if (im >= 0 && this.s.marks.ts[im]! + this.freshSec >= now) out.push(this.s.marks.price[im]!);
    const io = lastAtOrBefore(this.s.oracle.block, block);
    if (io >= 0 && this.s.oracle.reportTs[io]! + this.freshSec >= now) out.push(this.s.oracle.price[io]!);
    return out;
  }

  /**
   * Lowest fresh source for a long (highest for a short): the median of three always lies between
   * the other two, so this bounds the contract reference gap for any value of the Data Feed.
   */
  worstFor(side: Side, block: number): number | null {
    const v = this.sources(block);
    if (v.length === 0) return null;
    return side === 'long' ? Math.min(...v) : Math.max(...v);
  }

  /** First source published in (trigger, trigger + window] with a timestamp after the trigger's (observe, minTs = triggerTs + 1). */
  postGap(side: Side, stop: number, trigger: number, window: number): number {
    const minTs = Math.floor(this.tsAt(trigger)) + 1;
    const m = this.s.marks;
    const o = this.s.oracle;
    let best: { block: number; gap: number } | null = null;
    const consider = (block: number, price: number) => {
      const gap = Math.max(0, adverseBps(side, stop, price));
      if (!best || block < best.block || (block === best.block && gap > best.gap)) best = { block, gap };
    };
    for (let i = lastAtOrBefore(m.block, trigger) + 1; i < m.block.length && m.block[i]! <= trigger + window; i++) {
      if (m.ts[i]! >= minTs) {
        consider(m.block[i]!, m.price[i]!);
        break;
      }
    }
    for (let i = lastAtOrBefore(o.block, trigger) + 1; i < o.block.length && o.block[i]! <= trigger + window; i++) {
      if (o.reportTs[i]! >= minTs) {
        consider(o.block[i]!, o.price[i]!);
        break;
      }
    }
    return (best as { gap: number } | null)?.gap ?? 0;
  }
}

/**
 * Gapless covers under the contract rules (spec §3.5, §3.7, C4 H-01): quoted at the start mark with sigma
 * known then, refused below minDist, triggered after warm-up by a print-armed close (book and a fresh
 * reference at or through the stop) or the fast path (fresh mark through the stop), paid min(gReal, gRef + A, cap).
 */
export function simulateCovers(
  series: CoverSeries,
  sigmaE2At: (block: number) => number | null,
  params: MarketParams,
  cfg: SimConfig,
  visit: (c: CoverSample) => void
): CoverStats {
  const stats: CoverStats = { starts: 0, skippedNoMark: 0, skippedStaleMark: 0, skippedNoSigma: 0, rejectedStopTooClose: 0 };
  const { marks, prints } = series;
  if (marks.block.length === 0) return stats;
  const refs = new References(series, params.refFreshSec + 2);
  const D = cfg.distancesBps;
  const maxH = Math.max(...cfg.horizonsBlocks);
  const tail = Math.max(cfg.execWindowBlocks, params.windowBlocks);
  const stops = { long: new Float64Array(D.length), short: new Float64Array(D.length) };
  const armed = { long: new Int32Array(D.length), short: new Int32Array(D.length) };
  const fast = { long: new Int32Array(D.length), short: new Int32Array(D.length) };

  for (let s = firstStart(cfg); s + maxH + tail < cfg.endBlock; s += cfg.startStepBlocks) {
    const i0 = lastAtOrBefore(marks.block, s);
    if (i0 < 0) {
      stats.skippedNoMark++;
      continue;
    }
    if (s - marks.block[i0]! > cfg.maxStartMarkAgeBlocks) {
      stats.skippedStaleMark++;
      continue;
    }
    const sigmaE2 = sigmaE2At(s);
    if (sigmaE2 === null) {
      stats.skippedNoSigma++;
      continue;
    }
    stats.starts++;
    const m0 = marks.price[i0]!;
    const minDist = Number(minDistanceBps(params, sigmaE2));
    for (let k = 0; k < D.length; k++) {
      stops.long[k] = m0 * (1 - D[k]! / 1e4);
      stops.short[k] = m0 * (1 + D[k]! / 1e4);
    }
    const armFrom = s + params.warmupBlocks;
    const until = s + maxH;
    scanBookArms(prints, refs, stops, armed, armFrom, until);
    scanFastPath(marks, refs, stops, fast, armFrom, until);

    for (const side of ['long', 'short'] as const) {
      for (let k = 0; k < D.length; k++) {
        if (D[k]! < minDist) {
          stats.rejectedStopTooClose++;
          continue;
        }
        const stop = stops[side][k]!;
        const a = armed[side][k]!;
        const f = fast[side][k]!;
        // An armed cover triggers in the next block; the fast path triggers in the crossing block.
        const viaBook = a >= 0 && (f < 0 || a + 1 <= f);
        const t = viaBook ? a + 1 : f >= 0 ? f : null;
        let gReal: number | null = null;
        let gRef: number | null = null;
        let payout: number | null = null;
        if (t !== null) {
          const fill = worstPrint(prints, t - 1, t + cfg.execWindowBlocks, side);
          gReal = fill === null ? null : Math.max(0, adverseBps(side, stop, fill));
          const rTrig = refs.worstFor(side, t);
          const gTrig = rTrig === null ? 0 : Math.max(0, adverseBps(side, stop, rTrig));
          gRef = Math.max(gTrig, refs.postGap(side, stop, t, params.windowBlocks));
          payout = Math.min(gReal ?? Infinity, gRef + params.slipAllowanceBps, params.maxGapBpsCap);
        }
        for (const h of cfg.horizonsBlocks) {
          const hit = t !== null && t <= s + h;
          visit({
            startBlock: s,
            side,
            distanceBps: D[k]!,
            horizonBlocks: h,
            sigmaE2,
            hit,
            triggerBlock: hit ? t : null,
            via: hit ? (viaBook ? 'book' : 'mark') : null,
            gRealBps: hit ? gReal : null,
            gRefBps: hit ? gRef : null,
            payoutBps: hit ? payout : null
          });
        }
      }
    }
  }
  return stats;
}

type BySide<T> = { long: T; short: T };

// Arm (C4 H-01): book at or through the stop (a print stands in for the book) and the reference itself at or
// through it. If it holds for a far stop it holds for every nearer one, so arms arrive in distance order.
function scanBookArms(
  prints: Prints,
  refs: References,
  stops: BySide<Float64Array>,
  out: BySide<Int32Array>,
  from: number,
  until: number
): void {
  const D = stops.long.length;
  out.long.fill(-1);
  out.short.fill(-1);
  let nl = 0;
  let ns = 0;
  for (let i = lastAtOrBefore(prints.block, from - 1) + 1; i < prints.block.length && prints.block[i]! <= until; i++) {
    if (nl === D && ns === D) return;
    const b = prints.block[i]!;
    const p = prints.price[i]!;
    if (nl < D && p <= stops.long[nl]!) {
      const r = refs.worstFor('long', b);
      while (r !== null && nl < D && p <= stops.long[nl]! && r <= stops.long[nl]!) out.long[nl++] = b;
    }
    if (ns < D && p >= stops.short[ns]!) {
      const r = refs.worstFor('short', b);
      while (r !== null && ns < D && p >= stops.short[ns]! && r >= stops.short[ns]!) out.short[ns++] = b;
    }
  }
}

// Live fast path: a fresh mark at or through the stop. A mark published during warm-up that is
// still fresh at the end of it fires at the first eligible block.
function scanFastPath(
  marks: StepSeries,
  refs: References,
  stops: BySide<Float64Array>,
  out: BySide<Int32Array>,
  from: number,
  until: number
): void {
  const D = stops.long.length;
  out.long.fill(-1);
  out.short.fill(-1);
  let nl = 0;
  let ns = 0;
  const take = (p: number, b: number) => {
    while (nl < D && p <= stops.long[nl]!) out.long[nl++] = b;
    while (ns < D && p >= stops.short[ns]!) out.short[ns++] = b;
  };
  const j0 = lastAtOrBefore(marks.block, from - 1);
  if (j0 >= 0 && refs.isFreshMark(j0, from)) take(marks.price[j0]!, from);
  for (let j = j0 + 1; j < marks.block.length && marks.block[j]! <= until; j++) {
    if (nl === D && ns === D) return;
    take(marks.price[j]!, marks.block[j]!);
  }
}
