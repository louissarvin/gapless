import { describe, expect, test } from 'bun:test';
import { SPEC_DEFAULT_PARAMS } from '../../src/jobs/config.ts';
import { FitAggregator, fitGapTable } from '../../src/jobs/fit.ts';
import { GapAggregator, headline } from '../../src/jobs/gap-history.ts';
import {
  simulateCovers,
  simulateStops,
  worstPrint,
  type CoverSample,
  type SimConfig,
  type StopSample
} from '../../src/jobs/simulate.ts';

// Hand-written test-only path. One start at block 0, m0 = 10,000.
// Long stops: d10 9,990, d50 9,950, d100 9,900. Short stops: 10,010, 10,050, 10,100.
const marks = { block: [0, 100, 300, 500, 700], price: [10_000, 9_990, 9_940, 9_800, 10_100] };
const prints = { block: [101, 103, 104, 501, 702], price: [9_985, 9_970, 9_900, 9_750, 10_120] };
const cfg: SimConfig = {
  startStepBlocks: 10_000,
  horizonsBlocks: [400, 1_000],
  distancesBps: [10, 50, 100],
  execWindowBlocks: 3,
  maxStartMarkAgeBlocks: 200,
  fromBlock: 0,
  endBlock: 2_000
};

function run(c: SimConfig = cfg) {
  const out: StopSample[] = [];
  const stats = simulateStops(marks, prints, c, (s) => out.push(s));
  const get = (side: string, d: number, h: number) =>
    out.find((s) => s.side === side && s.distanceBps === d && s.horizonBlocks === h)!;
  return { out, stats, get };
}

describe('simulateStops', () => {
  test('triggers on the first mark through each stop and measures the gap', () => {
    const { out, stats, get } = run();
    expect(stats).toEqual({ starts: 1, skippedNoMark: 0, skippedStaleMark: 0 });
    expect(out.length).toBe(2 * 3 * 2);

    // d10 long: mark 9,990 at block 100 sits exactly on the stop, gap 0.
    expect(get('long', 10, 400)).toMatchObject({ hit: true, triggerBlock: 100, markGapBps: 0 });
    // d50 long: 9,940 at block 300: (9,950 - 9,940) / 9,950 = 10.05 bps.
    expect(get('long', 50, 400).markGapBps).toBeCloseTo(10.0503, 3);
    // d100 long: 9,800 at block 500, outside the 400-block horizon, inside 1,000.
    expect(get('long', 100, 400)).toMatchObject({ hit: false, triggerBlock: null, markGapBps: null });
    expect(get('long', 100, 1_000).markGapBps).toBeCloseTo(101.0101, 3); // (9,900 - 9,800) / 9,900
    // Shorts: one jump to 10,100 at block 700 crosses all three stops.
    expect(get('short', 10, 1_000).markGapBps).toBeCloseTo(89.9101, 3); // (10,100 - 10,010) / 10,010
    expect(get('short', 50, 1_000).markGapBps).toBeCloseTo(49.7512, 3);
    expect(get('short', 100, 1_000).markGapBps).toBe(0);
    expect(get('short', 10, 400).hit).toBe(false);
  });

  test('print gap uses the worst print in (trigger, trigger + window]', () => {
    const { get } = run();
    // Long d10 trigger 100: prints 9,985 and 9,970 (block 104 is outside): (9,990 - 9,970) / 9,990.
    expect(get('long', 10, 400).printGapBps).toBeCloseTo(20.02, 2);
    // Long d50 trigger 300: nothing traded in (300, 303].
    expect(get('long', 50, 400).printGapBps).toBeNull();
    expect(get('long', 100, 1_000).printGapBps).toBeCloseTo(151.5152, 3); // (9,900 - 9,750) / 9,900
    expect(get('short', 100, 1_000).printGapBps).toBeCloseTo(19.802, 3); // (10,120 - 10,100) / 10,100
    // A 4-block window (the measured native execution delay) reaches block 104: (9,990 - 9,900) / 9,990.
    expect(run({ ...cfg, execWindowBlocks: 4 }).get('long', 10, 400).printGapBps).toBeCloseTo(90.0901, 3);
  });

  test('drops starts whose horizon would pass the end of the data', () => {
    expect(run({ ...cfg, endBlock: 1_003 }).stats.starts).toBe(0);
    expect(run({ ...cfg, endBlock: 1_004 }).stats.starts).toBe(1);
  });

  test('skips starts with a stale mark (publisher down) or no mark yet', () => {
    const late = { block: [50], price: [10_000] };
    const out: StopSample[] = [];
    const stats = simulateStops(late, prints, { ...cfg, startStepBlocks: 300, maxStartMarkAgeBlocks: 100, endBlock: 1_700 }, (s) =>
      out.push(s)
    );
    // Starts 0 (no mark), 300 (mark 250 blocks old), 600 (550 old): all skipped.
    expect(stats).toEqual({ starts: 0, skippedNoMark: 1, skippedStaleMark: 2 });
    expect(out).toEqual([]);
  });

  test('worstPrint is exclusive of the start and inclusive of the end', () => {
    expect(worstPrint(prints, 100, 103, 'long')).toBe(9_970);
    expect(worstPrint(prints, 101, 104, 'short')).toBe(9_970);
    expect(worstPrint(prints, 104, 500, 'long')).toBeNull();
  });
});

