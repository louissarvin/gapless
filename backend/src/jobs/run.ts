import { formatUnits } from 'viem';
import type { Database } from '../lib/db.ts';
import type { Logger } from '../lib/log.ts';
import {
  ACTIVE_PERP_STATUS,
  CURVE,
  FIT_DISTANCES_BPS,
  FIT_MIN_EVENTS,
  GAP_DISTANCES_BPS,
  GAP_THRESHOLDS_BPS,
  MAX_START_MARK_AGE_BLOCKS,
  METHOD_VERSION,
  NATIVE_IOC_BOUND_BPS,
  SCHEMA_VERSION,
  SIGMA,
  SIM,
  SPEC_DEFAULT_PARAMS
} from './config.ts';
import { FIT_METHOD, FitAggregator, premiumCurve, proposeParams } from './fit.ts';
import { GAP_METHOD, GapAggregator, headline } from './gap-history.ts';
import { ingest, type IngestResult, type LogSource } from './hypersync.ts';
import { STALENESS_METHOD, stalenessReport } from './oracle-health.ts';
import { computeGaplessStats, decodeGaplessLogs, GAPLESS_STATS_METHOD, gaplessState, ingestGapless, loadGaplessLogs, type GaplessConfig, type GaplessSource, type VaultRead } from './gapless.ts';
import { getNativeState, ingestNativeStops, nativeStopReport, refreshNativeJoins, type NativeStopSource } from './native-ingest.ts';
import { NATIVE_STOP_METHOD } from './native-stops.ts';
import { FIT_FILE, GAP_INDEX_FILES, STATS_FILE, writeJsonAtomic } from './output.ts';
import type { PerpMeta } from './perpl.ts';
import { computeSigmaSeries, latestSigma, sigmaAt, toSigmaE2 } from './sigma.ts';
import { simulateCovers, simulateStops, type SimConfig } from './simulate.ts';
import {
  acquireLease,
  countFills,
  countOracleUpdates,
  countRejections,
  getIngestState,
  listPerps,
  loadMarks,
  loadOracle,
  loadPrints,
  markTsBounds,
  quarantineSummary,
  refreshAccountTotals,
  releaseLease,
  upsertPerps,
  type OracleSeries,
  type Prints,
  type StepSeries
} from './store.ts';

export interface RunDeps {
  db: Database;
  log: Logger;
  source: LogSource;
  readPerps: () => Promise<PerpMeta[]>;
  outDir: string;
  windowDays: number;
  /** Premium curve notional (JOBS_CURVE_NOTIONAL_AUSD in CNS). */
  curveNotionalCNS: bigint;
  /** Unique per process; holds the single-writer lease during a run. */
  leaseOwner: string;
  /** Native stop JoinAll stream (W4a); absent skips native-stops.json. */
  nativeSource?: NativeStopSource;
  /** Gapless logs and vault read (W4b); absent until the deploy addresses are set, which skips stats.json. */
  gapless?: { source: GaplessSource; config: GaplessConfig; readVault: () => Promise<VaultRead> };
  now?: () => Date;
}

export interface DataWindow {
  /** First block with data: the configured window start or, if later, where contiguous ingest began. */
  fromBlock: number;
  configuredFromBlock: number;
  /** Exclusive. */
  toBlock: number;
  fromTs: number;
  toTs: number;
  seconds: number;
  requestedDays: number;
}

/** Another jobs process (daemon or `once`) is mid-run. */
export class LeaseHeldError extends Error {
  constructor() {
    super('jobs: another jobs process holds the writer lease');
    this.name = 'LeaseHeldError';
  }
}

/** Renewed on every page and perp, so it only lapses when the holder died. */
export const LEASE_TTL_MS = 10 * 60_000;

