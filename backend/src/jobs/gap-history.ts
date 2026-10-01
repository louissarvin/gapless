import {
  GAP_DISTANCES_BPS,
  GAP_THRESHOLDS_BPS,
  HEADLINE,
  MAX_START_MARK_AGE_BLOCKS,
  NATIVE_IOC_BOUND_BPS,
  NATIVE_STOP_EVIDENCE,
  SIM
} from './config.ts';
import type { StopSample } from './simulate.ts';
import { eventDistribution, exceedance, exceedanceEvents, type EventDistribution } from './stats.ts';

/** Published with every gaps.json so the numbers can be reproduced from the same block window. */
export const GAP_METHOD = {
  reference: 'Perpl onchain mark (MarkUpdated logs from the Exchange proxy), last value per block',
  starts: `every ${SIM.startStepBlocks} blocks, aligned to block numbers; skipped when the latest mark is older than ${MAX_START_MARK_AGE_BLOCKS} blocks (about 60 s, publisher down)`,
  stop: 'long: m0 x (1 - d/1e4); short: m0 x (1 + d/1e4); m0 = latest mark at the start block',
  trigger: 'first later onchain mark at or through the stop within the horizon (how native Perpl stops trigger, see nativeStopEvidence)',
  markGapBps:
    '(stop - triggering mark) / stop x 1e4 for longs, mirrored for shorts: the reference gap a native stop sees when it fires. Status: verified trigger model, error under one mark publish step (5 bps)',
  printGapBps: `stop vs the lowest (long) or highest (short) MakerOrderFilledV2 price in the ${SIM.execWindowBlocks} blocks after the trigger block, floored at 0; null when nothing traded. Status: conditional proxy for the native fill (worst print, not a book walk for a given size)`,
  nativeIocBoundBps: `${NATIVE_IOC_BOUND_BPS}: the native stop IOC limit sits 1% beyond the best book price at execution, so a mark gap above 1% does not by itself mean a partial or missed fill. pMarkGapAbove['100'] is a distance statistic, not an IOC failure rate; fill outcomes need book depth, which logs do not carry`,
  events:
    'starts overlap (horizon >> step), so one mark publish triggers many samples. An event is one trigger block per row; every distribution reports distinct events in total and at or above each percentile, and eventsMarkGapAbove counts distinct events past each threshold',
  horizons: 'samples whose horizon plus execution window would pass the end of the data are dropped (no censoring)',
  percentiles: 'nearest rank: value at index ceil(p/100 x n) - 1 of the sorted gaps',
  nativeStopEvidence: NATIVE_STOP_EVIDENCE,
  caveats: [
    'The onchain mark publishes on 5 bps moves (about every 50 s for BTC in calm markets, measured) and is clamped within 25 bps of the Chainlink spot index.',
    'Window is a few days of one venue; a tail percentile with few events behind it is anecdote, not a rate.'
  ]
} as const;

interface Cell {
  n: number;
  hits: number;
  markGaps: number[];
  markEvents: number[];
  printGaps: number[];
  printEvents: number[];
}

export interface GapRow {
  side: 'long' | 'short';
  distanceBps: number;
  horizonBlocks: number;
  samples: number;
  hits: number;
  pHit: number | null;
  distinctTriggers: number;
  markGapBps: EventDistribution;
  /** P(markGap > X | hit), keyed by X in bps. */
  pMarkGapAbove: Record<string, number | null>;
  /** Distinct trigger events with markGap > X. */
  eventsMarkGapAbove: Record<string, number>;
  /** P(hit and markGap > 100 bps) over all samples. A distance statistic, not an IOC failure rate. */
  pHitMarkGapAbove100Bps: number | null;
  printCoverage: number | null;
  printGapBps: EventDistribution;
  pPrintGapAbove: Record<string, number | null>;
  eventsPrintGapAbove: Record<string, number>;
}