describe('GapAggregator', () => {
  const base = { startBlock: 0, side: 'long' as const, distanceBps: 100, horizonBlocks: 12_000, printGapBps: null };

  test('counts hits, distinct triggers and exceedances per side, distance and horizon', () => {
    const agg = new GapAggregator();
    agg.add({ ...base, hit: false, triggerBlock: null, markGapBps: null });
    agg.add({ ...base, hit: true, triggerBlock: 7, markGapBps: 4 });
    agg.add({ ...base, startBlock: 200, hit: true, triggerBlock: 7, markGapBps: 150, printGapBps: 160 });
    agg.add({ ...base, startBlock: 400, hit: true, triggerBlock: 900, markGapBps: 60 });
    agg.add({ ...base, distanceBps: 15, hit: true, triggerBlock: 1, markGapBps: 1 }); // not a published distance
    const [row, ...rest] = agg.rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      side: 'long',
      distanceBps: 100,
      samples: 4,
      hits: 3,
      pHit: 0.75,
      distinctTriggers: 2,
      pHitMarkGapAbove100Bps: 0.25,
      printCoverage: 0.3333
    });
    expect(row!.pMarkGapAbove).toMatchObject({ '5': 0.6667, '50': 0.6667, '100': 0.3333, '200': 0 });
    expect(row!.eventsMarkGapAbove).toMatchObject({ '5': 2, '50': 2, '100': 1, '200': 0 });
    expect(row!.markGapBps).toMatchObject({ n: 3, p50: 60, max: 150, events: 2, eventsAtOrAbove: { p50: 2, max: 1 } });
    expect(row!.printGapBps).toMatchObject({ n: 1, events: 1 });
  });

  test('one jump seen by many overlapping starts is one event in the headline', () => {
    const agg = new GapAggregator();
    // 60 starts all triggered by the same mark publish at block 5,000 with a 120 bps gap, plus 40 calm hits.
    for (let i = 0; i < 60; i++) agg.add({ ...base, startBlock: i * 200, hit: true, triggerBlock: 5_000, markGapBps: 120 });
    for (let i = 0; i < 40; i++) agg.add({ ...base, startBlock: 20_000 + i * 200, hit: true, triggerBlock: 30_000 + i * 300, markGapBps: 1 });
    const [h] = headline(agg.rows());
    expect(h).toMatchObject({
      hits: 100,
      distinctTriggers: 41,
      markGapP99Bps: 120,
      markGapP99Events: 1,
      markGapMaxEvents: 1,
      pMarkGapAbove100BpsGivenHit: 0.6,
      eventsMarkGapAbove100Bps: 1
    });
    expect(h!.status.pMarkGapAbove100BpsGivenHit).toContain('not an IOC failure rate');
  });
});

