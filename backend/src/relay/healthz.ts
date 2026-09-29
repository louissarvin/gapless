import type { FastifyInstance } from 'fastify';
import { MONAD_CHAIN_ID } from '../lib/addresses.ts';
import type { ChainHead } from '../lib/chain.ts';
import { pingDb, type Database } from '../lib/db.ts';
import type { ApiResponse } from '../lib/http.ts';
import { bearerToken, tokenMatches } from '../lib/security.ts';
import { MAX_FEED_LAG_BLOCKS } from './perpl/store.ts';

const HEAD_CACHE_MS = 2_000;
const HEAD_TIMEOUT_MS = 3_000;
/** Monad blocks are ~300 ms; a head this old means the RPC is lagging or stuck. */
const MAX_HEAD_AGE_S = 30;

/** Market data older than this marks the relay degraded (heartbeats arrive every block). */
export const MAX_MARKET_DATA_AGE_MS = 10_000;

export interface MarketDataHealth {
  /** `partial`: subscribed, but Perpl did not acknowledge every requested stream. */
  upstream: 'connected' | 'partial' | 'connecting' | 'down';
  lastMessageAgeMs: number | null;
  headBlock: number | null;
  /** Our RPC head minus Perpl's head; null when unknown. */
  feedLagBlocks: number | null;
  /** Internal view only (they give a capacity attacker live feedback). */
  reconnects: number;
  clients: { public: number; internal: number };
  missingStreams: string[];
}

type PublicMarketData = Pick<MarketDataHealth, 'upstream' | 'lastMessageAgeMs' | 'headBlock' | 'feedLagBlocks'>;

export interface HealthDeps {
  db: Database;
  readHead: () => Promise<ChainHead>;
  /** Upstream Perpl WS and fan-out state; omitted in tests that only cover chain and db. */
  marketData?: () => MarketDataHealth;
  /** RELAY_INTERNAL_TOKEN: a matching bearer token gets the detailed body. */
  internalToken?: string;
  now?: () => number;
}

export interface Health {
  status: 'ok' | 'degraded';
  service: 'relay';
  db: 'ok' | 'error';
  chain: { id: number; head: string | null; headAgeS: number | null };
  marketData?: PublicMarketData | MarketDataHealth;
  /** Internal view only. */
  uptimeS?: number;
}

/**
 * GET /healthz. No Origin check (uptime probes send none). The head read is cached and
 * single-flight so probe traffic cannot amplify into RPC load.
 */
export function registerHealthz(app: FastifyInstance, deps: HealthDeps): void {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let cached: { head: ChainHead | null; at: number } | null = null;
  let inflight: Promise<ChainHead | null> | null = null;

  async function head(): Promise<ChainHead | null> {
    if (cached && now() - cached.at < HEAD_CACHE_MS) return cached.head;
    inflight ??= withTimeout(deps.readHead(), HEAD_TIMEOUT_MS)
      .catch((err: unknown) => {
        app.log.warn({ err }, 'healthz.head_unavailable');
        return null;
      })
      .then((h) => {
        cached = { head: h, at: now() };
        return h;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  app.get('/healthz', async (request, reply) => {
    const h = await head();
    const dbOk = pingDb(deps.db);
    const headAgeS = h ? Math.max(0, Math.floor(now() / 1000) - Number(h.timestamp)) : null;
    const market = deps.marketData?.();
    const marketOk =
      !market ||
      (market.upstream === 'connected' &&
        market.lastMessageAgeMs !== null &&
        market.lastMessageAgeMs <= MAX_MARKET_DATA_AGE_MS &&
        (market.feedLagBlocks === null || market.feedLagBlocks <= MAX_FEED_LAG_BLOCKS));
    const healthy = dbOk && headAgeS !== null && headAgeS <= MAX_HEAD_AGE_S && marketOk;
    const internal = tokenMatches(bearerToken(request.headers.authorization), deps.internalToken);

    const data: Health = {
      status: healthy ? 'ok' : 'degraded',
      service: 'relay',
      db: dbOk ? 'ok' : 'error',
      chain: { id: MONAD_CHAIN_ID, head: h ? h.number.toString() : null, headAgeS },
      ...(market ? { marketData: internal ? market : publicView(market) } : {}),
      ...(internal ? { uptimeS: Math.floor((now() - startedAt) / 1000) } : {})
    };
    // 503 keeps the snapshot in `data` so monitors can see which dependency failed.
    const body: ApiResponse<Health> | { success: false; data: Health; error: { code: string; message: string } } =
      healthy
        ? { success: true, data, error: null }
        : { success: false, data, error: { code: 'DEGRADED', message: 'Dependency check failed' } };
    return reply.code(healthy ? 200 : 503).send(body);
  });
}

function publicView(m: MarketDataHealth): PublicMarketData {
  return { upstream: m.upstream, lastMessageAgeMs: m.lastMessageAgeMs, headBlock: m.headBlock, feedLagBlocks: m.feedLagBlocks };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