const SIM_DISTANCES = [...new Set<number>([...GAP_DISTANCES_BPS, ...FIT_DISTANCES_BPS])].sort((a, b) => a - b);
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** sha256 over every series the reports read, so a reproduction can prove it used the same inputs. */
export function inputDigest(marks: Pick<StepSeries, 'block' | 'price'>, prints: Prints, oracle: Pick<OracleSeries, 'block' | 'price' | 'reportTs'>): string {
  const h = new Bun.CryptoHasher('sha256');
  for (const xs of [marks.block, marks.price, prints.block, prints.price, oracle.block, oracle.price, oracle.reportTs]) {
    h.update(new Float64Array(xs).buffer);
  }
  return `sha256:${h.digest('hex')}`;
}

async function refreshPerps(deps: RunDeps, nowIso: string): Promise<PerpMeta[]> {
  try {
    const perps = await deps.readPerps();
    upsertPerps(deps.db, perps, nowIso);
    return perps;
  } catch (err) {
    deps.log.warn({ err }, 'jobs.perps_read_failed: using stored perp metadata');
    const stored = listPerps(deps.db);
    if (stored.length === 0) throw new Error('no perp metadata available');
    return stored;
  }
}

/** One cycle under the writer lease: ingest new logs, recompute every report, write them atomically. */
export async function runOnce(deps: RunDeps, signal: AbortSignal): Promise<{ ingest: IngestResult; wrote: boolean }> {
  const now = deps.now ?? (() => new Date());
  const take = () => acquireLease(deps.db, deps.leaseOwner, LEASE_TTL_MS, now().getTime());
  if (!take()) throw new LeaseHeldError();
  const renew = () => {
    if (!take()) throw new Error('jobs: writer lease lost to another process');
  };
  try {
    const ing = await ingest(deps.db, deps.source, { windowDays: deps.windowDays, signal, log: deps.log, now, renewLease: renew });
    deps.log.info({ ...ing }, 'jobs.ingested');
    if (ing.aborted || signal.aborted) return { ingest: ing, wrote: false };
    await sideIngest(deps, signal, renew, now);
    if (signal.aborted) return { ingest: ing, wrote: false };
    refreshTotals(deps, ing.toBlock);
    const wrote = await computeAndWrite(deps, ing, signal, renew, now);
    if (wrote && !signal.aborted) await writeSideReports(deps, now);
    return { ingest: ing, wrote };
  } finally {
    releaseLease(deps.db, deps.leaseOwner);
  }
}

// Native stops and Gapless logs have their own cursors; a failure there must not block the Gap Index.
async function sideIngest(deps: RunDeps, signal: AbortSignal, renew: () => void, now: () => Date): Promise<void> {
  if (deps.nativeSource) {
    try {
      const r = await ingestNativeStops(deps.db, deps.nativeSource, { windowDays: deps.windowDays, signal, log: deps.log, now, renewLease: renew });
      deps.log.info({ ...r }, 'jobs.native_ingested');
      if (!signal.aborted) deps.log.info(refreshNativeJoins(deps.db), 'jobs.native_joined');
    } catch (err) {
      deps.log.error({ err }, 'jobs.native_stops_failed');
    }
  }
  if (deps.gapless && !signal.aborted) {
    try {
      const r = await ingestGapless(deps.db, deps.gapless.source, deps.gapless.config, { signal, log: deps.log, now, renewLease: renew });
      deps.log.info({ ...r }, 'jobs.gapless_ingested');
    } catch (err) {
      deps.log.error({ err }, 'jobs.gapless_ingest_failed');
    }
  }
}

