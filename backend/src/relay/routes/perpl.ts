import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, ok } from '../../lib/http.ts';
import { clientKey, registerOriginGuard } from '../../lib/security.ts';
import type { CachedResult, PerplRestClient } from '../perpl/rest.ts';
import type { MarketStore } from '../perpl/store.ts';
import { MT, blockTimestamp, l2Level, marketState } from '../perpl/types.ts';

/** Spec §4.2: 60 requests/min per IP across the proxy. */
export const PERPL_PROXY_RATE_LIMIT = { max: 60, timeWindow: 60_000 } as const;
export const MAX_BOOK_LEVELS = 20;
const LIVE_TTL_MS = 1_000;
const HISTORY_TTL_MS = 30_000;
/** Docs: candle resolutions in seconds. */
export const CANDLE_RESOLUTIONS = [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400] as const;

/**
 * History keys are canonical so callers share entries and cannot mint unbounded keys: `to` snaps up
 * to a grid, the span snaps up to a fixed window. Units are candles (or hours for funding).
 */
export const CANDLE_WINDOW = { grid: 64, windows: [64, 256, 1024], maxRequest: 960 } as const;
const HOUR_MS = 3_600_000;
/** 30 days covers about 1000 of BTC's 2580 s funding intervals. */
export const FUNDING_WINDOW = { grid: 1, windows: [24, 168, 720], maxRequest: 696 } as const;
/** Client clock skew tolerated past the current grid bucket. */
const SKEW_SLACK_MS = 5 * 60_000;

/** Upstream misses per client (IPv6 /64) per minute, on top of the 60 requests/min proxy limit. */
export const MISS_BUDGET_PER_MIN = 10;
/** Ids missing from the Perpl context are rejected locally this long. */
export const UNKNOWN_MARKET_TTL_MS = 60_000;
const MAX_TRACKED = 10_000;

const uint = z.number().int().nonnegative();
const marketId = z.string().regex(/^[1-9]\d{0,5}$/, 'must be a market id').transform(Number);
const timestampMs = z.string().regex(/^\d{1,15}$/, 'must be a unix time in ms').transform(Number);

const idParams = z.strictObject({ id: marketId });
const bookQuery = z.strictObject({
  levels: z
    .string()
    .regex(/^\d{1,2}$/, 'must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_BOOK_LEVELS))
    .optional()
});
const noQuery = z.strictObject({});
const candleParams = z.strictObject({
  id: marketId,
  res: z
    .string()
    .regex(/^\d{2,5}$/)
    .transform(Number)
    .pipe(z.union(CANDLE_RESOLUTIONS.map((r) => z.literal(r)))),
  from: timestampMs,
  to: timestampMs
});
const fundingParams = z.strictObject({ id: marketId, from: timestampMs, to: timestampMs });

const contextSchema = z.looseObject({
  chain: z.looseObject({ chain_id: z.number().int() }),
  markets: z.array(z.looseObject({ id: uint }))
});
const tickerSchema = z.object({ mt: z.literal(9), sn: uint, d: z.record(z.string().regex(/^\d{1,10}$/), marketState) });
const bookSchema = z.object({
  mt: z.literal(15),
  sn: uint,
  at: blockTimestamp,
  bid: z.array(l2Level),
  ask: z.array(l2Level)
});
const candleSeriesSchema = z.object({
  mt: uint,
  sn: uint.optional(),
  at: blockTimestamp,
  r: uint,
  d: z.array(z.object({ t: uint, o: uint, c: uint, h: uint, l: uint, v: z.string(), n: uint }))
});
const fundingSeriesSchema = z.object({
  mt: uint,
  sn: uint.optional(),
  at: blockTimestamp,
  m: uint,
  d: z.array(
    z.object({ at: blockTimestamp, feb: uint, rate: z.number(), idx: z.number(), ppl: z.number(), sum: z.number(), div: z.number() })
  )
});

export interface PerplRoutesOptions {
  appOrigin: string;
  rest: PerplRestClient;
  /** PERPL_MARKET_IDS: always valid, and served from `store` while the WS feed is fresh. */
  liveMarketIds?: readonly number[];
  store?: MarketStore;
  missBudgetPerMin?: number;
  now?: () => number;
}

/** Fixed-window counters with a hard size cap; the oldest entry goes first when full. */
class WindowCounter {
  private readonly m = new Map<string, { count: number; start: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number
  ) {}
  take(key: string): boolean {
    const t = this.now();
    let w = this.m.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.m.delete(key);
      if (this.m.size >= MAX_TRACKED) this.m.delete(this.m.keys().next().value!);
      w = { count: 0, start: t };
      this.m.set(key, w);
    }
    if (w.count >= this.max) return false;
    w.count++;
    return true;
  }
}

