import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Address } from 'viem';
import { resolvePerplAccountId } from '../jobs/perpl.ts';
import type { ChainHead, MonadPublicClient } from '../lib/chain.ts';
import type { Database } from '../lib/db.ts';
import type { RelayEnv } from '../lib/env.ts';
import { HttpError, registerErrorHandling } from '../lib/http.ts';
import type { Logger } from '../lib/log.ts';
import { registerSecurityHeaders } from '../lib/security.ts';
import { registerHealthz, type MarketDataHealth } from './healthz.ts';
import { PerplRestClient } from './perpl/rest.ts';
import type { MarketStore } from './perpl/store.ts';
import { gapIndexRoutes } from './routes/gapIndex.ts';
import { keeperConsoleRoutes } from './routes/keeperConsole.ts';
import { perplRoutes } from './routes/perpl.ts';
import { sigmaRefreshRoutes } from './routes/sigmaRefresh.ts';
import { sponsorRoutes } from './routes/sponsor.ts';
import { statsRoutes } from './routes/stats.ts';
import { walletRoutes } from './routes/wallet.ts';
import type { SponsorService } from './sponsor/service.ts';

/** Spec §4.2: request bodies are capped at 4 KB. */
export const BODY_LIMIT_BYTES = 4096;

export interface RelayDeps {
  env: RelayEnv;
  log: Logger;
  db: Database;
  /** Monad read client; resolves wallet owners to Perpl account ids. */
  client: MonadPublicClient;
  readHead: () => Promise<ChainHead>;
  /** Upstream WS and fan-out state for /healthz (index.ts wires it). */
  marketData?: () => MarketDataHealth;
  /** Perpl REST proxy client; defaults to one on PERPL_API_URL with global fetch. */
  perplRest?: PerplRestClient;
  /** Live WS state; ticker and book for PERPL_MARKET_IDS are served from it while the feed is fresh. */
  marketStore?: MarketStore;
  /** Overrides the on-chain account lookup (tests). */
  resolveAccountId?: (address: Address) => Promise<bigint | null>;
  /** /sponsor/create and /activate; null or absent answers 503 (SPONSOR_ENABLED off). A getter sees a later start. */
  sponsor?: SponsorService | null | (() => SponsorService | null);
  /** Keeper forwarding for /sigma-refresh and /api/keeper/console (tests inject a fake). */
  fetchKeeper?: typeof fetch;
  now?: () => number;
}

/**
 * Builds the relay HTTP app without listening, so tests can use app.inject().
 */
export async function buildRelayApp(deps: RelayDeps): Promise<FastifyInstance> {
  const { env } = deps;
  const logger: FastifyBaseLogger = deps.log;

  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: env.TRUST_PROXY ?? false,
    // Never trust a client-supplied request id; generate one per request for log correlation.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // Receiving the request stays bounded at 10 s (slow clients); the socket idle timeout covers
    // /activate, which waits for up to two receipts plus 3 blocks (SPONSOR_HANDLER_TIMEOUT_MS).
    requestTimeout: 10_000,
    connectionTimeout: 40_000,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    return503OnClosing: true
  });

  // JSON only. Dropping text/plain also forces a CORS preflight on every browser POST.
  app.removeContentTypeParser('text/plain');

  await app.register(cors, {
    origin: env.APP_ORIGIN,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
    maxAge: 600,
    strictPreflight: true
  });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: () => new HttpError(429, 'RATE_LIMITED', 'Too many requests'),
    onExceeded: (request, key) => request.log.debug({ ip: key }, 'rate_limit.exceeded')
  });

  registerSecurityHeaders(app);
  registerErrorHandling(app);
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  registerHealthz(app, {
    db: deps.db,
    readHead: deps.readHead,
    marketData: deps.marketData,
    internalToken: env.RELAY_INTERNAL_TOKEN,
    now: deps.now
  });

  // Browser-facing route plugins. Each one runs registerOriginGuard(scope, env.APP_ORIGIN).
  const perplRest = deps.perplRest ?? new PerplRestClient({ baseUrl: env.PERPL_API_URL, log: deps.log });
  await app.register(perplRoutes, {
    prefix: '/api/perpl',
    appOrigin: env.APP_ORIGIN,
    rest: perplRest,
    liveMarketIds: env.PERPL_MARKET_IDS,
    store: deps.marketStore,
    now: deps.now
  });
  // Jobs output on the shared data/ volume: JSON files and the event store (opened read-only).
  await app.register(gapIndexRoutes, { prefix: '/api/gap-index', appOrigin: env.APP_ORIGIN, outDir: env.GAP_INDEX_DIR, now: deps.now });
  await app.register(statsRoutes, { prefix: '/api', appOrigin: env.APP_ORIGIN, outDir: env.GAP_INDEX_DIR, now: deps.now });
  await app.register(keeperConsoleRoutes, {
    prefix: '/api/keeper',
    appOrigin: env.APP_ORIGIN,
    keeperUrl: env.KEEPER_INTERNAL_URL,
    token: env.RELAY_INTERNAL_TOKEN,
    fetch: deps.fetchKeeper,
    now: deps.now
  });
  const resolveAccountId = deps.resolveAccountId ?? ((a: Address) => resolvePerplAccountId(deps.client, a));
  await app.register(walletRoutes, { prefix: '/api/wallet', appOrigin: env.APP_ORIGIN, jobsDbPath: env.JOBS_DB_PATH, resolveAccountId, now: deps.now });
  const sponsor = deps.sponsor;
  const service = typeof sponsor === 'function' ? sponsor : () => sponsor ?? null;
  await app.register(sponsorRoutes, { appOrigin: env.APP_ORIGIN, service: env.SPONSOR_ENABLED ? service : () => null });
  await app.register(sigmaRefreshRoutes, {
    appOrigin: env.APP_ORIGIN,
    keeperUrl: env.KEEPER_INTERNAL_URL,
    token: env.RELAY_INTERNAL_TOKEN,
    factory: env.GAPLESS_FACTORY_ADDRESS,
    client: deps.client,
    db: deps.db,
    perAccountPerDay: env.SIGMA_REFRESH_PER_ACCOUNT_PER_DAY,
    sponsoredOnly: env.SPONSOR_ALLOWLIST_ONLY,
    log: deps.log,
    fetch: deps.fetchKeeper,
    now: deps.now
  });

  return app;
}
