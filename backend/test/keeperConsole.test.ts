import { afterEach, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { getAddress, type Hex } from 'viem';
import { migrate, openDb } from '../src/lib/db.ts';
import type { ContractSend, SendOutcome, SendQueue } from '../src/lib/sendQueue.ts';
import { SpendGovernor } from '../src/lib/spendGovernor.ts';
import { buildConsole, CONSOLE_RECENT_MAX, exemptUsedWei, observeSends, SendRecorder, type ConsoleDeps } from '../src/keeper/console.ts';
import { KEEPER_MIGRATIONS } from '../src/keeper/migrations.ts';
import { keeperHandler } from '../src/keeper/server.ts';
import { CONSOLE_CACHE_MS, CONSOLE_MAX_BYTES } from '../src/relay/routes/keeperConsole.ts';
import { captureLogger } from './fakeChain.ts';
import { APP_ORIGIN, buildTestApp } from './helpers.ts';

// Test-only values throughout: no real keeper, key or RPC.
const TOKEN = 'k'.repeat(48);
const SIGNER = getAddress('0x00000000000000000000000000000000000000c0');
const COVER = `0x${'ab'.repeat(32)}` as Hex;
const HASH = `0x${'cd'.repeat(32)}` as Hex;

const req = (label: string, gas = 2_200_000n, ref: string = COVER): ContractSend =>
  ({ label, gas, ref, address: SIGNER, abi: [], functionName: 'trigger' }) as unknown as ContractSend;

describe('SendRecorder and observeSends (read-only)', () => {
  test('records only sends that reached the chain, newest first, capped at 50', () => {
    const r = new SendRecorder();
    r.record(req('arm', 300_000n), { status: 'skipped', reason: 'not_needed' });
    r.record(req('trigger'), { status: 'confirmed', hash: HASH, nonce: 1, blockNumber: 500n, gasUsed: 2_200_000n, costWei: 1n, logs: [] });
    r.record(req('trigger_zero', 1_100_000n), { status: 'reverted', hash: HASH, nonce: 2, blockNumber: 503n, costWei: 1n });
    r.record(req('observe', 250_000n, 'not-a-cover-id'), { status: 'pending', hash: HASH, nonce: 3 });
    expect(r.recent()).toEqual([
      { block: null, action: 'observe', coverId: null, txHash: HASH, outcome: 'pending', gasLimit: 250_000 },
      { block: 503, action: 'trigger_zero', coverId: COVER, txHash: HASH, outcome: 'reverted', gasLimit: 1_100_000 },
      { block: 500, action: 'trigger', coverId: COVER, txHash: HASH, outcome: 'confirmed', gasLimit: 2_200_000 }
    ]);
    for (let i = 0; i < 80; i++) r.record(req('arm'), { status: 'pending', hash: HASH, nonce: i });
    expect(r.recent()).toHaveLength(CONSOLE_RECENT_MAX);
  });

  test('the wrapped send returns the exact outcome object, even when recording throws', async () => {
    const outcome: SendOutcome = { status: 'confirmed', hash: HASH, nonce: 1, blockNumber: 9n, gasUsed: 1n, costWei: 1n, logs: [] };
    const seen: ContractSend[] = [];
    const queue = { send: async (r: ContractSend) => (seen.push(r), outcome) } as unknown as SendQueue;
    const broken = new SendRecorder();
    broken.record = () => {
      throw new Error('boom');
    };
    const { log, events } = captureLogger();
    observeSends(queue, broken, log);
    const r = req('trigger');
    expect(await queue.send(r)).toBe(outcome);
    expect(seen).toEqual([r]);
    expect(events()).toContain('console.record_failed');
  });
});

describe('console document', () => {
  function deps(over: Partial<ConsoleDeps> = {}): ConsoleDeps {
    return {
      health: () => ({ status: 'ok', alerts: [] }),
      snapshot: () => ({ proposed: '110700000', lagBlocks: 1 }),
      markets: () => [{ perpId: 1, gated: false, maxMatchesClose: 8 }],
      gaps: () => [
        { gapBlocks: 2, path: 'lane' },
        { gapBlocks: 4, path: 'cycle' },
        { gapBlocks: 1, path: 'lane' }
      ],
      queueStatus: () => ({ address: SIGNER, balanceWei: '5000000000000000000' }),
      usage: () => ({ day: '2026-10-06', committedWei: 100n, capWei: 4_500n, hotReserveWei: 2_500n, alertWei: 3_600n }),
      exemptUsed: () => 60n,
      liveCounts: async () => new Map([[1, 2]]),
      recorder: new SendRecorder(),
      startedAtMs: 1_000,
      now: () => 61_999,
      ...over
    };
  }

  test('builds exactly the contract fields from read-only inputs', async () => {
    expect(await buildConsole(deps())).toEqual({
      schemaVersion: 1,
      status: 'up',
      head: { block: 110_700_000, lagBlocks: 1 },
      signer: { address: SIGNER, balanceWei: '5000000000000000000' },
      governor: { utcDay: '2026-10-06', capWei: '4500', usedWei: '100', exemptUsedWei: '60', remainingWei: '4400' },
      markets: [{ perpId: 1, gated: false, maxMatchesClose: 8, liveCovers: 2 }],
      recent: [],
      walks: { samples: 3, chainGapP50: 2, chainGapMax: 4, laneShare: 0.6667 },
      uptimeS: 60
    });
  });

  test('status: heads down or stale is down, other alerts degraded; empty inputs read as nulls', async () => {
    expect((await buildConsole(deps({ health: () => ({ status: 'degraded', alerts: ['head_stale'] }) }))).status).toBe('down');
    expect((await buildConsole(deps({ health: () => ({ status: 'degraded', alerts: ['low_balance'] }) }))).status).toBe('degraded');
    const empty = await buildConsole(
      deps({ snapshot: () => ({ proposed: null, lagBlocks: null }), gaps: () => [], liveCounts: async () => new Map(), usage: () => ({ day: 'd', committedWei: 9n, capWei: 5n, hotReserveWei: 0n, alertWei: 0n }) })
    );
    expect(empty.head).toEqual({ block: null, lagBlocks: null });
    expect(empty.walks).toEqual({ samples: 0, chainGapP50: null, chainGapMax: null, laneShare: null });
    expect(empty.markets[0]!.liveCovers).toBeNull();
    expect(empty.governor.remainingWei).toBe('0');
  });

  test('exempt spend comes from the ledger with the governor accounting (settled at actual, released excluded)', () => {
    const db = openDb(':memory:');
    migrate(db, KEEPER_MIGRATIONS);
    const now = () => Date.parse('2026-10-06T10:00:00Z');
    const g = new SpendGovernor(db, SIGNER, { capWei: 10_000n, hotReserveWei: 5_000n, alertWei: 9_000n }, captureLogger().log, now);
    const a = g.reserve({ action: 'trigger', amountWei: 1_000n, exempt: true });
    const b = g.reserve({ action: 'observe', amountWei: 300n, exempt: true });
    const c = g.reserve({ action: 'trigger', amountWei: 700n, exempt: true });
    g.reserve({ action: 'finalize', amountWei: 400n, exempt: false });
    if (!a.ok || !b.ok || !c.ok) throw new Error('reserve failed');
    g.settle(a.id, 600n);
    g.release(c.id);
    expect(exemptUsedWei(db, SIGNER, '2026-10-06')).toBe(900n);
    expect(exemptUsedWei(db, SIGNER, '2026-10-05')).toBe(0n);
    db.close();
  });
});

describe('keeper GET /console', () => {
  const doc = { schemaVersion: 1, status: 'up' };
  const get = (auth?: string) => new Request('http://127.0.0.1:3702/console', { headers: auth ? { authorization: auth } : {} });

  test('needs the bearer token; serves the builder output; 404 when not wired', async () => {
    const h = keeperHandler({ token: TOKEN, log: captureLogger().log, health: () => ({ status: 'ok' }), requestSigma: () => true, console: async () => doc });
    const anon = await h(get());
    expect(anon.status).toBe(401);
    expect(await anon.text()).not.toContain('schemaVersion');
    expect((await h(get('Bearer wrong-token-wrong-token-wrong-token'))).status).toBe(401);
    const okRes = await h(get(`Bearer ${TOKEN}`));
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual(doc);
    const bare = keeperHandler({ token: TOKEN, log: captureLogger().log, health: () => ({ status: 'ok' }), requestSigma: () => true });
    expect((await bare(get(`Bearer ${TOKEN}`))).status).toBe(404);
    expect((await h(new Request('http://x/console', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(404);
  });

  test('a builder failure is a bare 500, details to the log only', async () => {
    const { log, events } = captureLogger();
    const h = keeperHandler({
      token: TOKEN,
      log,
      health: () => ({ status: 'ok' }),
      requestSigma: () => true,
      console: async () => {
        throw new Error('rpc https://secret.example/abc failed');
      }
    });
    const res = await h(get(`Bearer ${TOKEN}`));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"INTERNAL"}');
    expect(events()).toContain('console.build_failed');
  });
});

describe('relay GET /api/keeper/console', () => {
  let app: FastifyInstance | undefined;
  let clock = 0;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const valid = () => ({
    schemaVersion: 1,
    status: 'up',
    head: { block: 110_700_000, lagBlocks: 0 },
    signer: { address: SIGNER, balanceWei: '5100000000000000000' },
    governor: { utcDay: '2026-10-06', capWei: '4600000000000000000', usedWei: '1', exemptUsedWei: '0', remainingWei: '4599999999999999999' },
    markets: [{ perpId: 1, gated: false, maxMatchesClose: 8, liveCovers: 1 }],
    recent: [{ block: 110_699_990, action: 'trigger', coverId: COVER, txHash: HASH, outcome: 'confirmed', gasLimit: 2_200_000 }],
    walks: { samples: 1, chainGapP50: 2, chainGapMax: 2, laneShare: 1 },
    uptimeS: 3600
  });

  async function setup(respond: (url: string, init: RequestInit) => Promise<Response> | Response, configured = true) {
    const calls: { url: string; auth: string | null }[] = [];
    clock = 0;
    const fetchKeeper = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return respond(url, init ?? {});
    }) as typeof fetch;
    ({ app } = await buildTestApp({
      env: configured
        ? { KEEPER_INTERNAL_URL: 'http://keeper.internal:3702', RELAY_INTERNAL_TOKEN: TOKEN, GAPLESS_FACTORY_ADDRESS: '0x00000000000000000000000000000000000000f1' }
        : {},
      fetchKeeper,
      now: () => clock
    }));
    return calls;
  }
  const get = (origin: string | null = APP_ORIGIN) =>
    app!.inject({ method: 'GET', url: '/api/keeper/console', headers: origin === null ? {} : { origin } });

  test('rejects foreign Origin before calling the keeper', async () => {
    const calls = await setup(() => Response.json(valid()));
    expect((await get('https://evil.example')).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  test('503 KEEPER_CONSOLE_DISABLED without KEEPER_INTERNAL_URL', async () => {
    await setup(() => Response.json(valid()), false);
    expect((await get()).json()).toMatchObject({ error: { code: 'KEEPER_CONSOLE_DISABLED' } });
  });

  test('proxies with the bearer token; the allowlist drops unknown keeper fields at every level', async () => {
    const leaky = {
      ...valid(),
      rpcUrl: 'https://rpc.example/key',
      env: { KEEPER_KEY: '0x01' },
      lastError: 'connect ECONNREFUSED',
      head: { ...valid().head, rpcHead: '1' },
      markets: [{ ...valid().markets[0], params: { secret: true } }],
      recent: [{ ...valid().recent[0], detail: 'nonce too low' }]
    };
    const calls = await setup(() => Response.json(leaky));
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(`public, max-age=${CONSOLE_CACHE_MS / 1000}`);
    const body: unknown = res.json();
    expect(body).toEqual({ success: true, error: null, data: valid() });
    for (const s of ['rpc.example', 'KEEPER_KEY', 'ECONNREFUSED', 'rpcHead', 'secret', 'nonce too low']) expect(res.body).not.toContain(s);
    expect(calls).toEqual([{ url: 'http://keeper.internal:3702/console', auth: `Bearer ${TOKEN}` }]);
  });

  test('2 s cache with single flight; failures are cached too so a down keeper is not hammered', async () => {
    let up = true;
    const calls = await setup(() => (up ? Response.json(valid()) : Promise.reject(new Error('ECONNREFUSED'))));
    await Promise.all([get(), get(), get()]);
    expect(calls).toHaveLength(1);
    up = false;
    clock += CONSOLE_CACHE_MS;
    const down = await get();
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ error: { code: 'KEEPER_UNAVAILABLE', message: 'Keeper console is not available right now' } });
    expect(down.body).not.toContain('ECONNREFUSED');
    expect((await get()).statusCode).toBe(503);
    expect(calls).toHaveLength(2);
  });

  test.each([
    ['keeper 401', () => new Response('{"error":"UNAUTHORIZED"}', { status: 401 })],
    ['off-contract body', () => Response.json({ ...valid(), status: 'exploded' })],
    ['free text in an action', () => Response.json({ ...valid(), recent: [{ ...valid().recent[0], action: 'trigger; rm -rf' }] })],
    ['not JSON', () => new Response('<html>')],
    ['oversized body', () => new Response(JSON.stringify({ ...valid(), pad: 'x'.repeat(CONSOLE_MAX_BYTES) }))]
  ])('503 on %s', async (_n, respond) => {
    await setup(respond);
    const res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('KEEPER_UNAVAILABLE');
  });

  test('rate limited at 30/min per IP', async () => {
    await setup(() => Response.json(valid()));
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await get()).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});