/**
 * Picks the canonical [from, to) for a history request.
 * @param step one unit in ms (a candle, or an hour for funding)
 */
function canonicalWindow(
  fromMs: number,
  toMs: number,
  step: number,
  spec: { grid: number; windows: readonly number[]; maxRequest: number },
  nowMs: number,
  label: string
): { from: number; to: number } {
  const grid = spec.grid * step;
  const to = Math.ceil(toMs / grid) * grid;
  const issues: z.core.$ZodIssue[] = [];
  if (fromMs >= toMs) issues.push({ code: 'custom', path: ['from'], message: 'must be before to', input: fromMs });
  if (toMs - fromMs > spec.maxRequest * step) issues.push({ code: 'custom', path: ['to'], message: `at most ${spec.maxRequest} ${label} per request`, input: toMs });
  if (to > Math.ceil((nowMs + SKEW_SLACK_MS) / grid) * grid) issues.push({ code: 'custom', path: ['to'], message: 'must not be in the future', input: toMs });
  if (issues.length > 0) throw new z.ZodError(issues);
  const needed = Math.ceil((to - fromMs) / step);
  const steps = spec.windows.find((w) => w >= needed) ?? spec.windows.at(-1)!;
  return { from: to - steps * step, to };
}

/**
 * Allowlisted read-only proxy to public Perpl REST market data (spec §4.2). Only these five
 * shapes reach the upstream; paths are rebuilt from validated numbers, never from client text.
 */
