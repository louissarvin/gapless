import { BLOCKS_PER_YEAR, RENT_FLOOR_PERIOD_BLOCKS, type MarketParams } from './config.ts';

/** Floor integer square root, as OZ Math.sqrt. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of negative');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** First i with zE2 < zEdgesE2[i], else the last bucket (spec §3.5). */
export function zBucket(zE2: bigint, zEdgesE2: readonly number[]): number {
  const i = zEdgesE2.findIndex((e) => zE2 < BigInt(e));
  return i === -1 ? zEdgesE2.length : i;
}

/** minDist = max(minStopDistanceBps, kDistE2 x sigma x sqrt(warmupBlocks) / 1e4). */
export function minDistanceBps(p: MarketParams, sigmaBlkBpsE2: number): bigint {
  return max(
    BigInt(p.minStopDistanceBps),
    (BigInt(p.kDistE2) * BigInt(sigmaBlkBpsE2) * isqrt(BigInt(p.warmupBlocks))) / 10_000n
  );
}

/** M(u) in bps: 1e4 + slope1 x min(u, kink) / 1e4 + slope2 x max(0, u - kink) / 1e4. */
export function utilizationMultiplierBps(p: MarketParams, utilBpsAfter: number): bigint {
  const u = BigInt(utilBpsAfter);
  const kink = BigInt(p.uKinkBps);
  return 10_000n + (BigInt(p.slope1Bps) * min(u, kink)) / 10_000n + (BigInt(p.slope2Bps) * max(0n, u - kink)) / 10_000n;
}

/** PremiumMath.rentFloorCNS (C5 L-09): minFeeCNS per started 12,000-block period. */
export function rentFloorCNS(minFeeCNS: bigint, durationBlocks: number): bigint {
  return minFeeCNS * ceilDiv(BigInt(durationBlocks), RENT_FLOOR_PERIOD_BLOCKS);
}

export interface QuoteInput {
  notionalCNS: bigint;
  distanceBps: bigint;
  sigmaBlkBpsE2: number;
  durationBlocks: number;
  maxGapBps: number;
  utilBpsAfter: number;
}

export type QuoteRejection = 'StopTooClose' | 'NotionalAboveCap' | 'DurationOutOfRange';

export interface QuoteResult {
  /** The contract would accept this cover (rejectReasons empty). */
  allowed: boolean;
  rejectReasons: QuoteRejection[];
  minDistanceBps: bigint;
  zE2: bigint;
  bucket: number;
  impactE2: bigint;
  gTrigE2: bigint;
  feeBpsE2: bigint;
  capCNS: bigint;
  multiplierBps: bigint;
  escrowCNS: bigint;
  /** PremiumMath.rentCNS: max(minFee, APR rent); the contract's 400 parity vectors pin this one. */
  rentRawCNS: bigint;
  /** Quote.rentCNS, what the trader pays: max(rentRawCNS, rentFloorCNS). */
  rentCNS: bigint;
}

// CoverManager.quote (spec §3.5) with contract rounding: user-paid amounts round up, Cap rounds down.
// Amounts are returned even when the contract would refuse the cover (see rejectReasons).
export function quote(p: MarketParams, q: QuoteInput): QuoteResult {
  const sig = BigInt(q.sigmaBlkBpsE2);
  if (sig <= 0n) throw new RangeError('sigma must be positive');
  const minDist = minDistanceBps(p, q.sigmaBlkBpsE2);
  const zE2 = (q.distanceBps * 10_000n) / (sig * isqrt(BigInt(q.durationBlocks)));
  const bucket = zBucket(zE2, p.zEdgesE2);
  const impactE2 = (BigInt(p.impactBpsPerKE2) * q.notionalCNS) / 1_000_000_000n;
  const gTrigE2 = min(BigInt(p.maxGapBpsCap) * 100n, BigInt(p.gapBpsE2[bucket]!) + impactE2);
  const feeBpsE2 = max(BigInt(p.slipAllowanceBps) * 100n, ceilDiv(gTrigE2 * (10_000n + BigInt(p.loadBps)), 10_000n));
  const capCNS = (q.notionalCNS * BigInt(q.maxGapBps)) / 10_000n;
  const M = utilizationMultiplierBps(p, q.utilBpsAfter);
  const escrowCNS = ceilDiv(q.notionalCNS * feeBpsE2 * M, 10_000_000_000n);
  const rentRawCNS = max(
    BigInt(p.minFeeCNS),
    ceilDiv(capCNS * BigInt(p.rentAprBps) * BigInt(q.durationBlocks) * M, 100_000_000n * BLOCKS_PER_YEAR)
  );
  const rentCNS = max(rentRawCNS, rentFloorCNS(BigInt(p.minFeeCNS), q.durationBlocks));
  const rejectReasons: QuoteRejection[] = [];
  if (q.distanceBps < minDist) rejectReasons.push('StopTooClose');
  if (q.notionalCNS > BigInt(p.maxCoverNotionalCNS)) rejectReasons.push('NotionalAboveCap');
  if (q.durationBlocks < p.minDurationBlocks || q.durationBlocks > p.maxDurationBlocks) rejectReasons.push('DurationOutOfRange');
  return {
    allowed: rejectReasons.length === 0,
    rejectReasons,
    minDistanceBps: minDist,
    zE2,
    bucket,
    impactE2,
    gTrigE2,
    feeBpsE2,
    capCNS,
    multiplierBps: M,
    escrowCNS,
    rentRawCNS,
    rentCNS
  };
}
