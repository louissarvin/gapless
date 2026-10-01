import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { writeJsonAtomic } from '../src/jobs/output.ts';
import { GAP_INDEX_CACHE_MS, GAP_INDEX_STALE_AFTER_MS } from '../src/relay/routes/gapIndex.ts';
import { APP_ORIGIN, buildTestApp } from './helpers.ts';

const T0 = Date.parse('2026-10-05T12:00:00Z');
let app: FastifyInstance;
let dir: string;
let clock = T0;

async function setup() {
  dir = mkdtempSync(join(tmpdir(), 'gapless-gi-'));
  clock = T0;
  // Wired by buildRelayApp from GAP_INDEX_DIR.
  ({ app } = await buildTestApp({ env: { GAP_INDEX_DIR: dir }, now: () => clock }));
}

afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, origin: string | null = APP_ORIGIN) =>
  app.inject({ method: 'GET', url: `/api/gap-index/${path}`, headers: origin === null ? {} : { origin } });

// Test-only document; real ones come from the jobs process.
const doc = (generatedAt: string, extra: object = {}) => ({ schemaVersion: 1, generatedAt, perps: [], ...extra });

describe('GET /api/gap-index/*', () => {
  test('rejects foreign or missing Origin', async () => {
    await setup();
    expect((await get('summary', 'https://evil.example')).statusCode).toBe(403);
    expect((await get('summary', null)).statusCode).toBe(403);
  });

  test('503 with a clear code until the job has produced output', async () => {
    await setup();
    const res = await get('summary');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      success: false,
      data: null,
      error: { code: 'GAP_INDEX_NOT_READY', message: 'Gap Index data is not available yet' }
    });
  });

  test('serves each document with a 60 s cache header', async () => {
    await setup();
    for (const [name, file] of [
      ['summary', 'summary.json'],
      ['gaps', 'gaps.json'],
      ['staleness', 'staleness.json'],
      ['premium-curve', 'premium-curve.json'],
      ['native-stops', 'native-stops.json']
    ] as const) {
      await writeJsonAtomic(dir, file, doc('2026-10-05T11:58:00.000Z', { name }));
      const res = await get(name);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      const body: unknown = res.json();
      expect(body).toEqual({
        success: true,
        error: null,
        data: { ...doc('2026-10-05T11:58:00.000Z', { name }), stale: false }
      });
    }
  });

  test('holds a document for 60 s, then picks up the new file', async () => {
    await setup();
    await writeJsonAtomic(dir, 'gaps.json', doc('2026-10-05T11:55:00.000Z', { v: 1 }));
    expect((await get('gaps')).json().data.v).toBe(1);
    await writeJsonAtomic(dir, 'gaps.json', doc('2026-10-05T12:00:00.000Z', { v: 2 }));
    clock += GAP_INDEX_CACHE_MS - 1;
    expect((await get('gaps')).json().data.v).toBe(1);
    clock += 2;
    expect((await get('gaps')).json().data.v).toBe(2);
  });

  test('a missing file is re-checked within seconds, not a full minute', async () => {
    await setup();
    expect((await get('staleness')).statusCode).toBe(503);
    await writeJsonAtomic(dir, 'staleness.json', doc('2026-10-05T12:00:00.000Z'));
    clock += 5_001;
    expect((await get('staleness')).statusCode).toBe(200);
  });

  test('flags data older than 15 min as stale', async () => {
    await setup();
    await writeJsonAtomic(dir, 'summary.json', doc(new Date(T0 - GAP_INDEX_STALE_AFTER_MS - 1).toISOString()));
    expect((await get('summary')).json().data.stale).toBe(true);
  });

  test('a corrupt or foreign file is a 503, never echoed', async () => {
    await setup();
    writeFileSync(join(dir, 'summary.json'), '{"schemaVersion":1,"generatedAt":');
    writeFileSync(join(dir, 'gaps.json'), JSON.stringify({ schemaVersion: 2, generatedAt: '2026-10-05T12:00:00Z' }));
    for (const name of ['summary', 'gaps']) {
      const res = await get(name);
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('schemaVersion');
    }
  });

  test('unknown documents are 404 and paths cannot escape the output dir', async () => {
    await setup();
    expect((await get('fit')).statusCode).toBe(404);
    expect((await get('..%2F..%2Fetc%2Fpasswd')).statusCode).toBe(404);
  });

  test('rate limited per IP', async () => {
    await setup();
    await writeJsonAtomic(dir, 'summary.json', doc('2026-10-05T12:00:00.000Z'));
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await get('summary')).statusCode);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes[60]).toBe(429);
  });
});