export const perplRoutes: FastifyPluginAsync<PerplRoutesOptions> = async (scope, opts) => {
  const now = opts.now ?? Date.now;
  const live = new Set(opts.liveMarketIds ?? []);
  const misses = new WindowCounter(opts.missBudgetPerMin ?? MISS_BUDGET_PER_MIN, 60_000, now);
  const unknownIds = new Map<number, number>();
  // One shared bucket for the whole proxy; the global limiter is disabled per route below,
  // because @fastify/rate-limit runs at most one limiter per request.
  scope.addHook('onRequest', scope.rateLimit(PERPL_PROXY_RATE_LIMIT));
  registerOriginGuard(scope, opts.appOrigin);
  const config = { rateLimit: false as const };

  const charge = (request: FastifyRequest) => ({ charge: () => misses.take(clientKey(request.ip)) });

  function send(reply: FastifyReply, ttlMs: number, xCache: string, stale: boolean, ageMs: number, data: object) {
    reply.header('Cache-Control', `max-age=${Math.max(1, Math.floor(ttlMs / 1000))}`);
    reply.header('X-Cache', xCache);
    return ok({ ...data, stale, ageMs });
  }

  function sendCached<T extends object>(reply: FastifyReply, ttlMs: number, r: CachedResult<T>, data: object = r.value) {
    const xCache = r.source === 'cache' ? 'HIT' : r.source === 'stale' ? 'STALE' : 'MISS';
    return send(reply, ttlMs, xCache, r.source === 'stale', r.ageMs, data);
  }

  /** Ids outside PERPL_MARKET_IDS must be listed in the (cached) Perpl context, so junk ids never reach the upstream. */
  async function assertKnownMarket(request: FastifyRequest, id: number): Promise<void> {
    if (live.has(id)) return;
    const t = now();
    const until = unknownIds.get(id);
    if (until !== undefined && until > t) throw new HttpError(404, 'NOT_FOUND', 'Unknown market');
    const ctx = await opts.rest.get('/v1/pub/context', 'context', HISTORY_TTL_MS, contextSchema, charge(request));
    if (ctx.value.markets.some((m) => m.id === id)) return;
    unknownIds.delete(id);
    if (unknownIds.size >= MAX_TRACKED) unknownIds.delete(unknownIds.keys().next().value!);
    unknownIds.set(id, t + UNKNOWN_MARKET_TTL_MS);
    throw new HttpError(404, 'NOT_FOUND', 'Unknown market');
  }

  scope.get('/context', { config }, async (request, reply) => {
    noQuery.parse(request.query);
    const r = await opts.rest.get('/v1/pub/context', 'context', HISTORY_TTL_MS, contextSchema, charge(request));
    return sendCached(reply, HISTORY_TTL_MS, r);
  });

  scope.get('/ticker/:id', { config }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    noQuery.parse(request.query);
    const fresh = live.has(id) ? opts.store?.getFreshState(id) : null;
    if (fresh) return send(reply, LIVE_TTL_MS, 'LIVE', false, fresh.ageMs, { mt: MT.MARKET_STATE, sn: fresh.sn, d: { [id]: fresh.state } });
    await assertKnownMarket(request, id);
    const r = await opts.rest.get(`/v1/market-data/${id}/ticker`, 'live', LIVE_TTL_MS, tickerSchema, charge(request));
    return sendCached(reply, LIVE_TTL_MS, r);
  });

  scope.get('/book/:id', { config }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { levels = MAX_BOOK_LEVELS } = bookQuery.parse(request.query);
    const feed = live.has(id) ? opts.store?.feedHealth() : undefined;
    const book = feed?.fresh ? opts.store!.getBook(id, levels) : null;
    if (book) return send(reply, LIVE_TTL_MS, 'LIVE', false, feed!.heartbeatAgeMs ?? 0, { mt: MT.BOOK_SNAPSHOT, ...book });
    await assertKnownMarket(request, id);
    // Always fetch the max depth so every `levels` value shares one cache entry.
    const r = await opts.rest.get(`/v1/market-data/${id}/book?levels=${MAX_BOOK_LEVELS}`, 'live', LIVE_TTL_MS, bookSchema, charge(request));
    const v = r.value;
    return sendCached(reply, LIVE_TTL_MS, r, { ...v, bid: v.bid.slice(0, levels), ask: v.ask.slice(0, levels) });
  });

  scope.get('/candles/:id/:res/:from-:to', { config }, async (request, reply) => {
    const p = candleParams.parse(request.params);
    noQuery.parse(request.query);
    const w = canonicalWindow(p.from, p.to, p.res * 1000, CANDLE_WINDOW, now(), 'candles');
    await assertKnownMarket(request, p.id);
    const r = await opts.rest.get(`/v1/market-data/${p.id}/candles/${p.res}/${w.from}-${w.to}`, 'history', HISTORY_TTL_MS, candleSeriesSchema, charge(request));
    return sendCached(reply, HISTORY_TTL_MS, r);
  });

  scope.get('/funding/:id/:from-:to', { config }, async (request, reply) => {
    const p = fundingParams.parse(request.params);
    noQuery.parse(request.query);
    const w = canonicalWindow(p.from, p.to, HOUR_MS, FUNDING_WINDOW, now(), 'hours');
    await assertKnownMarket(request, p.id);
    const r = await opts.rest.get(`/v1/market-data/${p.id}/funding/${w.from}-${w.to}`, 'history', HISTORY_TTL_MS, fundingSeriesSchema, charge(request));
    return sendCached(reply, HISTORY_TTL_MS, r);
  });
};
