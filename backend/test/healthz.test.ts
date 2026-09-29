import { afterEach, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/lib/db.ts';
import { buildTestApp } from './helpers.ts';

const NOW_MS = 1_790_000_000_000;
const now = () => NOW_MS;
const nowS = BigInt(NOW_MS / 1000);

describe('GET /healthz', () => {
  let app: FastifyInstance;
  let db: Database;
  afterEach(async () => app?.close());

  test('200 with head and db when dependencies are up', async () => {
    ({ app } = await buildTestApp({ now, readHead: async () => ({ number: 110_656_363n, timestamp: nowS - 1n }) }));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body: unknown = res.json();
    expect(body).toEqual({
      success: true,
      error: null,
      data: {
        status: 'ok',
        service: 'relay',
        db: 'ok',
        chain: { id: 143, head: '110656363', headAgeS: 1 }
      }
    });
  });

  test('503 degraded when the RPC fails, without leaking the error', async () => {
    ({ app } = await buildTestApp({
      now,
      readHead: async () => {
        throw new Error('HTTP request failed. URL: https://x.quiknode.pro/SECRET_KEY');
      }
    }));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('SECRET_KEY');
    expect(res.json()).toMatchObject({
      success: false,
      error: { code: 'DEGRADED' },
      data: { status: 'degraded', chain: { head: null, headAgeS: null } }
    });
  });

  test('503 when the head is stale', async () => {
    ({ app } = await buildTestApp({ now, readHead: async () => ({ number: 1n, timestamp: nowS - 120n }) }));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().data.chain.headAgeS).toBe(120);
  });

  test('503 when the database is unavailable', async () => {
    ({ app, db } = await buildTestApp({ now, readHead: async () => ({ number: 1n, timestamp: nowS }) }));
    db.close();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().data.db).toBe('error');
  });

  test('caches the head so probes cannot amplify RPC load', async () => {
    let calls = 0;
    ({ app } = await buildTestApp({
      now,
      readHead: async () => {
        calls++;
        return { number: 1n, timestamp: nowS };
      }
    }));
    await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: 'GET', url: '/healthz' })));
    await app.inject({ method: 'GET', url: '/healthz' });
    expect(calls).toBe(1);
  });
});
