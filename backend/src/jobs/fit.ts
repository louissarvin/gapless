import { CURVE, FIT_DISTANCES_BPS, FIT_MIN_EVENTS, SIM, SPEC_DEFAULT_PARAMS, checkParamBounds, type MarketParams } from './config.ts';
import { isqrt, quote, zBucket, type QuoteRejection } from './premium.ts';
import type { CoverSample } from './simulate.ts';
import { eventDistribution, nonDecreasingMajorant, pava, round2, type EventDistribution } from './stats.ts';

export const FIT_METHOD = {
  target:
    'gapBpsE2[9]: mean contract payout given a trigger per z bucket, in bps of notional x 100, rounded up (spec §3.5 fee = gTrig x (1 + load) is charged against it)',
  payout: `per triggered cover: min(gReal, max(gRefTrig, gRefPost) + slipAllowanceBps, maxGapBpsCap) as in spec §3.7 finalize. gReal = stop vs the worst maker print in [trigger, trigger + ${SIM.execWindowBlocks}] blocks (a proxy for the IOC close; when nothing traded it is taken at its bound). Trading fees are ignored`,
  reference:
    'lowest fresh source for longs, highest for shorts, of the onchain mark and oracle (fresh = timestamp + refFreshSec + 2 s). The Data Feed is not in the logs; a median of three always lies between the other two, so this bounds the contract reference gap from above. gRefPost = first source published within windowBlocks with a newer timestamp',
  trigger:
    'Gapless rules (C4), not the native stop: from startBlock + warmupBlocks, either a maker print at or through the stop with the fresh reference also at or through it (arm; the close lands the next block) or a fresh mark at or through the stop (Live fast path), whichever is first. A print stands in for the book; the reference is the least favorable source, so arms are an upper bound',
  quoteRules: 'covers the contract would refuse (d below minDist at the start sigma) are dropped, not counted as misses',
  z: 'zE2 = d x 1e4 / (sigmaE2 x isqrt(T)) with the contract integer formula; sigmaE2 = trailing sigma of the onchain mark at the start block (sigma.ts), rounded and clamped to [5, 2000]',
  sigmaBasis:
    'onchain mark: the keeper posts toSigmaE2(latestSigma(computeSigmaSeries(...))) over MarkUpdated logs, the series these jobs ingest, using its last 48,000 blocks (4 half-lives of the 1 h EWMA, older weight under 7%). Not Perpl mid (spec §4.1): mid has no log history',
  samples: `distances ${FIT_DISTANCES_BPS.join(', ')} bps; horizons 3000 and 12000 blocks; both sides pooled`,
  events: `an event is one trigger block per side; overlapping starts and both horizons share it. A bucket needs ${FIT_MIN_EVENTS} distinct events to be measured`,
  prior: `a bucket with fewer than ${FIT_MIN_EVENTS} distinct events keeps the current (spec default) value`,
  isotonic:
    'measured buckets are lifted to their running max over z; pavaE2 (pool-adjacent-violators weighted by distinct events) is reported as the central estimate',
  floor:
    'proposed = max(current value, lifted measured value), capped at maxGapBpsCap x 100. A few days can raise a bucket but never cut it; lowering premiums needs a longer window with stress days (05 §2.4 step 6)',
  notFitted: [
    'impactBpsPerKE2: needs Perpl book depth snapshots (keeper samples), which HyperSync logs do not contain',
    'every other MarketParams field: carried over unchanged from the spec defaults'
  ]
} as const;