/** native-stops.json and stats.json, each only once its stream has data; failures are logged, not fatal. */
async function writeSideReports(deps: RunDeps, now: () => Date): Promise<void> {
  const generatedAt = now().toISOString();
  const head = { schemaVersion: SCHEMA_VERSION, methodVersion: METHOD_VERSION, generatedAt };
  let native: ReturnType<typeof nativeStopReport> | null = null;
  const nState = deps.nativeSource ? getNativeState(deps.db) : null;
  const nWindow = nState ? { fromBlock: Math.max(nState.windowFromBlock, nState.coverageFromBlock), toBlock: nState.nextBlock } : null;
  try {
    if (nState && nWindow) {
      const symbols = new Map(listPerps(deps.db).map((p) => [p.perpId, p.symbol]));
      native = nativeStopReport(deps.db, symbols);
      await writeJsonAtomic(deps.outDir, GAP_INDEX_FILES['native-stops'], { ...head, method: NATIVE_STOP_METHOD, window: nWindow, ...native });
    }
  } catch (err) {
    deps.log.error({ err }, 'jobs.native_report_failed');
  }
  if (!deps.gapless) return;
  try {
    const g = gaplessState(deps.db);
    if (!g) return;
    let vault: VaultRead = null;
    try {
      vault = await deps.gapless.readVault();
    } catch (err) {
      deps.log.warn({ err }, 'jobs.vault_read_failed');
    }
    const { decoded, undecoded } = decodeGaplessLogs(loadGaplessLogs(deps.db));
    const t = native?.totals;
    await writeJsonAtomic(deps.outDir, STATS_FILE, {
      ...head,
      method: { gapless: GAPLESS_STATS_METHOD, perplNativeStops: 'see native-stops.json method; joined executions only for slippage and delay' },
      window: { fromBlock: g.startBlock, toBlock: g.nextBlock },
      gapless: { ...computeGaplessStats(decoded, vault, deps.gapless.config.addresses.vault), undecodedLogs: undecoded },
      perplNativeStops:
        t && nWindow
          ? {
              window: nWindow,
              executions: t.executions,
              joinRate: t.joinRate,
              slippageVsTriggerBps: { p50: t.slippageVsTriggerBps.p50, p95: t.slippageVsTriggerBps.p95 },
              delayBlocks: { p50: t.delayBlocks.p50, p95: t.delayBlocks.p95 }
            }
          : null
    });
  } catch (err) {
    deps.log.error({ err }, 'jobs.stats_failed');
  }
}

// Wallet totals are a convenience; a failure here must not block the Gap Index.
function refreshTotals(deps: RunDeps, asOfBlock: number): void {
  try {
    refreshAccountTotals(deps.db, asOfBlock);
  } catch (err) {
    deps.log.error({ err }, 'jobs.account_totals_failed');
  }
}

async function computeAndWrite(
  deps: RunDeps,
  ing: IngestResult,
  signal: AbortSignal,
  renew: () => void,
  now: () => Date
): Promise<boolean> {
  const generatedAt = now().toISOString();
  const perps = await refreshPerps(deps, generatedAt);
  const state = getIngestState(deps.db);
  const bounds = markTsBounds(deps.db);
  if (!state || !bounds) throw new Error('no Perpl data in the window yet');
  const window: DataWindow = {
    fromBlock: Math.max(state.windowFromBlock, state.coverageFromBlock),
    configuredFromBlock: state.windowFromBlock,
    toBlock: state.nextBlock,
    fromTs: bounds.minTs,
    toTs: bounds.maxTs,
    seconds: bounds.maxTs - bounds.minTs,
    requestedDays: deps.windowDays
  };

  const excluded: { perpId: number; symbol: string; reason: string }[] = [];
  const out: PerpReport[] = [];
  for (const meta of perps) {
    if (signal.aborted) return false;
    renew();
    const r = computePerp(deps.db, meta, window, deps.curveNotionalCNS);
    if ('reason' in r) excluded.push({ perpId: meta.perpId, symbol: meta.symbol, reason: r.reason });
    else out.push(r);
    await yieldToLoop();
  }
  const quarantine = { ...quarantineSummary(deps.db, window.configuredFromBlock), lastRun: ing.quarantined };
  const docs = buildDocs({ schemaVersion: SCHEMA_VERSION, methodVersion: METHOD_VERSION, generatedAt, window }, out, excluded, quarantine, deps.curveNotionalCNS);
  for (const [file, value] of docs) await writeJsonAtomic(deps.outDir, file, value);
  deps.log.info({ perps: out.length, excluded: excluded.length, window, quarantined: quarantine.inWindow }, 'jobs.reports_written');
  return true;
}

