import { z } from 'zod';
import type { Logger } from '../lib/log.ts';
import { bearerToken, tokenMatches } from '../lib/security.ts';

const MAX_BODY_BYTES = 256;
/** CPU guard per perp: the relay already limits callers to one per 60 s per perp. */
const REFRESH_MIN_INTERVAL_MS = 5_000;

const refreshBody = z.strictObject({ perpId: z.number().int().min(1).max(65_535) });

export interface KeeperHealth {
  status: 'ok' | 'degraded';
  [key: string]: unknown;
}

export interface KeeperServerOptions {
  host: string;
  port: number;
  /** RELAY_INTERNAL_TOKEN: required for /sigma-refresh. */
  token: string;
  log: Logger;
  health: () => KeeperHealth;
  requestSigma: (perpId: number) => boolean;
  /** Read-only console document (ADR-P7); absent answers 404. */
  console?: () => Promise<unknown>;
  now?: () => number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });

/**
 * Pure handler (tests call it directly). Internal only: bind to loopback or the private network.
 * Every route needs the bearer token: /healthz exposes signer, nonce, balance and remaining spend; /console is the
 * relay's source for the public console and stays internal.
 */
export function keeperHandler(o: Omit<KeeperServerOptions, 'host' | 'port'>): (req: Request) => Promise<Response> {
  const now = o.now ?? Date.now;
  const lastRefresh = new Map<number, number>();
  return async (req) => {
    const path = new URL(req.url).pathname;
    const authed = () => tokenMatches(bearerToken(req.headers.get('authorization')), o.token);
    if (path === '/healthz' && req.method === 'GET') {
      if (!authed()) return json(401, { error: 'UNAUTHORIZED' });
      const h = o.health();
      return json(h.status === 'ok' ? 200 : 503, h);
    }
    if (path === '/console' && req.method === 'GET') {
      if (!authed()) return json(401, { error: 'UNAUTHORIZED' });
      if (!o.console) return json(404, { error: 'NOT_FOUND' });
      try {
        return json(200, await o.console());
      } catch (err) {
        o.log.error({ err }, 'console.build_failed');
        return json(500, { error: 'INTERNAL' });
      }
    }
    if (path === '/sigma-refresh' && req.method === 'POST') {
      if (!authed()) return json(401, { error: 'UNAUTHORIZED' });
      // Bun.serve caps the body at 4 KB before this runs; a refresh body is a few bytes.
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return json(413, { error: 'PAYLOAD_TOO_LARGE' });
      let body: z.infer<typeof refreshBody>;
      try {
        body = refreshBody.parse(JSON.parse(text));
      } catch {
        return json(400, { error: 'VALIDATION_ERROR' });
      }
      if (now() - (lastRefresh.get(body.perpId) ?? Number.NEGATIVE_INFINITY) < REFRESH_MIN_INTERVAL_MS) return json(429, { error: 'RATE_LIMITED' });
      if (!o.requestSigma(body.perpId)) return json(404, { error: 'UNKNOWN_PERP' });
      lastRefresh.set(body.perpId, now());
      o.log.info({ perpId: body.perpId }, 'sigma.refresh_requested');
      return json(202, { queued: true });
    }
    return json(404, { error: 'NOT_FOUND' });
  };
}

export function startKeeperServer(o: KeeperServerOptions) {
  return Bun.serve({ hostname: o.host, port: o.port, maxRequestBodySize: 4096, fetch: keeperHandler(o) });
}
