import { describe, expect, test } from 'bun:test';
import { SPEC_DEFAULT_PARAMS, checkParamBounds } from '../../src/jobs/config.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketParams } from '../../src/jobs/config.ts';
import { isqrt, minDistanceBps, quote, rentFloorCNS, utilizationMultiplierBps, zBucket } from '../../src/jobs/premium.ts';
import { computeSigmaSeries, sigmaAt, toSigmaE2 } from '../../src/jobs/sigma.ts';
import { ceilMeanE2 } from '../../src/jobs/fit.ts';
import { distribution, eventDistribution, exceedance, exceedanceEvents, nonDecreasingMajorant, pava, percentile } from '../../src/jobs/stats.ts';

// Hand-written test-only inputs; expected values are derived in the comments.

describe('stats', () => {
  test('nearest-rank percentile', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5); // ceil(5) - 1 = index 4
    expect(percentile(s, 90)).toBe(9);
    expect(percentile(s, 99)).toBe(10); // ceil(9.9) - 1 = 9
    expect(percentile(s, 0)).toBe(1);
    expect(percentile([], 50)).toBeNull();
  });

  test('distribution rounds to 2 decimals and handles empty input', () => {
    expect(distribution([3, 1, 2])).toEqual({ n: 3, mean: 2, p50: 2, p90: 3, p99: 3, max: 3 });
    expect(distribution([1 / 3])).toMatchObject({ mean: 0.33, max: 0.33 });
    expect(distribution([])).toEqual({ n: 0, mean: null, p50: null, p90: null, p99: null, max: null });
  });

  test('exceedance is strict and null without data', () => {
    expect(exceedance([0, 5, 10, 100, 150], [5, 100])).toEqual({ '5': 0.6, '100': 0.2 });
    expect(exceedance([], [5])).toEqual({ '5': null });
  });

  test('pava pools violators with weights', () => {
    expect(pava([1, 3, 2, 4], [1, 1, 1, 1])).toEqual([1, 2.5, 2.5, 4]);
    // (3 x 3 + 1 x 1) / 4 = 2.5 pooled, then 2 < 2.5 pools again: (10 + 2) / 5 = 2.4
    expect(pava([3, 1, 2], [3, 1, 1])).toEqual([2.4, 2.4, 2.4]);
    expect(pava([5], [2])).toEqual([5]);
  });

  test('eventDistribution counts distinct events behind each percentile', () => {
    // Ten samples: nine small ones from nine events, one 120 bps jump seen by... one event (id 'J').
    const values = [1, 1, 2, 2, 3, 3, 4, 4, 5, 120];
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'J'];
    const d = eventDistribution(values, ids);
    expect(d).toMatchObject({ n: 10, p90: 5, p99: 120, max: 120, events: 10 });
    // p99 = 120 rests on one event; p90 = 5 has two events at or above it (5 and 120).
    expect(d.eventsAtOrAbove).toEqual({ p50: 6, p90: 2, p99: 1, max: 1 });
    // The same jump sampled by 5 overlapping starts is still one event.
    const dup = eventDistribution([120, 120, 120, 120, 120, 1], ['J', 'J', 'J', 'J', 'J', 'a']);
    expect(dup).toMatchObject({ n: 6, events: 2, p99: 120 });
    expect(dup.eventsAtOrAbove.p99).toBe(1);
    expect(eventDistribution([], [])).toMatchObject({ n: 0, events: 0, eventsAtOrAbove: { p50: 0, p90: 0, p99: 0, max: 0 } });
  });

  test('exceedanceEvents counts distinct events strictly above each threshold', () => {
    expect(exceedanceEvents([150, 150, 60, 4], [7, 7, 900, 1], [5, 100])).toEqual({ '5': 2, '100': 1 });
  });

  test('ceilMeanE2 rounds the mean up once, without float or double-rounding error', () => {
    expect(ceilMeanE2(0.07, 1)).toBe(7); // naive Math.ceil(0.07 * 100) = 8
    expect(ceilMeanE2(0.14, 1)).toBe(14); // naive gives 15
    expect(ceilMeanE2(0.07 * 3, 3)).toBe(7);
    expect(ceilMeanE2(1.231, 1)).toBe(124); // rounding to 1.23 first would give 123
    expect(ceilMeanE2(2.5, 2)).toBe(125);
  });

  test('non-decreasing majorant is the running max', () => {
    expect(nonDecreasingMajorant([194, 91, 101, 143, 229, 452, 492, 999, 950])).toEqual([
      194, 194, 194, 194, 229, 452, 492, 999, 999
    ]);
  });
});