describe('simulateCovers (contract rules)', () => {
  // Test-only series at 0.3 s per block. m0 = 10,000; long stops d50 9,950 and d100 9,900, short 10,050 and 10,100.
  const P = { ...SPEC_DEFAULT_PARAMS, warmupBlocks: 100 };
  const series = {
    marks: { block: [0, 150, 300, 500, 700], ts: [0, 45, 90, 150, 210], price: [10_000, 9_960, 9_890, 9_800, 10_100] },
    // Oracle at 180 reports 9,920 with report time 53 s.
    oracle: { block: [0, 180], ts: [0, 54], price: [10_010, 9_920], reportTs: [-1, 53] },
    prints: { block: [50, 120, 160, 162, 163, 702], price: [9_000, 9_940, 9_945, 9_930, 9_935, 10_120] }
  };
  const covCfg: SimConfig = { ...cfg, distancesBps: [5, 50, 100], execWindowBlocks: 4 };

  function covers(s = series, sigma: number | null = 27, c = covCfg) {
    const out: CoverSample[] = [];
    const stats = simulateCovers(s, () => sigma, P, c, (x) => out.push(x));
    const get = (side: string, d: number, h: number) => out.find((x) => x.side === side && x.distanceBps === d && x.horizonBlocks === h)!;
    return { out, stats, get };
  }

  test('H-01: a print through the stop with the reference merely near it does not arm', () => {
    const { get } = covers();
    // Prints 9,945 at 160 and 9,930 at 162: R = min(mark 9,960, oracle 10,010) = 9,960 is above 9,950, so no arm
    // (C3 armed here within refTol). The fast path fires on mark 9,890 at block 300 instead.
    const c = get('long', 50, 400);
    expect(c).toMatchObject({ hit: true, triggerBlock: 300, via: 'mark', gRealBps: null, sigmaE2: 27 });
    // R = min(9,890, oracle 9,920) = 9,890: (9,950 - 9,890) / 9,950 = 60.3015 bps; payout gRef + A.
    expect(c.gRefBps!).toBeCloseTo(60.3015, 3);
    expect(c.payoutBps!).toBeCloseTo(65.3015, 3);
  });

  test('book arm needs the reference at or through the stop; payout is min(gReal, gRef + A, cap)', () => {
    // Oracle 9,920 (block 180) is through 9,950 while the mark is not: the print at 185 arms, the close lands at 186.
    const s = { ...series, prints: { block: [50, 120, 160, 162, 163, 185, 187, 702], price: [9_000, 9_940, 9_945, 9_930, 9_935, 9_940, 9_935, 10_120] } };
    const c = covers(s).get('long', 50, 400);
    expect(c).toMatchObject({ hit: true, triggerBlock: 186, via: 'book' });
    // gReal: worst print in (185, 190] = 9,935: 15.0754 bps. gRefTrig: R = 9,920: 30.1508 bps.
    expect(c.gRealBps!).toBeCloseTo(15.0754, 3);
    expect(c.gRefBps!).toBeCloseTo(30.1508, 3);
    expect(c.payoutBps!).toBeCloseTo(15.0754, 3); // gReal binds: min(15.08, 35.15, 200)
  });

  test('fast path on a fresh mark; with no print to fill, gReal counts at its bound', () => {
    const c = covers().get('long', 100, 400);
    // Mark 9,890 at block 300 is through 9,900. R = min(9,890, oracle 9,920) = 9,890: gRefTrig = 10.101 bps.
    expect(c).toMatchObject({ hit: true, triggerBlock: 300, via: 'mark', gRealBps: null });
    expect(c.gRefBps!).toBeCloseTo(10.101, 3);
    expect(c.payoutBps!).toBeCloseTo(15.101, 3); // gRef + A
  });

  test('shorts: allowance and cap terms, horizon miss', () => {
    const { get } = covers();
    expect(get('short', 50, 400).hit).toBe(false);
    // Mark 10,100 at 700 (oracle stale by then): R = 10,100. Worst print in [700, 704] = 10,120.
    const s50 = get('short', 50, 1_000);
    expect(s50.gRealBps!).toBeCloseTo(69.6517, 3);
    expect(s50.gRefBps!).toBeCloseTo(49.7512, 3);
    expect(s50.payoutBps!).toBeCloseTo(54.7512, 3); // gRef + A binds
    const s100 = get('short', 100, 1_000);
    expect(s100.gRefBps).toBe(0);
    expect(s100.payoutBps).toBe(5); // gReal 19.8 vs gRef 0 + A 5
  });

  test('refuses stops below minDist and never triggers inside warm-up', () => {
    const { out, stats } = covers();
    // minDist = max(10, 300 x 27 x isqrt(100) / 1e4 = 8) = 10: d5 is refused on both sides.
    expect(stats).toMatchObject({ starts: 1, rejectedStopTooClose: 2 });
    expect(out.some((x) => x.distanceBps === 5)).toBe(false);
    // The 9,000 print at block 50 is inside warm-up and arms nothing.
    expect(out.every((x) => x.triggerBlock === null || x.triggerBlock >= 100)).toBe(true);
  });

  test('a mark through the stop during warm-up fires at the first eligible block if still fresh', () => {
    const s = { ...series, marks: { block: [0, 50, 700], ts: [0, 15, 210], price: [10_000, 9_890, 9_890] }, prints: { block: [], price: [] } };
    const c = covers(s).get('long', 100, 400);
    expect(c).toMatchObject({ hit: true, triggerBlock: 100, via: 'mark' });
  });

  test('skips starts without a warmed-up sigma', () => {
    const { out, stats } = covers(series, null);
    expect(stats).toMatchObject({ starts: 0, skippedNoSigma: 1 });
    expect(out).toEqual([]);
  });
});

