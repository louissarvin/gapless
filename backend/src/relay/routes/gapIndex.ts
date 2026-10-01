import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError, ok } from '../../lib/http.ts';
import { registerOriginGuard } from '../../lib/security.ts';
import { GAP_INDEX_DOCS, GAP_INDEX_FILES, type GapIndexDoc } from '../../jobs/output.ts';

/** Spec §4.2: the Gap Index JSON is cached 60 s. */
export const GAP_INDEX_CACHE_MS = 60_000;
/** A missing file is re-checked sooner, so the first job output shows up quickly. */
const MISSING_RECHECK_MS = 5_000;
/** Jobs run every 5 min; three missed runs flags the data as stale. */
export const GAP_INDEX_STALE_AFTER_MS = 15 * 60_000;
export const GAP_INDEX_RATE_LIMIT = { max: 60, timeWindow: 60_000 } as const;

export interface GapIndexRoutesOptions {
  appOrigin: string;
  /** The jobs OUT_DIR. */
  outDir: string;
  now?: () => number;
}

const docSchema = z.looseObject({ schemaVersion: z.literal(1), generatedAt: z.iso.datetime() });
type Doc = z.infer<typeof docSchema>;

/** GET /summary, /gaps, /staleness, /premium-curve: job output, 503 until the first run lands. */
export const gapIndexRoutes: FastifyPluginAsync<GapIndexRoutesOptions> = async (scope, opts) => {
  registerOriginGuard(scope, opts.appOrigin);
  const now = opts.now ?? Date.now;
  const cache = new Map<GapIndexDoc, { doc: Doc | null; until: number }>();
  const inflight = new Map<GapIndexDoc, Promise<Doc | null>>();

  async function readDoc(name: GapIndexDoc): Promise<Doc | null> {
    let raw: string;
    try {
      raw = await readFile(join(opts.outDir, GAP_INDEX_FILES[name]), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') scope.log.error({ err, doc: name }, 'gap_index.read_failed');
      return null;
    }
    try {
      return docSchema.parse(JSON.parse(raw));
    } catch (err) {
      scope.log.error({ err, doc: name }, 'gap_index.invalid_file');
      return null;
    }
  }

  // Single-flight per doc so a burst after expiry reads the file once.
  async function load(name: GapIndexDoc): Promise<Doc | null> {
    const hit = cache.get(name);
    if (hit && now() < hit.until) return hit.doc;
    let p = inflight.get(name);
    if (!p) {
      p = readDoc(name)
        .then((doc) => {
          cache.set(name, { doc, until: now() + (doc ? GAP_INDEX_CACHE_MS : MISSING_RECHECK_MS) });
          return doc;
        })
        .finally(() => inflight.delete(name));
      inflight.set(name, p);
    }
    return p;
  }

  for (const name of GAP_INDEX_DOCS) {
    scope.get(`/${name}`, { config: { rateLimit: GAP_INDEX_RATE_LIMIT } }, async (_request, reply) => {
      const doc = await load(name);
      if (!doc) throw new HttpError(503, 'GAP_INDEX_NOT_READY', 'Gap Index data is not available yet');
      const ageMs = now() - Date.parse(doc.generatedAt);
      const stale = ageMs > GAP_INDEX_STALE_AFTER_MS;
      if (stale) scope.log.warn({ doc: name, ageMs }, 'gap_index.stale');
      reply.header('Cache-Control', `public, max-age=${GAP_INDEX_CACHE_MS / 1000}`);
      return ok({ ...doc, stale });
    });
  }
};