export interface BucketStats {
  bucket: number;
  zFromE2: number | null;
  zToE2: number | null;
  samples: number;
  hits: number;
  distinctEvents: number;
  pHit: number | null;
  /** Sum of payouts in bps over hits (unrounded, for the table fit). */
  payoutSumBps: number;
  meanPayoutBps: number | null;
  payoutBps: EventDistribution;
  /** E[min(gRef + A, cap)]: the payout if every close filled at its worst allowed price. */
  meanRefBoundBps: number | null;
  /** Share of hits with no print in the close window (gReal taken at its bound). */
  fillUnknownShare: number | null;
  /** Mean payout over hits that had a print, for comparison with the bounded mean. */
  meanPayoutKnownFillBps: number | null;
  /** Share of hits triggered through the Live fast path (mark) rather than an arm. */
  fastPathShare: number | null;
}

interface Bucket {
  samples: number;
  hits: number;
  payouts: number[];
  eventIds: string[];
  refBoundSum: number;
  fillUnknown: number;
  knownFillSum: number;
  fastPath: number;
}

export class FitAggregator {
  private readonly b: Bucket[];
  private readonly distances = new Set<number>(FIT_DISTANCES_BPS);
  private readonly sqrtT = new Map<number, bigint>();

  constructor(private readonly params: MarketParams = SPEC_DEFAULT_PARAMS) {
    this.b = Array.from({ length: params.zEdgesE2.length + 1 }, () => ({
      samples: 0,
      hits: 0,
      payouts: [],
      eventIds: [],
      refBoundSum: 0,
      fillUnknown: 0,
      knownFillSum: 0,
      fastPath: 0
    }));
  }

  add(c: CoverSample): void {
    if (!this.distances.has(c.distanceBps)) return;
    let root = this.sqrtT.get(c.horizonBlocks);
    if (root === undefined) this.sqrtT.set(c.horizonBlocks, (root = isqrt(BigInt(c.horizonBlocks))));
    const zE2 = (BigInt(c.distanceBps) * 10_000n) / (BigInt(c.sigmaE2) * root);
    const b = this.b[zBucket(zE2, this.params.zEdgesE2)]!;
    b.samples++;
    if (!c.hit) return;
    b.hits++;
    b.payouts.push(c.payoutBps!);
    b.eventIds.push(`${c.side}:${c.triggerBlock}`);
    b.refBoundSum += Math.min(c.gRefBps! + this.params.slipAllowanceBps, this.params.maxGapBpsCap);
    if (c.gRealBps === null) b.fillUnknown++;
    else b.knownFillSum += c.payoutBps!;
    if (c.via === 'mark') b.fastPath++;
  }

  buckets(): BucketStats[] {
    const edges = this.params.zEdgesE2;
    const share = (x: number, n: number) => (n ? Math.round((x / n) * 1e4) / 1e4 : null);
    return this.b.map((x, i) => {
      const sum = x.payouts.reduce((a, v) => a + v, 0);
      return {
        bucket: i,
        zFromE2: i === 0 ? 0 : edges[i - 1]!,
        zToE2: i < edges.length ? edges[i]! : null,
        samples: x.samples,
        hits: x.hits,
        distinctEvents: new Set(x.eventIds).size,
        pHit: share(x.hits, x.samples),
        payoutSumBps: sum,
        meanPayoutBps: x.hits ? round2(sum / x.hits) : null,
        payoutBps: eventDistribution(x.payouts, x.eventIds),
        meanRefBoundBps: x.hits ? round2(x.refBoundSum / x.hits) : null,
        fillUnknownShare: share(x.fillUnknown, x.hits),
        meanPayoutKnownFillBps: x.hits > x.fillUnknown ? round2(x.knownFillSum / (x.hits - x.fillUnknown)) : null,
        fastPathShare: share(x.fastPath, x.hits)
      };
    });
  }
}

export interface GapTableFit {
  /** ceil(mean payout x 100) where the bucket has enough distinct events, else null. */
  measuredE2: (number | null)[];
  /** Measured values after the monotone lift; null where unmeasured. */
  liftedE2: (number | null)[];
  source: ('measured' | 'prior')[];
  pavaE2: (number | null)[];
  proposedE2: number[];
}