describe('premium quote (spec §3.5)', () => {
  test('isqrt floors like OZ Math.sqrt', () => {
    expect(isqrt(12_000n)).toBe(109n); // 109^2 = 11881, 110^2 = 12100
    expect(isqrt(200n)).toBe(14n);
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(10n ** 30n)).toBe(10n ** 15n);
  });

  test('zBucket: first edge strictly above z, else the last bucket', () => {
    const edges = SPEC_DEFAULT_PARAMS.zEdgesE2;
    expect(zBucket(0n, edges)).toBe(0);
    expect(zBucket(49n, edges)).toBe(0);
    expect(zBucket(50n, edges)).toBe(1);
    expect(zBucket(169n, edges)).toBe(3);
    expect(zBucket(599n, edges)).toBe(7);
    expect(zBucket(600n, edges)).toBe(8);
  });

  test('worked example: BTC 0.1 BTC at stop 83,082.5, 1 h, calm, utilization 23.3%', () => {
    // N = 10,000 LNS x 830,825 PNS x 1 = 8,308,250,000 CNS. d = 50, sigma 27, T = 12,000.
    // zE2 = 500,000 / (27 x 109) = 169 -> bucket 3 -> gap 143. impact = 10 x N / 1e9 = 83.
    // gTrig = 226; fee = max(500, ceil(226 x 1.5)) = 500. M = 1e4 + 5000 x 2330 / 1e4 = 11,165.
    // escrow = ceil(N x 500 x 11,165 / 1e10) = ceil(4,638,080.5625) = 4,638,081.
    // rent = max(20,000, ceil(166,165,000 x 2000 x 12,000 x 11,165 / (1e8 x 105,120,000))) = 20,000.
    const q = quote(SPEC_DEFAULT_PARAMS, {
      notionalCNS: 8_308_250_000n,
      distanceBps: 50n,
      sigmaBlkBpsE2: 27,
      durationBlocks: 12_000,
      maxGapBps: 200,
      utilBpsAfter: 2_330
    });
    expect(q).toEqual({
      allowed: false,
      rejectReasons: ['NotionalAboveCap'], // 8,308 AUSD is above the 50 AUSD canary cap
      minDistanceBps: 11n, // max(10, 300 x 27 x 14 / 1e4 = 11)
      zE2: 169n,
      bucket: 3,
      impactE2: 83n,
      gTrigE2: 226n,
      feeBpsE2: 500n,
      capCNS: 166_165_000n,
      multiplierBps: 11_165n,
      escrowCNS: 4_638_081n,
      rentRawCNS: 20_000n,
      rentCNS: 20_000n
    });
    // Spec I13: escrow >= A x N.
    expect(q.escrowCNS * 10_000n >= 5n * 8_308_250_000n).toBe(true);
  });

  test('stressed sigma refuses a 50 bps stop (05 §2.6: minDist about 69 bps)', () => {
    expect(minDistanceBps(SPEC_DEFAULT_PARAMS, 163)).toBe(68n); // 300 x 163 x 14 / 1e4 = 68.46
    const q = quote(SPEC_DEFAULT_PARAMS, {
      notionalCNS: 1_000_000_000n,
      distanceBps: 50n,
      sigmaBlkBpsE2: 163,
      durationBlocks: 12_000,
      maxGapBps: 200,
      utilBpsAfter: 0
    });
    expect(q.allowed).toBe(false);
    expect(q.rejectReasons).toEqual(['StopTooClose', 'NotionalAboveCap']); // 1,000 AUSD is also above the canary cap
  });

  test('allowed covers every quote-time rule: notional cap and duration range', () => {
    const base = { distanceBps: 100n, sigmaBlkBpsE2: 27, durationBlocks: 12_000, maxGapBps: 200, utilBpsAfter: 0 };
    expect(quote(SPEC_DEFAULT_PARAMS, { ...base, notionalCNS: 50_000_000n }).rejectReasons).toEqual([]);
    expect(quote(SPEC_DEFAULT_PARAMS, { ...base, notionalCNS: 50_000_001n }).rejectReasons).toEqual(['NotionalAboveCap']);
    expect(quote(SPEC_DEFAULT_PARAMS, { ...base, notionalCNS: 1n, durationBlocks: 999 }).rejectReasons).toEqual(['DurationOutOfRange']);
    expect(quote(SPEC_DEFAULT_PARAMS, { ...base, notionalCNS: 1n, durationBlocks: 48_001 }).allowed).toBe(false);
  });

  test('utilization multiplier has a kink at uKinkBps', () => {
    expect(utilizationMultiplierBps(SPEC_DEFAULT_PARAMS, 0)).toBe(10_000n);
    expect(utilizationMultiplierBps(SPEC_DEFAULT_PARAMS, 5_000)).toBe(12_500n);
    // 1e4 + 2500 + 40000 x 2320 / 1e4 = 21,780 (05 §2.6 "M = 2.179" at 73.2%)
    expect(utilizationMultiplierBps(SPEC_DEFAULT_PARAMS, 7_320)).toBe(21_780n);
  });

  test('fee floors at A and the trigger gap caps at maxGapBpsCap', () => {
    const p = { ...SPEC_DEFAULT_PARAMS, gapBpsE2: Array<number>(9).fill(0) };
    const base = { notionalCNS: 1n, distanceBps: 100n, sigmaBlkBpsE2: 27, durationBlocks: 12_000, maxGapBps: 200, utilBpsAfter: 0 };
    expect(quote(p, base).feeBpsE2).toBe(500n);
    const huge = { ...SPEC_DEFAULT_PARAMS, gapBpsE2: Array<number>(9).fill(20_000) };
    expect(quote(huge, { ...base, notionalCNS: 10n ** 15n }).gTrigE2).toBe(20_000n);
  });

  test('L-09 rent floor: minFee per started 12,000 blocks (PremiumMath test_rentFloor_perStartedPeriod, test_L09)', () => {
    expect(rentFloorCNS(20_000n, 500)).toBe(20_000n);
    expect(rentFloorCNS(20_000n, 12_000)).toBe(20_000n);
    expect(rentFloorCNS(20_000n, 12_001)).toBe(40_000n);
    expect(rentFloorCNS(20_000n, 48_000)).toBe(80_000n);
    expect(rentFloorCNS(0n, 48_000)).toBe(0n);
    // Demo cover (CANARY_PARAMS): 22 lots at stop 85,000 = 18.7 AUSD, cap 0.374 AUSD; APR rent stays under minFee.
    const demo = { notionalCNS: 18_700_000n, distanceBps: 50n, sigmaBlkBpsE2: 27, maxGapBps: 200, utilBpsAfter: 0 };
    const rents = [12_000, 12_001, 24_000, 48_000].map((T) => quote(SPEC_DEFAULT_PARAMS, { ...demo, durationBlocks: T }));
    expect(rents.map((q) => q.rentRawCNS)).toEqual([20_000n, 20_000n, 20_000n, 20_000n]);
    expect(rents.map((q) => q.rentCNS)).toEqual([20_000n, 40_000n, 40_000n, 80_000n]);
  });

  test('parity with the C5 contract quote: 240 vectors from PremiumMath.quote (150 past one rent period)', () => {
    const v = JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/premium_c5_contract_vectors.json'), 'utf8')) as Record<string, string[]> & { n: number };
    const num = (k: string, i: number) => Number(v[k]![i]);
    const big = (k: string, i: number) => BigInt(v[k]![i]!);
    let floorBinds = 0;
    for (let i = 0; i < v.n; i++) {
      const p: MarketParams = {
        ...SPEC_DEFAULT_PARAMS,
        slipAllowanceBps: num('slipAllowanceBps', i),
        maxGapBpsCap: num('maxGapBpsCap', i),
        minStopDistanceBps: num('minStopDistanceBps', i),
        kDistE2: num('kDistE2', i),
        loadBps: num('loadBps', i),
        rentAprBps: num('rentAprBps', i),
        uKinkBps: num('uKinkBps', i),
        slope1Bps: num('slope1Bps', i),
        slope2Bps: num('slope2Bps', i),
        impactBpsPerKE2: num('impactBpsPerKE2', i),
        warmupBlocks: num('warmupBlocks', i),
        minFeeCNS: num('minFeeCNS', i),
        zEdgesE2: Array.from({ length: 8 }, (_, k) => num(`z${k}`, i)),
        gapBpsE2: Array.from({ length: 9 }, (_, k) => num(`g${k}`, i))
      };
      const q = quote(p, {
        notionalCNS: big('notional', i),
        distanceBps: big('distance', i),
        sigmaBlkBpsE2: num('sigma', i),
        durationBlocks: num('duration', i),
        maxGapBps: num('maxGap', i),
        utilBpsAfter: num('util', i)
      });
      const got = [q.minDistanceBps, q.feeBpsE2, q.capCNS, q.escrowCNS, q.rentCNS];
      expect({ i, got }).toEqual({ i, got: ['outMinDist', 'outFee', 'outCap', 'outEscrow', 'outRent'].map((k) => big(k, i)) });
      if (q.rentCNS > q.rentRawCNS) floorBinds++;
    }
    // The vectors must exercise the floor, not just pass through max(minFee, raw).
    expect(floorBinds).toBeGreaterThan(50);
  });

  test('spec defaults pass the onchain bounds; violations are reported', () => {
    expect(checkParamBounds(SPEC_DEFAULT_PARAMS)).toEqual([]);
    const bad = { ...SPEC_DEFAULT_PARAMS, loadBps: 30_000, gapBpsE2: [...SPEC_DEFAULT_PARAMS.gapBpsE2.slice(0, 8), 20_001] };
    expect(checkParamBounds(bad)).toEqual(['loadBps=30000 outside [0, 20000]', 'gapBpsE2[8]=20001 outside [0, 20000]']);
  });
});