const r4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);
const r4map = (m: Record<string, number | null>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, r4(v)]));

export class GapAggregator {
  private readonly cells = new Map<string, Cell>();
  private readonly distances = new Set<number>(GAP_DISTANCES_BPS);

  add(s: StopSample): void {
    if (!this.distances.has(s.distanceBps)) return;
    const key = `${s.side}:${s.distanceBps}:${s.horizonBlocks}`;
    let c = this.cells.get(key);
    if (!c) {
      c = { n: 0, hits: 0, markGaps: [], markEvents: [], printGaps: [], printEvents: [] };
      this.cells.set(key, c);
    }
    c.n++;
    if (!s.hit) return;
    c.hits++;
    c.markGaps.push(s.markGapBps!);
    c.markEvents.push(s.triggerBlock!);
    if (s.printGapBps !== null) {
      c.printGaps.push(s.printGapBps);
      c.printEvents.push(s.triggerBlock!);
    }
  }

  rows(): GapRow[] {
    return [...this.cells.entries()]
      .map(([key, c]) => {
        const [side, d, h] = key.split(':');
        const beyond = c.markGaps.filter((g) => g > NATIVE_IOC_BOUND_BPS).length;
        return {
          side: side as 'long' | 'short',
          distanceBps: Number(d),
          horizonBlocks: Number(h),
          samples: c.n,
          hits: c.hits,
          pHit: r4(c.n ? c.hits / c.n : null),
          distinctTriggers: new Set(c.markEvents).size,
          markGapBps: eventDistribution(c.markGaps, c.markEvents),
          pMarkGapAbove: r4map(exceedance(c.markGaps, GAP_THRESHOLDS_BPS)),
          eventsMarkGapAbove: exceedanceEvents(c.markGaps, c.markEvents, GAP_THRESHOLDS_BPS),
          pHitMarkGapAbove100Bps: r4(c.n ? beyond / c.n : null),
          printCoverage: r4(c.hits ? c.printGaps.length / c.hits : null),
          printGapBps: eventDistribution(c.printGaps, c.printEvents),
          pPrintGapAbove: r4map(exceedance(c.printGaps, GAP_THRESHOLDS_BPS)),
          eventsPrintGapAbove: exceedanceEvents(c.printGaps, c.printEvents, GAP_THRESHOLDS_BPS)
        };
      })
      .sort((a, b) => a.side.localeCompare(b.side) || a.horizonBlocks - b.horizonBlocks || a.distanceBps - b.distanceBps);
  }
}

/** The pitch cell (1% stop over 1 h, both sides), every tail statistic next to its event count. */
export function headline(rows: readonly GapRow[]) {
  const t = String(NATIVE_IOC_BOUND_BPS);
  return rows
    .filter((r) => r.distanceBps === HEADLINE.distanceBps && r.horizonBlocks === HEADLINE.horizonBlocks)
    .map((r) => ({
      side: r.side,
      distanceBps: r.distanceBps,
      horizonBlocks: r.horizonBlocks,
      samples: r.samples,
      hits: r.hits,
      distinctTriggers: r.distinctTriggers,
      pHit: r.pHit,
      markGapP99Bps: r.markGapBps.p99,
      markGapP99Events: r.markGapBps.eventsAtOrAbove.p99,
      markGapMaxBps: r.markGapBps.max,
      markGapMaxEvents: r.markGapBps.eventsAtOrAbove.max,
      pMarkGapAbove100BpsGivenHit: r.pMarkGapAbove[t] ?? null,
      eventsMarkGapAbove100Bps: r.eventsMarkGapAbove[t] ?? 0,
      status: {
        markGap: 'verified trigger model (native stops fire on the mark)',
        pMarkGapAbove100BpsGivenHit: 'mark distance past the stop; not an IOC failure rate (the IOC bound is 1% from the book at execution)',
        fillOutcome: 'not modeled: needs book depth'
      }
    }));
}
