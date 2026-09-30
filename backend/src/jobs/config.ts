// Method constants for the Gap Index and the premium fit. Changing any value changes
// published numbers, so bump METHOD_VERSION with it.

// /4: adds native-stops.json (measured native stop outcomes, W4a) and stats.json (W4b).
export const METHOD_VERSION = 'gapless-gap-index/4';
export const SCHEMA_VERSION = 1 as const;

/** Window sizing assumes blocks are at least this slow, so N days of blocks covers at least N days. */
export const MIN_BLOCK_TIME_S = 0.29;
/** Ingest stops this far behind the HyperSync height to stay clear of reorgs. */
export const CONFIRMATION_BLOCKS = 10;

/** Perpl `refPriceMaxAgeSec` on every perp (01 §1.2); also the native open-revert threshold. */
export const REF_MAX_AGE_SEC = 60;
/** A start needs a mark at most this many blocks old (about 60 s), else the publisher was down. */
export const MAX_START_MARK_AGE_BLOCKS = 200;
/** Perp status 4 = active (01 §1.2). */
export const ACTIVE_PERP_STATUS = 4;

export const SIM = {
  /** One hypothetical stop per side per distance every ~60 s, as in 05 §2.3. */
  startStepBlocks: 200,
  /** 15 min and 1 h (UI default cover duration, spec D42). */
  horizonsBlocks: [3_000, 12_000],
  /** Prints in (trigger, trigger + 4]: native stops fill 3 or 4 blocks after the onchain crossing (measured); Gapless arms at N, triggers by N+3. */
  execWindowBlocks: 4
} as const;

/** Distances for the published gap table. */
export const GAP_DISTANCES_BPS = [10, 25, 50, 100, 200, 300] as const;
/** "Filled worse than X" thresholds in bps. */
export const GAP_THRESHOLDS_BPS = [5, 10, 25, 50, 100, 200] as const;
/** order_max_market_slippage_bps. Measured: the native stop IOC limit is 1% beyond the best book price at execution. */
export const NATIVE_IOC_BOUND_BPS = 100;
/** Headline cell: 1% stop over 1 h. */
export const HEADLINE = { distanceBps: 100, horizonBlocks: 12_000 } as const;

/** Read-only measurement of native Perpl stops (memory/perpl_stop_semantics_2026-10-05.md). */
export const NATIVE_STOP_EVIDENCE = {
  sample:
    'Monad blocks 108,691,236 to 110,691,236 (about 7 days): 1,020 TriggerOrderExecution logs; 574 mark-condition executions joined to their TriggerOrderRequest placement',
  trigger:
    'verified: 565 of 574 executed after the onchain mark was at or through the trigger; the other 9 had it within 5 bps (one publish step), so stops fire on Perpl mark',
  executionDelay: 'verified: 540 of 565 landed 3 or 4 blocks after the first onchain crossing; none later than 20',
  iocBound:
    'verified: market stops send an IOC whose limit is the best opposing book price at execution x (1 -/+ 1%) (349 of 552 exact to 1 tick, the rest within about 1.3 bps); not 1% from the stop or the mark',
  outcomes:
    'market stop-losses in a calm week: 223 full, 4 partial, 1 no fill of 228; fill vs trigger p50 4.9 bps, p95 54 bps; no gap above 1% occurred in the sample'
} as const;

/** Distance grid for the fit (05 §2.4 step 3, 10 to 300 bps). */
export const FIT_DISTANCES_BPS = [10, 15, 25, 40, 50, 75, 100, 150, 200, 300] as const;
/** A bucket needs this many distinct trigger events (not overlapping samples) before its measured mean replaces the prior. */
export const FIT_MIN_EVENTS = 30;

export const SIGMA = {
  /** 1.2 s returns (05 §2.4 step 2) to limit bid-ask bounce. */
  stepBlocks: 4,
  /** Half-lives of 5 min and 1 h in 1.2 s steps; the max of the two is used. */
  halfLivesSteps: [250, 3_000],
  /** One hour of steps before sigma is reported. */
  warmupSteps: 3_000,
  /** postSigma bounds per post (spec §3.2). */
  minE2: 5,
  maxE2: 2_000
} as const;

/** Premium curve inputs: 1 h, empty vault (M = 1). Notional comes from JOBS_CURVE_NOTIONAL_AUSD. */
export const CURVE = {
  distancesBps: [10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300],
  durationBlocks: 12_000,
  maxGapBps: 200,
  utilizationBps: 0
} as const;

export const BLOCKS_PER_YEAR = 105_120_000n;
/** Constants.RENT_FLOOR_PERIOD_BLOCKS (C5 L-09): minFeeCNS is charged per started period. */
export const RENT_FLOOR_PERIOD_BLOCKS = 12_000n;