describe('fit', () => {
  const cover = (x: Partial<CoverSample>): CoverSample => ({
    startBlock: 0,
    side: 'long',
    distanceBps: 50,
    horizonBlocks: 12_000,
    sigmaE2: 27,
    hit: false,
    triggerBlock: null,
    via: null,
    gRealBps: null,
    gRefBps: null,
    payoutBps: null,
    ...x
  });

  test('FitAggregator buckets by the contract z formula and counts distinct trigger events', () => {
    const agg = new FitAggregator();
    // sigma 27, d 50, T 12,000: zE2 = 500,000 / (27 x 109) = 169, bucket 3.
    agg.add(cover({ hit: true, triggerBlock: 7, via: 'book', gRealBps: 12, gRefBps: 30, payoutBps: 12 }));
    agg.add(cover({ startBlock: 200, hit: true, triggerBlock: 7, via: 'mark', gRealBps: null, gRefBps: 3, payoutBps: 8 }));
    agg.add(cover({}));
    agg.add(cover({ distanceBps: 33, hit: true, triggerBlock: 1, payoutBps: 1, gRefBps: 0 })); // not a fit distance
    const b = agg.buckets();
    expect(b[3]).toMatchObject({
      zFromE2: 150,
      zToE2: 200,
      samples: 3,
      hits: 2,
      distinctEvents: 1,
      pHit: 0.6667,
      payoutSumBps: 20,
      meanPayoutBps: 10,
      meanRefBoundBps: 21.5, // (min(35, 200) + min(8, 200)) / 2
      fillUnknownShare: 0.5,
      meanPayoutKnownFillBps: 12,
      fastPathShare: 0.5
    });
    expect(b.reduce((n, x) => n + x.samples, 0)).toBe(3);
    expect(b[8]).toMatchObject({ zFromE2: 600, zToE2: null });
  });

  test('fitGapTable with no measured bucket proposes exactly the current table', () => {
    const prior = [194, 91, 101, 143, 229, 452, 492, 999, 950];
    const none = prior.map(() => ({ hits: 0, distinctEvents: 0, payoutSumBps: 0 }));
    expect(fitGapTable(none, prior, 30, 20_000).proposedE2).toEqual(prior);
  });

  test('fitGapTable gates on distinct events, lifts monotonically, never cuts, caps', () => {
    const prior = [194, 91, 101, 143, 229, 452, 492, 999, 950];
    const buckets = [
      { hits: 100, distinctEvents: 100, payoutSumBps: 50 }, // 0.5 -> 50
      { hits: 100, distinctEvents: 100, payoutSumBps: 123.4 }, // 1.234 -> 124
      { hits: 100, distinctEvents: 100, payoutSumBps: 90 }, // 0.9 -> 90, lifted to 124
      { hits: 3_000, distinctEvents: 29, payoutSumBps: 27_000 }, // many hits, one crash's worth of events: prior 143
      { hits: 40, distinctEvents: 40, payoutSumBps: 120 }, // 300
      { hits: 0, distinctEvents: 0, payoutSumBps: 0 },
      { hits: 0, distinctEvents: 0, payoutSumBps: 0 },
      { hits: 50, distinctEvents: 50, payoutSumBps: 12_500 }, // 25,000 -> capped at 20,000
      { hits: 0, distinctEvents: 0, payoutSumBps: 0 }
    ];
    const fit = fitGapTable(buckets, prior, 30, 20_000);
    expect(fit.measuredE2).toEqual([50, 124, 90, null, 300, null, null, 25_000, null]);
    expect(fit.liftedE2).toEqual([50, 124, 124, null, 300, null, null, 25_000, null]);
    expect(fit.proposedE2).toEqual([194, 124, 124, 143, 300, 452, 492, 20_000, 950]);
    // PAVA weighted by distinct events pools 124 and 90 (100 each) into 107.
    expect(fit.pavaE2).toEqual([50, 107, 107, null, 300, null, null, 25_000, null]);
  });

  test('fitGapTable rounds a 0.07 bps mean to 7, not 8', () => {
    const one = [{ hits: 30, distinctEvents: 30, payoutSumBps: 0.07 * 30 }];
    expect(fitGapTable(one, [0], 30, 20_000).measuredE2).toEqual([7]);
  });
});
