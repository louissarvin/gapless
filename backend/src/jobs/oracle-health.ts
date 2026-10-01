import { REF_MAX_AGE_SEC, SPEC_DEFAULT_PARAMS } from './config.ts';
import type { RejectionKind } from './rows.ts';
import { distribution, type Distribution } from './stats.ts';
import type { OracleSeries, StepSeries } from './store.ts';

/** Mark is clamped within 25 bps of the Chainlink spot index (01 §5.1). */
export const CLAMP_BPS = 25;
/** CoverManager reference freshness: refFreshSec + 2 s timestamp tolerance (spec §3.6). */
const GAPLESS_FRESH_SEC = SPEC_DEFAULT_PARAMS.refFreshSec + 2;

export const STALENESS_METHOD = {
  publishes: 'MarkUpdated and LinkPriceUpdated logs per perp, last value per block',
  intervals: 'gaps between consecutive publishes, in blocks and in block-timestamp seconds (Monad timestamps have 1 s granularity)',
  staleFraction: `share of time from the first publish to the window end during which the latest publish was older than ${REF_MAX_AGE_SEC} s (Perpl refPriceMaxAgeSec; opens revert past it)`,
  gaplessStaleFraction: `same with ${GAPLESS_FRESH_SEC} s, the CoverManager freshness (refFreshSec + 2 s): time during which the source does not count toward the reference`,
  reportLagSec: 'block timestamp of LinkPriceUpdated minus the report timestamp it carries',
  rejections:
    'UpdateOracleFailed with a ReportAgeExceedsLastUpdate (validFrom <= lastUpdate) for the same perp in the same tx counts as reportNotNewer (a duplicate report, benign); any other UpdateOracleFailed counts as other. Rates divide by every LinkPriceUpdated log plus failures (log counts on both sides). MarkExceedsTol counts mark pushes rejected for exceeding the oracle tolerance',
  divergence: `|mark - oracle| / oracle in bps at each mark publish, using the latest oracle published within ${REF_MAX_AGE_SEC} s before it`
} as const;

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function diffs(xs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) out.push(xs[i]! - xs[i - 1]!);
  return out;
}

/** Share of [ts[0], endTs] where the latest publish is older than maxAgeSec; null without a span. */
export function staleFraction(ts: readonly number[], endTs: number, maxAgeSec: number): number | null {
  if (ts.length === 0 || endTs <= ts[0]!) return null;
  let stale = 0;
  for (let i = 0; i < ts.length; i++) {
    const next = i + 1 < ts.length ? ts[i + 1]! : endTs;
    stale += Math.max(0, next - ts[i]! - maxAgeSec);
  }
  return stale / (endTs - ts[0]!);
}

/** |mark - oracle| / oracle in bps at each mark, against the latest oracle at or before it and fresh enough. */
export function markOracleDivergence(marks: StepSeries, oracle: StepSeries, maxAgeSec: number): number[] {
  const out: number[] = [];
  let j = -1;
  for (let i = 0; i < marks.block.length; i++) {
    while (j + 1 < oracle.block.length && oracle.block[j + 1]! <= marks.block[i]!) j++;
    if (j < 0 || marks.ts[i]! - oracle.ts[j]! > maxAgeSec) continue;
    const o = oracle.price[j]!;
    out.push((Math.abs(marks.price[i]! - o) / o) * 1e4);
  }
  return out;
}

export interface PublishStats {
  publishes: number;
  intervalBlocks: Distribution;
  intervalSec: Distribution;
  staleFraction: number | null;
  gaplessStaleFraction: number | null;
  lastBlock: number | null;
  lastTs: number | null;
  ageSecAtWindowEnd: number | null;
}

function publishStats(s: StepSeries, endTs: number): PublishStats {
  const n = s.block.length;
  const sf = staleFraction(s.ts, endTs, REF_MAX_AGE_SEC);
  const gf = staleFraction(s.ts, endTs, GAPLESS_FRESH_SEC);
  return {
    publishes: n,
    intervalBlocks: distribution(diffs(s.block)),
    intervalSec: distribution(diffs(s.ts)),
    staleFraction: sf === null ? null : r4(sf),
    gaplessStaleFraction: gf === null ? null : r4(gf),
    lastBlock: n ? s.block[n - 1]! : null,
    lastTs: n ? s.ts[n - 1]! : null,
    ageSecAtWindowEnd: n ? Math.max(0, endTs - s.ts[n - 1]!) : null
  };
}

export interface StalenessReport {
  mark: PublishStats & { rejectedOutOfTolerance: number };
  oracle: PublishStats & {
    reportLagSec: Distribution;
    failures: { reportNotNewer: number; other: number };
    /** UpdateOracleFailed logs over LinkPriceUpdated logs plus failures. */
    rejectionRate: number | null;
    /** Only failures not explained by a duplicate report. */
    otherFailureRate: number | null;
  };
  markOracleDivergenceBps: Distribution & { fractionAboveClamp: number | null };
}

export function stalenessReport(
  marks: StepSeries,
  oracle: OracleSeries,
  rejections: Record<RejectionKind, number>,
  endTs: number,
  /** LinkPriceUpdated log count (the series keeps one value per block). */
  oracleUpdateLogs: number
): StalenessReport {
  const updates = oracleUpdateLogs;
  const failed = rejections.oracle_report_not_newer + rejections.oracle_update_failed;
  const rate = (x: number) => (updates + failed ? r4(x / (updates + failed)) : null);
  const div = markOracleDivergence(marks, oracle, REF_MAX_AGE_SEC);
  return {
    mark: { ...publishStats(marks, endTs), rejectedOutOfTolerance: rejections.mark_exceeds_tol },
    oracle: {
      ...publishStats(oracle, endTs),
      reportLagSec: distribution(oracle.ts.map((t, i) => t - oracle.reportTs[i]!)),
      failures: { reportNotNewer: rejections.oracle_report_not_newer, other: rejections.oracle_update_failed },
      rejectionRate: rate(failed),
      otherFailureRate: rate(rejections.oracle_update_failed)
    },
    markOracleDivergenceBps: {
      ...distribution(div),
      fractionAboveClamp: div.length ? r4(div.filter((d) => d > CLAMP_BPS).length / div.length) : null
    }
  };
}