describe('sigma', () => {
  test('constant |r| bps per 1.2 s step gives sigma_blk = r / 2 after warm-up, no look-ahead', () => {
    // Price flips between 100,000 and 100,000 x e^(r/1e4) every 4 blocks: |log return| = r bps per step.
    const r = 3;
    const block: number[] = [];
    const price: number[] = [];
    for (let k = 0; k <= 200; k++) {
      block.push(k * 4);
      price.push(k % 2 === 0 ? 100_000 : 100_000 * Math.exp(r / 1e4));
    }
    const s = computeSigmaSeries({ block, ts: block, price }, 801, {
      stepBlocks: 4,
      halfLivesSteps: [5, 50],
      warmupSteps: 20
    });
    expect(sigmaAt(s, 4 * 19)).toBeNull();
    expect(sigmaAt(s, 4 * 20)).toBeCloseTo(r / 2, 9);
    expect(sigmaAt(s, 4 * 150 + 3)).toBeCloseTo(r / 2, 9);
    expect(sigmaAt(s, 10_000)).toBeNull();
  });

  test('toSigmaE2 rounds and clamps to the postSigma bounds', () => {
    expect(toSigmaE2(0.274)).toBe(27);
    expect(toSigmaE2(0)).toBe(5);
    expect(toSigmaE2(50)).toBe(2_000);
  });
});