type PerpReport = ReturnType<typeof perpReport>;

/** Every report fragment for one perp, or the reason it is left out. */
export function computePerp(db: Database, meta: PerpMeta, window: DataWindow, curveNotionalCNS: bigint): PerpReport | { reason: string } {
  if (meta.status !== ACTIVE_PERP_STATUS) return { reason: `status ${meta.status} (not active)` };
  const marks = loadMarks(db, meta.perpId);
  if (marks.block.length < 2) return { reason: 'fewer than 2 mark publishes in the window' };
  const prints = loadPrints(db, meta.perpId);
  const oracle = loadOracle(db, meta.perpId);
  const sigma = computeSigmaSeries(marks, window.toBlock);
  const simCfg: SimConfig = {
    ...SIM,
    distancesBps: SIM_DISTANCES,
    maxStartMarkAgeBlocks: MAX_START_MARK_AGE_BLOCKS,
    fromBlock: window.fromBlock,
    endBlock: window.toBlock
  };

  const gapAgg = new GapAggregator();
  const sim = simulateStops(marks, prints, simCfg, (s) => gapAgg.add(s));
  const fitAgg = new FitAggregator();
  const sigmaE2At = (b: number) => {
    const v = sigmaAt(sigma, b);
    return v === null ? null : toSigmaE2(v);
  };
  const covers = simulateCovers({ marks, oracle, prints }, sigmaE2At, SPEC_DEFAULT_PARAMS, { ...simCfg, distancesBps: FIT_DISTANCES_BPS }, (c) =>
    fitAgg.add(c)
  );
  const sigNow = latestSigma(sigma);
  return perpReport(db, meta, {
    marks,
    prints,
    oracle,
    rows: gapAgg.rows(),
    sim,
    covers,
    proposal: proposeParams(fitAgg),
    sigE2: sigNow === null ? null : toSigmaE2(sigNow),
    window,
    curveNotionalCNS
  });
}

function perpReport(
  db: Database,
  meta: PerpMeta,
  x: {
    marks: StepSeries;
    prints: Prints;
    oracle: OracleSeries;
    rows: ReturnType<GapAggregator['rows']>;
    sim: ReturnType<typeof simulateStops>;
    covers: ReturnType<typeof simulateCovers>;
    proposal: ReturnType<typeof proposeParams>;
    sigE2: number | null;
    window: DataWindow;
    curveNotionalCNS: bigint;
  }
) {
  const id = { perpId: meta.perpId, symbol: meta.symbol, name: meta.name };
  const staleness = stalenessReport(x.marks, x.oracle, countRejections(db, meta.perpId), x.window.toTs, countOracleUpdates(db, meta.perpId));
  const last = x.marks.block.length - 1;
  return {
    gaps: { ...id, sim: x.sim, rows: x.rows },
    staleness: { ...id, ...staleness },
    fit: {
      ...id,
      inputDigest: inputDigest(x.marks, x.prints, x.oracle),
      markPublishes: x.marks.block.length,
      coverSim: x.covers,
      sigmaNowBlkBpsE2: x.sigE2,
      measuredBuckets: x.proposal.measuredBuckets,
      buckets: x.proposal.buckets,
      table: x.proposal.table,
      proposedParams: x.proposal.params,
      boundsViolations: x.proposal.boundsViolations
    },
    curve: {
      ...id,
      sigmaBlkBpsE2: x.sigE2,
      curves:
        x.sigE2 === null
          ? null
          : {
              fitProposal: premiumCurve(x.proposal.params, x.sigE2, x.curveNotionalCNS),
              specDefault: premiumCurve(SPEC_DEFAULT_PARAMS, x.sigE2, x.curveNotionalCNS)
            },
      reason: x.sigE2 === null ? 'sigma not warmed up (needs 1 h of marks)' : null
    },
    summary: {
      ...id,
      lastMark: {
        pricePNS: x.marks.price[last]!,
        price: formatUnits(BigInt(x.marks.price[last]!), meta.priceDecimals),
        block: x.marks.block[last]!,
        ts: x.marks.ts[last]!
      },
      markAgeSecAtWindowEnd: staleness.mark.ageSecAtWindowEnd,
      oracleAgeSecAtWindowEnd: staleness.oracle.ageSecAtWindowEnd,
      markStaleFraction: staleness.mark.staleFraction,
      oracleOtherFailureRate: staleness.oracle.otherFailureRate,
      sigmaBlkBpsE2: x.sigE2,
      counts: { markPublishes: x.marks.block.length, oracleUpdates: x.oracle.block.length, makerFills: countFills(db, meta.perpId) },
      headline: headline(x.rows)
    }
  };
}