/** Mean x 100 rounded up from the raw sum; the epsilon absorbs float error (0.07 x 100 = 7.000000000000001). */
export const ceilMeanE2 = (sum: number, n: number): number => Math.ceil((sum * 100) / n - 1e-9);

/** Turns bucket stats into a proposed gapBpsE2 table (see FIT_METHOD). */
export function fitGapTable(
  buckets: readonly Pick<BucketStats, 'hits' | 'distinctEvents' | 'payoutSumBps'>[],
  prior: readonly number[],
  minEvents: number,
  capE2: number
): GapTableFit {
  const measuredE2 = buckets.map((b) => (b.hits > 0 && b.distinctEvents >= minEvents ? ceilMeanE2(b.payoutSumBps, b.hits) : null));
  const idx = measuredE2.flatMap((m, i) => (m === null ? [] : [i]));
  const lifted = nonDecreasingMajorant(idx.map((i) => measuredE2[i]!));
  const liftedE2: (number | null)[] = measuredE2.map(() => null);
  idx.forEach((i, k) => (liftedE2[i] = lifted[k]!));
  const proposedE2 = prior.map((p, i) => Math.min(capE2, Math.max(p, liftedE2[i] ?? 0)));
  const iso = pava(
    idx.map((i) => measuredE2[i]!),
    idx.map((i) => buckets[i]!.distinctEvents)
  );
  const pavaE2: (number | null)[] = measuredE2.map(() => null);
  idx.forEach((i, k) => (pavaE2[i] = Math.round(iso[k]!)));
  return { measuredE2, liftedE2, source: measuredE2.map((m) => (m === null ? 'prior' : 'measured')), pavaE2, proposedE2 };
}

export interface FitProposal {
  buckets: BucketStats[];
  table: GapTableFit;
  params: MarketParams;
  boundsViolations: string[];
  measuredBuckets: number;
}

export function proposeParams(agg: FitAggregator, base: MarketParams = SPEC_DEFAULT_PARAMS): FitProposal {
  const buckets = agg.buckets();
  const table = fitGapTable(buckets, base.gapBpsE2, FIT_MIN_EVENTS, base.maxGapBpsCap * 100);
  const params: MarketParams = { ...base, zEdgesE2: [...base.zEdgesE2], gapBpsE2: table.proposedE2 };
  return {
    buckets,
    table,
    params,
    boundsViolations: checkParamBounds(params),
    measuredBuckets: table.source.filter((s) => s === 'measured').length
  };
}

export interface CurvePoint {
  distanceBps: number;
  allowed: boolean;
  rejectReasons: QuoteRejection[];
  minDistanceBps: number;
  zE2: number;
  bucket: number;
  gapBpsE2: number;
  /** Fee in bps x 100 of notional: linear in N, so it holds at any size the contract accepts. */
  feeBpsE2: number;
  escrowCNS: string;
  rentCNS: string;
}

/** Fee vs distance for CURVE inputs (1 h, utilization 0) at the given sigma and notional. */
export function premiumCurve(params: MarketParams, sigmaBlkBpsE2: number, notionalCNS: bigint): CurvePoint[] {
  return CURVE.distancesBps.map((d) => {
    const q = quote(params, {
      notionalCNS,
      distanceBps: BigInt(d),
      sigmaBlkBpsE2,
      durationBlocks: CURVE.durationBlocks,
      maxGapBps: CURVE.maxGapBps,
      utilBpsAfter: CURVE.utilizationBps
    });
    return {
      distanceBps: d,
      allowed: q.allowed,
      rejectReasons: q.rejectReasons,
      minDistanceBps: Number(q.minDistanceBps),
      zE2: Number(q.zE2),
      bucket: q.bucket,
      gapBpsE2: params.gapBpsE2[q.bucket]!,
      feeBpsE2: Number(q.feeBpsE2),
      escrowCNS: q.escrowCNS.toString(),
      rentCNS: q.rentCNS.toString()
    };
  });
}
