import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { writeJsonAtomic } from '../src/jobs/output.ts';
import { STATS_CACHE_MS, STATS_STALE_AFTER_MS } from '../src/relay/routes/stats.ts';
import { APP_ORIGIN, buildTestApp } from './helpers.ts';

const T0 = Date.parse('2026-10-06T12:00:00Z');
let app: FastifyInstance;
let dir: string;
let clock = T0;

async function setup() {
  dir = mkdtempSync(join(tmpdir(), 'gapless-stats-'));
  clock = T0;
  ({ app } = await buildTestApp({ env: { GAP_INDEX_DIR: dir }, now: () => clock }));
}

afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (origin: string | null = APP_ORIGIN, url = '/api/stats') => app.inject({ method: 'GET', url, headers: origin === null ? {} : { origin } });

// Test-only document in the section 6 contract shape; real ones come from the jobs process.
const statsDoc = (generatedAt: string) => ({
  schemaVersion: 1,
  methodVersion: 'gapless-gap-index/4',
  method: { gapless: { covers: 'test' }, perplNativeStops: 'test' },
  generatedAt,
  window: { fromBlock: 100, toBlock: 2_000 },
  gapless: {
    covers: { total: 3, live: 1, armed: 0, triggered: 0, finalized: 1, expired: 1, cancelled: 0, voided: 0 },
    owners: 2,
    accounts: 2,
    notionalCoveredCNS: '30760000',
    premiums: { escrowToVaultCNS: '350000', rentCNS: '60000', toLpsCNS: '54000', toTreasuryCNS: '6000' },
    payouts: { count: 1, paidCNS: '1500000', owedCNS: '0' },
    armToTriggerBlocks: { n: 1, p50: 3, max: 3 },
    vault: { totalAssetsCNS: '25000000', lpCount: 1, utilizationBps: 1234 },
    cre: { reports: 2, armed: 1, triggered: 1 },
    firsts: { deployTx: `0x${'aa'.repeat(32)}`, firstCoverTx: null, firstTriggerTx: null },
    undecodedLogs: 0
  },
  perplNativeStops: {
    window: { fromBlock: 10, toBlock: 2_000 },
    executions: 574,
    joinRate: 0.58,
    slippageVsTriggerBps: { p50: 4.9, p95: 54.3 },
    delayBlocks: { p50: 4, p95: 4 }
  }
});

describe('GET /api/stats', () => {
  test('rejects foreign or missing Origin', async () => {
    await setup();
    expect((await get('https://evil.example')).statusCode).toBe(403);
    expect((await get(null)).statusCode).toBe(403);
  });

  test('503 STATS_NOT_READY until jobs write stats.json (deploy addresses unset or nothing indexed yet)', async () => {
    await setup();
    const res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ success: false, data: null, error: { code: 'STATS_NOT_READY' } });
  });

  test('serves the contract shape with a 60 s cache header and stale flag; unknown keys are dropped', async () => {
    await setup();
    await writeJsonAtomic(dir, 'stats.json', { ...statsDoc('2026-10-06T11:58:00.000Z'), internalPath: '/app/data', gapless: { ...statsDoc('').gapless, extra: 1 } });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(`public, max-age=${STATS_CACHE_MS / 1000}`);
    const body: unknown = res.json();
    expect(body).toEqual({ success: true, error: null, data: { ...statsDoc('2026-10-06T11:58:00.000Z'), stale: false } });
  });

  test('stale after 15 min; cached 60 s; a missing file is re-checked within seconds', async () => {
    await setup();
    expect((await get()).statusCode).toBe(503);
    await writeJsonAtomic(dir, 'stats.json', statsDoc(new Date(T0 - STATS_STALE_AFTER_MS - 1).toISOString()));
    clock += 5_001;
    expect((await get()).json().data.stale).toBe(true);
    await writeJsonAtomic(dir, 'stats.json', { ...statsDoc(new Date(clock).toISOString()), window: { fromBlock: 100, toBlock: 3_000 } });
    expect((await get()).json().data.window.toBlock).toBe(2_000);
    clock += STATS_CACHE_MS + 1;
    expect((await get()).json().data).toMatchObject({ window: { toBlock: 3_000 }, stale: false });
  });

  test('a corrupt or off-contract file is a 503, never echoed', async () => {
    await setup();
    writeFileSync(join(dir, 'stats.json'), JSON.stringify({ ...statsDoc('2026-10-06T12:00:00Z'), gapless: { ...statsDoc('').gapless, notionalCoveredCNS: 'lots' } }));
    const res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('lots');
  });

  test('other methods are 404; rate limited at 60/min per IP', async () => {
    await setup();
    await writeJsonAtomic(dir, 'stats.json', statsDoc('2026-10-06T12:00:00.000Z'));
    expect((await app.inject({ method: 'POST', url: '/api/stats', headers: { origin: APP_ORIGIN } })).statusCode).toBe(404);
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await get()).statusCode);
    expect(codes.slice(0, 59).every((c) => c === 200)).toBe(true);
    expect(codes[60]).toBe(429);
  });
});
