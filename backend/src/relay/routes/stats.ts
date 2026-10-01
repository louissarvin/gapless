import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError, ok } from '../../lib/http.ts';
import { registerOriginGuard } from '../../lib/security.ts';
import { STATS_FILE } from '../../jobs/output.ts';

export const STATS_CACHE_MS = 60_000;
const MISSING_RECHECK_MS = 5_000;
/** Jobs run every 5 min; three missed runs flags the numbers as stale. */
export const STATS_STALE_AFTER_MS = 15 * 60_000;
export const STATS_RATE_LIMIT = { max: 60, timeWindow: 60_000 } as const;

const count = z.number().int().nonnegative();
const cns = z.string().regex(/^\d{1,78}$/);
const block = z.number().int().nonnegative();
const txHash = z.string().regex(/^0x[0-9a-f]{64}$/).nullable();
const stat = z.number().finite().nullable();

// The relay re-validates its own jobs output: unknown keys are dropped, a wrong shape is treated as not ready.
const statsDoc = z.object({
  schemaVersion: z.literal(1),
  methodVersion: z.string().max(64),
  method: z.object({ gapless: z.record(z.string().max(64), z.string().max(1_000)), perplNativeStops: z.string().max(1_000) }),
  generatedAt: z.iso.datetime(),
  window: z.object({ fromBlock: block, toBlock: block }),
  gapless: z.object({
    covers: z.object({ total: count, live: count, armed: count, triggered: count, finalized: count, expired: count, cancelled: count, voided: count }),
    owners: count,
    accounts: count,
    notionalCoveredCNS: cns,
    premiums: z.object({ escrowToVaultCNS: cns, rentCNS: cns, toLpsCNS: cns, toTreasuryCNS: cns }),
    payouts: z.object({ count, paidCNS: cns, owedCNS: cns }),
    armToTriggerBlocks: z.object({ n: count, p50: stat, max: stat }),
    vault: z.object({ totalAssetsCNS: cns.nullable(), lpCount: count, utilizationBps: stat }),
    cre: z.object({ reports: count, armed: count, triggered: count }),
    firsts: z.object({ deployTx: txHash, firstCoverTx: txHash, firstTriggerTx: txHash }),
    undecodedLogs: count
  }),
  perplNativeStops: z
    .object({
      window: z.object({ fromBlock: block, toBlock: block }),
      executions: count,
      joinRate: stat,
      slippageVsTriggerBps: z.object({ p50: stat, p95: stat }),
      delayBlocks: z.object({ p50: stat, p95: stat })
    })
    .nullable()
});
export type StatsDoc = z.infer<typeof statsDoc>;

export interface StatsRoutesOptions {
  appOrigin: string;
  /** The jobs OUT_DIR (relay GAP_INDEX_DIR). */
  outDir: string;
  now?: () => number;
}

/** GET /api/stats: protocol traction from the jobs-written stats.json (ADR-P3); 503 until the deploy is indexed. */
export const statsRoutes: FastifyPluginAsync<StatsRoutesOptions> = async (scope, opts) => {
  registerOriginGuard(scope, opts.appOrigin);
  const now = opts.now ?? Date.now;
  let cache: { doc: StatsDoc | null; until: number } | null = null;
  let inflight: Promise<StatsDoc | null> | null = null;

  async function read(): Promise<StatsDoc | null> {
    let raw: string;
    try {
      raw = await readFile(join(opts.outDir, STATS_FILE), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') scope.log.error({ err }, 'stats.read_failed');
      return null;
    }
    try {
      return statsDoc.parse(JSON.parse(raw));
    } catch (err) {
      scope.log.error({ err }, 'stats.invalid_file');
      return null;
    }
  }

  async function load(): Promise<StatsDoc | null> {
    if (cache && now() < cache.until) return cache.doc;
    inflight ??= read()
      .then((doc) => {
        cache = { doc, until: now() + (doc ? STATS_CACHE_MS : MISSING_RECHECK_MS) };
        return doc;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  scope.get('/stats', { config: { rateLimit: STATS_RATE_LIMIT } }, async (_request, reply) => {
    const doc = await load();
    if (!doc) throw new HttpError(503, 'STATS_NOT_READY', 'Stats are not available yet');
    const stale = now() - Date.parse(doc.generatedAt) > STATS_STALE_AFTER_MS;
    if (stale) scope.log.warn({ generatedAt: doc.generatedAt }, 'stats.stale');
    reply.header('Cache-Control', `public, max-age=${STATS_CACHE_MS / 1000}`);
    return ok({ ...doc, stale });
  });
};
