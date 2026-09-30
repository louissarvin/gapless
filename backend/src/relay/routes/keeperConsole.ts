import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError, ok } from '../../lib/http.ts';
import { registerOriginGuard } from '../../lib/security.ts';

/** ADR-P7: 2 s cache (also for failures, so a down keeper is not hammered), 30/min per IP. */
export const CONSOLE_CACHE_MS = 2_000;
export const CONSOLE_RATE_LIMIT = { max: 30, timeWindow: 60_000 } as const;
const FETCH_TIMEOUT_MS = 2_000;
/** 50 recent rows plus the rest is a few KB; anything far larger is not a console document. */
export const CONSOLE_MAX_BYTES = 64 * 1024;

const wei = z.string().regex(/^\d{1,40}$/);
const count = z.number().int().nonnegative();
const blockNo = z.number().int().nonnegative();

// Output allowlist: z.object drops every key not listed here, so new keeper fields never reach the public until
// added on purpose. No free text: actions are short identifiers, hashes and addresses are format-checked.
export const consoleSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['up', 'degraded', 'down']),
  head: z.object({ block: blockNo.nullable(), lagBlocks: z.number().int().nullable() }),
  signer: z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), balanceWei: wei.nullable() }),
  governor: z.object({ utcDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), capWei: wei, usedWei: wei, exemptUsedWei: wei, remainingWei: wei }),
  markets: z
    .array(z.object({ perpId: z.number().int().min(1).max(65_535), gated: z.boolean(), maxMatchesClose: count.nullable(), liveCovers: count.nullable() }))
    .max(16),
  recent: z
    .array(
      z.object({
        block: blockNo.nullable(),
        action: z.string().regex(/^[A-Za-z][A-Za-z_]{0,31}$/),
        coverId: z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),
        txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable(),
        outcome: z.enum(['confirmed', 'reverted', 'pending']),
        gasLimit: count.nullable()
      })
    )
    .max(50),
  walks: z.object({ samples: count, chainGapP50: count.nullable(), chainGapMax: count.nullable(), laneShare: z.number().min(0).max(1).nullable() }),
  uptimeS: count
});
export type ConsoleDoc = z.infer<typeof consoleSchema>;

export interface KeeperConsoleRoutesOptions {
  appOrigin: string;
  /** KEEPER_INTERNAL_URL (private network); unset answers 503. */
  keeperUrl: string | undefined;
  token: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

/** GET /api/keeper/console: public, read-only view of the keeper, proxied from its internal bearer-gated /console. */
export const keeperConsoleRoutes: FastifyPluginAsync<KeeperConsoleRoutesOptions> = async (scope, opts) => {
  registerOriginGuard(scope, opts.appOrigin);
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? fetch;
  let cache: { doc: ConsoleDoc | null; until: number } | null = null;
  let inflight: Promise<ConsoleDoc | null> | null = null;

  async function pull(url: string, token: string): Promise<ConsoleDoc | null> {
    try {
      const res = await doFetch(new URL('/console', url), {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) {
        scope.log.warn({ status: res.status }, 'keeper_console.upstream_status');
        return null;
      }
      const text = await res.text();
      if (text.length > CONSOLE_MAX_BYTES) {
        scope.log.error({ bytes: text.length }, 'keeper_console.too_large');
        return null;
      }
      return consoleSchema.parse(JSON.parse(text));
    } catch (err) {
      // Zod issues name fields, never values; fetch errors carry only the host after log URL scrubbing.
      scope.log.warn({ err }, 'keeper_console.unavailable');
      return null;
    }
  }

  scope.get('/console', { config: { rateLimit: CONSOLE_RATE_LIMIT } }, async (_request, reply) => {
    const { keeperUrl, token } = opts;
    if (!keeperUrl || !token) throw new HttpError(503, 'KEEPER_CONSOLE_DISABLED', 'Keeper console is not configured');
    let doc: ConsoleDoc | null;
    if (cache && now() < cache.until) {
      doc = cache.doc;
    } else {
      inflight ??= pull(keeperUrl, token)
        .then((d) => {
          cache = { doc: d, until: now() + CONSOLE_CACHE_MS };
          return d;
        })
        .finally(() => {
          inflight = null;
        });
      doc = await inflight;
    }
    if (!doc) throw new HttpError(503, 'KEEPER_UNAVAILABLE', 'Keeper console is not available right now');
    reply.header('Cache-Control', `public, max-age=${CONSOLE_CACHE_MS / 1000}`);
    return ok(doc);
  });
};
