import { afterEach, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { openDb } from '../src/lib/db.ts';
import { buildRelayApp } from '../src/relay/app.ts';
import type { MarketDataHealth } from '../src/relay/healthz.ts';
import { MAX_FEED_LAG_BLOCKS } from '../src/relay/perpl/store.ts';
import { relayEnv, testClient } from './helpers.ts';

const NOW_MS = 1_790_000_000_000;
// Test-only value; production reads RELAY_INTERNAL_TOKEN from env.
const TOKEN = 'h'.repeat(40);

const healthy: MarketDataHealth = {
  upstream: 'connected',
  lastMessageAgeMs: 320,
  headBlock: 110_681_559,
  feedLagBlocks: 2,
  reconnects: 2,
  clients: { public: 7, internal: 1 },
  missingStreams: []
};

describe('GET /healthz market data', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(market: MarketDataHealth) {
    app = await buildRelayApp({
      env: relayEnv({ RELAY_INTERNAL_TOKEN: TOKEN }),
      log: pino({ level: 'silent' }),
      db: openDb(':memory:'),
      client: testClient(),
      readHead: async () => ({ number: 1n, timestamp: BigInt(NOW_MS / 1000) }),
      marketData: () => market,
      now: () => NOW_MS
    });
  }

  test('public body hides client counts, reconnects and uptime', async () => {
    await build(healthy);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.marketData).toEqual({ upstream: 'connected', lastMessageAgeMs: 320, headBlock: 110_681_559, feedLagBlocks: 2 });
    expect(res.json().data).not.toHaveProperty('uptimeS');
    expect(res.body).not.toContain('clients');
  });

  test('the internal token gets the full body; a wrong token gets the public one', async () => {
    await build(healthy);
    const full = await app.inject({ method: 'GET', url: '/healthz', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(full.json().data.marketData).toEqual(healthy);
    expect(full.json().data.uptimeS).toBe(0);
    const wrong = await app.inject({ method: 'GET', url: '/healthz', headers: { authorization: `Bearer ${'x'.repeat(40)}` } });
    expect(wrong.body).not.toContain('clients');
  });

  test.each<[string, Partial<MarketDataHealth>]>([
    ['upstream down', { upstream: 'down' }],
    ['still connecting', { upstream: 'connecting', lastMessageAgeMs: null, headBlock: null }],
    ['stale feed', { lastMessageAgeMs: 10_001 }],
    ['partial subscription', { upstream: 'partial', missingStreams: ['trades@10'] }],
    ['Perpl lagging the chain', { feedLagBlocks: MAX_FEED_LAG_BLOCKS + 1 }]
  ])('503 degraded when %s', async (_name, patch) => {
    const market = { ...healthy, ...patch };
    await build(market);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'DEGRADED' }, data: { status: 'degraded', marketData: { upstream: market.upstream } } });
  });
});