function buildDocs(
  head: { schemaVersion: number; methodVersion: string; generatedAt: string; window: DataWindow },
  perps: readonly PerpReport[],
  excluded: readonly { perpId: number; symbol: string; reason: string }[],
  quarantine: ReturnType<typeof quarantineSummary> & { lastRun: number },
  curveNotionalCNS: bigint
): [string, unknown][] {
  return [
    [
      GAP_INDEX_FILES.gaps,
      {
        ...head,
        method: GAP_METHOD,
        config: {
          ...SIM,
          distancesBps: GAP_DISTANCES_BPS,
          thresholdsBps: GAP_THRESHOLDS_BPS,
          nativeIocBoundBps: NATIVE_IOC_BOUND_BPS,
          maxStartMarkAgeBlocks: MAX_START_MARK_AGE_BLOCKS
        },
        perps: perps.map((p) => p.gaps)
      }
    ],
    [GAP_INDEX_FILES.staleness, { ...head, method: STALENESS_METHOD, perps: perps.map((p) => p.staleness) }],
    [
      GAP_INDEX_FILES['premium-curve'],
      {
        ...head,
        method: {
          formula: 'CoverManager.quote, spec §3.5, integer math with the contract rounding',
          inputs: { ...CURVE, notionalCNS: curveNotionalCNS.toString() },
          notional: `quoted at ${curveNotionalCNS.toString()} CNS (JOBS_CURVE_NOTIONAL_AUSD); feeBpsE2 is linear in notional, escrow and rent scale with it. allowed is false with rejectReasons where the contract would refuse (distance, maxCoverNotionalCNS ${SPEC_DEFAULT_PARAMS.maxCoverNotionalCNS}, duration)`,
          sigma: 'latest trailing mark sigma (see fit.json), clamped to the postSigma bounds',
          curves: 'fitProposal uses the proposed gapBpsE2; specDefault uses spec §3.2'
        },
        perps: perps.map((p) => p.curve)
      }
    ],
    [
      FIT_FILE,
      {
        ...head,
        method: FIT_METHOD,
        inputs: {
          distancesBps: FIT_DISTANCES_BPS,
          horizonsBlocks: SIM.horizonsBlocks,
          startStepBlocks: SIM.startStepBlocks,
          execWindowBlocks: SIM.execWindowBlocks,
          sides: ['long', 'short'],
          minDistinctEventsPerBucket: FIT_MIN_EVENTS,
          sigma: SIGMA,
          baseParams: 'spec §3.2 defaults with BUILD_PLAN §0 overrides'
        },
        perps: perps.map((p) => p.fit)
      }
    ],
    // Summary last: when it changes, the detail files of the same run are already in place.
    [
      GAP_INDEX_FILES.summary,
      {
        ...head,
        method: { gaps: 'see gaps.json method', quarantine: 'Exchange logs that failed to decode or map; skipped, kept for audit' },
        ingest: { quarantinedLogs: quarantine },
        perps: perps.map((p) => p.summary),
        excluded
      }
    ]
  ];
}