/** CoverManager.MarketParams (spec §3.3). */
export interface MarketParams {
  slipAllowanceBps: number;
  maxGapBpsCap: number;
  floorSlackBps: number;
  refTolBps: number;
  minStopDistanceBps: number;
  kDistE2: number;
  loadBps: number;
  rentAprBps: number;
  uKinkBps: number;
  slope1Bps: number;
  slope2Bps: number;
  marketCapBps: number;
  perBlockPayoutCapBps: number;
  maxLossToDepositBps: number;
  impactBpsPerKE2: number;
  maxMatchesClose: number;
  warmupBlocks: number;
  armTtlBlocks: number;
  exclusiveBlocks: number;
  windowBlocks: number;
  minDurationBlocks: number;
  maxDurationBlocks: number;
  sigmaMaxAgeBlocks: number;
  refFreshSec: number;
  feedMaxAgeSec: number;
  minFeeCNS: number;
  maxCoverNotionalCNS: number;
  zEdgesE2: number[];
  gapBpsE2: number[];
}

/** Constants.defaultMarketParams: spec §3.2 with the BUILD_PLAN §0 overrides (sigmaMaxAgeBlocks 6000, canary notional cap 50 AUSD) and C4 maxMatchesClose 16. */
export const SPEC_DEFAULT_PARAMS: Readonly<MarketParams> = Object.freeze({
  slipAllowanceBps: 5,
  maxGapBpsCap: 200,
  floorSlackBps: 100,
  refTolBps: 50,
  minStopDistanceBps: 10,
  kDistE2: 300,
  loadBps: 5_000,
  rentAprBps: 2_000,
  uKinkBps: 5_000,
  slope1Bps: 5_000,
  slope2Bps: 40_000,
  marketCapBps: 5_000,
  perBlockPayoutCapBps: 2_500,
  maxLossToDepositBps: 4_000,
  impactBpsPerKE2: 10,
  maxMatchesClose: 16,
  warmupBlocks: 200,
  armTtlBlocks: 200,
  exclusiveBlocks: 3,
  windowBlocks: 40,
  minDurationBlocks: 1_000,
  maxDurationBlocks: 48_000,
  sigmaMaxAgeBlocks: 6_000,
  refFreshSec: 60,
  feedMaxAgeSec: 120,
  minFeeCNS: 20_000,
  maxCoverNotionalCNS: 50_000_000,
  zEdgesE2: [50, 100, 150, 200, 250, 300, 400, 600],
  gapBpsE2: [194, 91, 101, 143, 229, 452, 492, 999, 950]
});

type ScalarKey = Exclude<keyof MarketParams, 'zEdgesE2' | 'gapBpsE2'>;

/** Onchain bounds enforced by setMarketParams (spec §3.2). */
export const PARAM_BOUNDS: Readonly<Record<ScalarKey, readonly [number, number]>> = Object.freeze({
  slipAllowanceBps: [5, 50],
  maxGapBpsCap: [50, 500],
  floorSlackBps: [10, 300],
  refTolBps: [0, 200],
  minStopDistanceBps: [5, 500],
  kDistE2: [100, 1_000],
  loadBps: [0, 20_000],
  rentAprBps: [0, 10_000],
  uKinkBps: [1_000, 9_000],
  slope1Bps: [0, 20_000],
  slope2Bps: [0, 60_000],
  marketCapBps: [500, 10_000],
  perBlockPayoutCapBps: [100, 10_000],
  maxLossToDepositBps: [1_000, 6_000],
  impactBpsPerKE2: [0, 1_000],
  maxMatchesClose: [8, 200],
  warmupBlocks: [100, 2_000],
  armTtlBlocks: [10, 400],
  exclusiveBlocks: [0, 10],
  windowBlocks: [10, 200],
  minDurationBlocks: [500, 48_000],
  maxDurationBlocks: [500, 48_000],
  sigmaMaxAgeBlocks: [100, 6_000],
  refFreshSec: [10, 120],
  feedMaxAgeSec: [30, 3_600],
  minFeeCNS: [0, 1_000_000],
  maxCoverNotionalCNS: [10_000_000, 100_000_000_000]
});

/** Returns one message per violated bound; empty means setMarketParams would accept it. */
export function checkParamBounds(p: MarketParams): string[] {
  const out: string[] = [];
  for (const [key, [lo, hi]] of Object.entries(PARAM_BOUNDS) as [ScalarKey, readonly [number, number]][]) {
    const v = p[key];
    if (!Number.isInteger(v) || v < lo || v > hi) out.push(`${key}=${v} outside [${lo}, ${hi}]`);
  }
  if (p.minDurationBlocks > p.maxDurationBlocks) out.push('minDurationBlocks > maxDurationBlocks');
  if (p.zEdgesE2.length !== 8) out.push('zEdgesE2 must have 8 entries');
  for (let i = 1; i < p.zEdgesE2.length; i++) {
    if (p.zEdgesE2[i]! <= p.zEdgesE2[i - 1]!) out.push('zEdgesE2 must be strictly increasing');
  }
  if (p.gapBpsE2.length !== 9) out.push('gapBpsE2 must have 9 entries');
  p.gapBpsE2.forEach((g, i) => {
    if (!Number.isInteger(g) || g < 0 || g > p.maxGapBpsCap * 100) {
      out.push(`gapBpsE2[${i}]=${g} outside [0, ${p.maxGapBpsCap * 100}]`);
    }
  });
  return out;
}
