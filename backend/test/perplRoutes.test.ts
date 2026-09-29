import { afterEach, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { openDb } from '../src/lib/db.ts';
import { buildRelayApp } from '../src/relay/app.ts';
import { PerplRestClient, type FetchLike } from '../src/relay/perpl/rest.ts';
import { MarketStore } from '../src/relay/perpl/store.ts';
import { parseFrame } from '../src/relay/perpl/types.ts';
import { MISS_BUDGET_PER_MIN, UNKNOWN_MARKET_TTL_MS } from '../src/relay/routes/perpl.ts';
import { APP_ORIGIN, relayEnv, testClient } from './helpers.ts';
import { loadRestFixture, loadWsFixture } from './perplFixtures.ts';

// Bodies captured from https://app.perpl.xyz/api/v1 on 2026-10-05.
const BODIES: Record<string, string> = {
  '/v1/pub/context': loadRestFixture('context.json'),
  '/v1/market-data/1/ticker': loadRestFixture('ticker_1.json'),
  '/v1/market-data/1/book?levels=20': loadRestFixture('book_1_levels20.json')
};
const CANDLES = loadRestFixture('candles_1_3600.json');
const FUNDING = loadRestFixture('funding_1.json');
const NOW = 1_791_181_970_000;
const H = { origin: APP_ORIGIN };

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Upstream double: answers from captured bodies and records exactly what was sent. */
function fakeUpstream(opts: { delayMs?: number; status?: number; body?: string; hang?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    if (opts.hang) {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (opts.delayMs) await Bun.sleep(opts.delayMs);
    const path = url.replace('https://perpl.test/api', '');
    const body =
      opts.body ?? BODIES[path] ?? (path.includes('/candles/') ? CANDLES : path.includes('/funding/') ? FUNDING : undefined);
    if (opts.status && opts.status !== 200) return new Response('Bad Request', { status: opts.status });
    if (body === undefined) return new Response('Bad Request', { status: 400 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

describe('/api/perpl proxy', () => {
  let app: FastifyInstance;
  let t = NOW;
  afterEach(async () => {
    await app?.close();
    t = NOW;
  });

  async function build(
    up = fakeUpstream(),
    restOpts: Partial<ConstructorParameters<typeof PerplRestClient>[0]> = {},
    marketStore?: MarketStore
  ) {
    const log = pino({ level: 'silent' });
    const now = () => t;
    const rest = new PerplRestClient({ baseUrl: 'https://perpl.test/api', log, fetch: up.fetchImpl, now, ...restOpts });
    app = await buildRelayApp({
      env: relayEnv({ RATE_LIMIT_MAX: '1000' }),
      log,
      db: openDb(':memory:'),
      client: testClient(),
      readHead: async () => ({ number: 1n, timestamp: BigInt(Math.floor(t / 1000)) }),
      perplRest: rest,
      marketStore,
      now
    });
    return { up, rest };
  }

  const get = (url: string, headers: Record<string, string> = H, remoteAddress?: string) =>
    app.inject({ method: 'GET', url, headers, ...(remoteAddress ? { remoteAddress } : {}) });

  /** Live store fed from the captured WS frames, on the test clock. */
  function liveStore() {
    const store = new MarketStore({ now: () => t });
    for (const raw of loadWsFixture()) {
      const r = parseFrame(raw);
      if (r.ok) store.apply(r.frame);
    }
    store.setConnected(true);
    return store;
  }

  test('rejects foreign or missing Origin before any upstream call', async () => {
    const { up } = await build();
    for (const headers of [{ origin: 'https://evil.test' }, {}] as Record<string, string>[]) {
      const res = await get('/api/perpl/context', headers);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN_ORIGIN');
    }
    expect(up.calls).toHaveLength(0);
  });

  test('serves the captured context in the standard envelope', async () => {
    await build();
    const res = await get('/api/perpl/context');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ...JSON.parse(BODIES['/v1/pub/context']!), stale: false, ageMs: 0 });
    expect(res.headers['cache-control']).toBe('max-age=30');
    // Responses differ by Origin (200 vs 403), so shared caches must key on it.
    expect(res.headers.vary).toContain('Origin');
    expect((await get('/api/perpl/context', { origin: 'https://evil.test' })).headers.vary).toContain('Origin');
  });

  test.each([
    '/api/perpl/trading/orders',
    '/api/perpl/v1/pub/context',
    '/api/perpl/profile/ref-code',
    '/api/perpl/api-key/payload',
    '/api/perpl/ticker',
    '/api/perpl/..%2F..%2Ftrading%2Fwallet',
    '/api/perpl/book/1/../../trading/orders'
  ])('allowlist: %s is not proxied', async (url) => {
    const { up } = await build();
    const res = await get(url);
    expect([400, 404]).toContain(res.statusCode);
    expect(up.calls).toHaveLength(0);
  });

  test.each([
    ['/api/perpl/book/0', 'id'],
    ['/api/perpl/book/abc', 'id'],
    ['/api/perpl/book/1?levels=21', 'levels'],
    ['/api/perpl/book/1?levels=0', 'levels'],
    ['/api/perpl/book/1?levels=1e1', 'levels'],
    ['/api/perpl/book/1?depth=5', ''],
    ['/api/perpl/ticker/1?x=1', ''],
    ['/api/perpl/candles/1/61/1791100000000-1791180000000', 'res'],
    ['/api/perpl/candles/1/60/1791180000000-1791100000000', 'from'],
    ['/api/perpl/candles/1/60/1700000000000-1791180000000', 'to'],
    ['/api/perpl/candles/1/60/1791180000000-9999999999999', 'to'],
    ['/api/perpl/funding/1/1700000000000-1791180000000', 'to']
  ])('validation: %s is rejected', async (url, path) => {
    const { up } = await build();
    const res = await get(url);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    if (path) expect(res.json().error.details.map((d: { path: string }) => d.path)).toContain(path);
    expect(up.calls).toHaveLength(0);
  });

  test('never forwards client headers; sends a fixed GET', async () => {
    const { up } = await build();
    await get('/api/perpl/ticker/1', {
      ...H,
      authorization: 'Bearer secret',
      'x-api-key': 'k',
      'x-api-signature': 's',
      cookie: 'c=1',
      'x-forwarded-for': '1.2.3.4'
    });
    expect(up.calls).toEqual([{ url: 'https://perpl.test/api/v1/market-data/1/ticker', headers: { accept: 'application/json' } }]);
  });

  test('book: always fetches 20 levels, slices to the requested depth, shares one cache entry', async () => {
    const { up } = await build();
    const five = await get('/api/perpl/book/1?levels=5');
    const all = await get('/api/perpl/book/1');
    expect(five.json().data.bid).toHaveLength(5);
    expect(five.json().data.ask).toHaveLength(5);
    expect(all.json().data.bid).toHaveLength(20);
    expect(up.calls.map((c) => c.url)).toEqual(['https://perpl.test/api/v1/market-data/1/book?levels=20']);
    expect(all.headers['x-cache']).toBe('HIT');
  });

  test('cache: 1 s for ticker, refetch after expiry', async () => {
    const { up } = await build();
    expect((await get('/api/perpl/ticker/1')).headers['x-cache']).toBe('MISS');
    t += 999;
    expect((await get('/api/perpl/ticker/1')).headers['x-cache']).toBe('HIT');
    t += 2;
    expect((await get('/api/perpl/ticker/1')).headers['x-cache']).toBe('MISS');
    expect(up.calls).toHaveLength(2);
  });

  test('coalescing: concurrent misses share one upstream request', async () => {
    const { up } = await build(fakeUpstream({ delayMs: 30 }));
    const results = await Promise.all(Array.from({ length: 8 }, () => get('/api/perpl/ticker/1')));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(up.calls).toHaveLength(1);
  });

  test('candles: canonical window (to on a 64-candle grid, span from a fixed set) so callers share a key', async () => {
    const { up } = await build();
    const a = await get('/api/perpl/candles/1/3600/1791095570000-1791181970000');
    const b = await get('/api/perpl/candles/1/3600/1791095571234-1791181969999');
    // A longer span inside the same 256-candle window shares the key too.
    const c = await get('/api/perpl/candles/1/3600/1790600000000-1791181970000');
    expect(a.statusCode).toBe(200);
    expect(b.headers['x-cache']).toBe('HIT');
    expect(c.headers['x-cache']).toBe('HIT');
    expect(up.calls.map((x) => x.url)).toEqual(['https://perpl.test/api/v1/market-data/1/candles/3600/1790438400000-1791360000000']);
    expect(a.json().data.r).toBe(3600);
  });

  test('history: `to` past the current grid bucket is rejected without an upstream call', async () => {
    const { up } = await build();
    const res = await get(`/api/perpl/candles/1/60/${NOW}-${NOW + 2 * 64 * 60_000}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.map((d: { path: string }) => d.path)).toContain('to');
    expect((await get(`/api/perpl/funding/1/${NOW - 86_400_000}-${NOW + 2 * 3_600_000}`)).statusCode).toBe(400);
    expect(up.calls).toHaveLength(0);
  });

  test('funding: proxies the captured series', async () => {
    await build();
    const res = await get('/api/perpl/funding/1/1791095570000-1791181970000');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.m).toBe(1);
    expect(res.json().data.d.length).toBeGreaterThan(0);
  });

  test('unknown market: ids missing from the context are 404 without an upstream market call', async () => {
    const { up } = await build();
    for (const url of ['/api/perpl/ticker/777', '/api/perpl/book/778', `/api/perpl/candles/779/60/${NOW - 3_600_000}-${NOW}`]) {
      const res = await get(url);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    expect(up.calls.map((c) => c.url)).toEqual(['https://perpl.test/api/v1/pub/context']);
    // Negative-cached past the context TTL: no context refetch for the same junk id.
    t += 31_000;
    expect((await get('/api/perpl/ticker/777')).statusCode).toBe(404);
    expect(up.calls).toHaveLength(1);
    t += UNKNOWN_MARKET_TTL_MS;
    expect((await get('/api/perpl/ticker/777')).statusCode).toBe(404);
    expect(up.calls).toHaveLength(2);
  });

  test('a listed market the upstream rejects is negative-cached for at least 60 s', async () => {
    const { up } = await build();
    // Market 20 is in the captured context but the fake has no ticker for it (upstream 400).
    expect((await get('/api/perpl/ticker/20')).json().error.code).toBe('UPSTREAM_REJECTED');
    t += 59_000;
    expect((await get('/api/perpl/ticker/20')).statusCode).toBe(400);
    const tickerCalls = () => up.calls.filter((c) => c.url.endsWith('/20/ticker')).length;
    expect(tickerCalls()).toBe(1);
    t += 2_000;
    await get('/api/perpl/ticker/20');
    expect(tickerCalls()).toBe(2);
  });

  test('configured markets: ticker and book come from the live WS store, not the upstream budget', async () => {
    const store = liveStore();
    const { up } = await build(fakeUpstream(), {}, store);
    const ticker = await get('/api/perpl/ticker/1');
    expect(ticker.statusCode).toBe(200);
    expect(ticker.headers['x-cache']).toBe('LIVE');
    expect(ticker.json().data).toMatchObject({ mt: 9, stale: false, d: { '1': { mrk: store.getQuote(1)!.mark } } });
    const book = await get('/api/perpl/book/1?levels=3');
    expect(book.json().data).toMatchObject({ mt: 15, stale: false });
    expect(book.json().data.bid).toHaveLength(3);
    expect(book.json().data.bid[0].p).toBe(store.getBookTop(1)!.bid!.p);
    expect(up.calls).toHaveLength(0);
    // A stale feed falls back to the REST proxy.
    t += 11_000;
    expect((await get('/api/perpl/ticker/1')).headers['x-cache']).toBe('MISS');
    expect(up.calls).toHaveLength(1);
  });

  test('per-client miss budget: one IP (IPv6 /64) cannot spend the shared upstream budget', async () => {
    const { up } = await build();
    const res = [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400];
    const v6 = (i: number) => `2001:db8:dead:beef::${i + 1}`;
    for (let i = 0; i < MISS_BUDGET_PER_MIN; i++) {
      expect((await get(`/api/perpl/candles/1/${res[i]}/${NOW - 3_600_000}-${NOW}`, H, v6(i))).statusCode).toBe(200);
    }
    const capped = await get(`/api/perpl/funding/1/${NOW - 86_400_000}-${NOW}`, H, v6(99));
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.code).toBe('RATE_LIMITED');
    // Cache hits are free, and another client still gets misses.
    expect((await get(`/api/perpl/candles/1/60/${NOW - 3_600_000}-${NOW}`, H, v6(5))).statusCode).toBe(200);
    expect((await get(`/api/perpl/funding/1/${NOW - 86_400_000}-${NOW}`, H, '2001:db8:dead:bef0::1')).statusCode).toBe(200);
    expect(up.calls).toHaveLength(MISS_BUDGET_PER_MIN + 1);
  });

  test('timeout: a hung upstream becomes 502 without leaking details', async () => {
    await build(fakeUpstream({ hang: true }), { timeoutMs: 30 });
    const res = await get('/api/perpl/ticker/1');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', message: 'Market data temporarily unavailable' });
    expect(res.body).not.toContain('perpl.test');
  });

  test('upstream body that fails the schema is not served', async () => {
    await build(fakeUpstream({ body: '{"mt":9,"sn":1,"d":{"1":{"orl":"<script>"}}}' }));
    const res = await get('/api/perpl/ticker/1');
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('script');
  });

  test('oversized upstream body is refused', async () => {
    await build(fakeUpstream(), { maxBodyBytes: 1024 });
    expect((await get('/api/perpl/context')).statusCode).toBe(502);
  });

  test('serves a recent stale value when the upstream fails, then gives up', async () => {
    let healthy = true;
    const good = fakeUpstream();
    await build({
      calls: good.calls,
      fetchImpl: async (url, init) => {
        if (!healthy) throw new Error('ECONNRESET');
        return good.fetchImpl(url, init);
      }
    });
    expect((await get('/api/perpl/ticker/1')).headers['x-cache']).toBe('MISS');
    healthy = false;
    t += 5_000;
    const stale = await get('/api/perpl/ticker/1');
    expect(stale.statusCode).toBe(200);
    expect(stale.headers['x-cache']).toBe('STALE');
    expect(stale.json().data).toMatchObject({ stale: true, ageMs: 5_000 });
    t += 61_000;
    expect((await get('/api/perpl/ticker/1')).statusCode).toBe(502);
  });

  test('per-class upstream budget: a flood of history keys cannot use the live budget', async () => {
    const { up } = await build(fakeUpstream(), { budgets: { history: 2, live: 5 } });
    const urls = [60, 300, 900].map((res) => `/api/perpl/candles/1/${res}/${NOW - 3_600_000}-${NOW}`);
    expect((await get(urls[0]!)).statusCode).toBe(200);
    expect((await get(urls[1]!)).statusCode).toBe(200);
    const busy = await get(urls[2]!);
    expect(busy.statusCode).toBe(503);
    expect(busy.json().error.code).toBe('UPSTREAM_BUSY');
    expect((await get('/api/perpl/ticker/1')).statusCode).toBe(200);
    expect(up.calls).toHaveLength(3);
  });

  test('rate limit: 60 requests per minute per IP across all proxy routes', async () => {
    await build();
    for (let i = 0; i < 59; i++) expect((await get('/api/perpl/ticker/1')).statusCode).toBe(200);
    expect((await get('/api/perpl/context')).statusCode).toBe(200);
    const limited = await get('/api/perpl/book/1');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    // Other routes keep their own (global) budget.
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});
