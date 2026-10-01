import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getAddress, type Abi, type Address, type Hex } from 'viem';
import { ICoverManagerAbi, IGaplessFactoryAbi } from '../src/abi/index.ts';
import { commitNativePage, refreshNativeJoins } from '../src/jobs/native-ingest.ts';
import { encodeEvent } from './jobs/encodeEvent.ts';
import { emptyBatch } from '../src/jobs/rows.ts';
import { commitPage, openJobsDb, openJobsDbReadonly, refreshAccountTotals, upsertPerps } from '../src/jobs/store.ts';
import { ACCOUNT_ID_CACHE_MS, WALLET_CACHE_MS } from '../src/relay/routes/wallet.ts';
import { APP_ORIGIN, buildTestApp } from './helpers.ts';

// Account 4739 owns 0x9a36...5302 on mainnet (getAccountById, read 2026-10-05). Rows below are test-only.
const OWNER = '0x9a3671D471cb6cf535deDbE09a32E6d9B89D5302';
const TX = `0x${'ef'.repeat(32)}` as Hex;

let app: FastifyInstance | undefined;
let dir: string;
let clock = 0;
let resolveCalls: Address[] = [];

async function setup(opts: { seed?: boolean; resolver?: (a: Address) => Promise<bigint | null> } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'gapless-wallet-'));
  const dbPath = join(dir, 'jobs.sqlite');
  if (opts.seed !== false) {
    const db = openJobsDb(dbPath);
    upsertPerps(db, [{ perpId: 1, name: 'BTC Perp', symbol: 'BTC', priceDecimals: 1, lotDecimals: 5, status: 4 }], 't');
    commitPage(
      db,
      {
        ...emptyBatch(),
        positions: [
          {
            block: 110, logIndex: 1, ts: 1_791_180_000, perpId: 1, accountId: 4739, kind: 'open', positionType: 0,
            pricePNS: 860_000, lotBeforeLNS: 0, lotAfterLNS: 116, deltaPnlCNS: null, fundingCNS: null, txHash: TX,
            liqLotLNS: null, posLotLNS: null
          },
          ...Array.from({ length: 5 }, (_, i) => ({
            block: 120 + i, logIndex: 0, ts: 1_791_180_010 + i, perpId: 1, accountId: 4739, kind: 'increase' as const,
            positionType: 0, pricePNS: 860_100, lotBeforeLNS: 116 + i, lotAfterLNS: 117 + i, deltaPnlCNS: null,
            fundingCNS: null, txHash: TX, liqLotLNS: null, posLotLNS: null
          }))
        ]
      },
      { nextBlock: 200, windowFromBlock: 100, coverageFromBlock: 100 },
      't'
    );
    refreshAccountTotals(db, 200);
    db.close();
  }
  clock = 0;
  resolveCalls = [];
  // Wired by buildRelayApp from JOBS_DB_PATH.
  ({ app } = await buildTestApp({
    env: { JOBS_DB_PATH: dbPath },
    now: () => clock,
    resolveAccountId:
      opts.resolver ??
      (async (a) => {
        resolveCalls.push(a);
        return a === OWNER ? 4739n : null;
      })
  }));
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, origin: string | null = APP_ORIGIN) =>
  app!.inject({ method: 'GET', url: `/api/wallet/${path}`, headers: origin === null ? {} : { origin } });

describe('GET /api/wallet/:addr', () => {
  test('rejects foreign Origin before any lookup', async () => {
    await setup();
    expect((await get(OWNER, 'https://evil.example')).statusCode).toBe(403);
    expect(resolveCalls).toEqual([]);
  });

  test.each(['0x123', 'not-an-address', `${OWNER}00`, '0xZZ3671D471cb6cf535deDbE09a32E6d9B89D5302'])(
    'rejects malformed address %p with VALIDATION_ERROR',
    async (addr) => {
      await setup();
      const res = await get(addr);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(resolveCalls).toEqual([]);
    }
  );

  test('rejects unknown query keys and out-of-range limits', async () => {
    await setup();
    expect((await get(`${OWNER}?foo=1`)).statusCode).toBe(400);
    expect((await get(`${OWNER}?limit=0`)).statusCode).toBe(400);
    expect((await get(`${OWNER}?limit=201`)).statusCode).toBe(400);
    expect((await get(`${OWNER}?limit=200`)).statusCode).toBe(200);
  });

  test('returns the history for the resolved account, any address case', async () => {
    await setup();
    const res = await get(OWNER.toLowerCase());
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ address: OWNER, accountId: '4739', window: { fromBlock: 100, toBlock: 200 }, limit: 100 });
    expect(data.totals).toMatchObject({ asOfBlock: 200, positionEvents: { open: 1, increase: 5 } });
    expect(data.positions.at(-1)).toMatchObject({ kind: 'open', side: 'long', symbol: 'BTC', price: '86000', lotsAfter: '0.00116' });
    expect(resolveCalls).toEqual([OWNER]);
  });

  test('404 when the address has no Perpl account', async () => {
    await setup();
    const res = await get('0x000000000000000000000000000000000000dEaD');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  test('caches results for 60 s, including misses', async () => {
    await setup();
    await get(OWNER);
    await get(OWNER);
    await get('0x000000000000000000000000000000000000dEaD');
    await get('0x000000000000000000000000000000000000dEaD');
    expect(resolveCalls.length).toBe(2);
    // After 60 s the history is rebuilt from the database; the account id comes from its own cache.
    const writer = openJobsDb(join(dir, 'jobs.sqlite'));
    writer.run('UPDATE ingest_state SET next_block = 300 WHERE id = 1');
    writer.close();
    expect((await get(OWNER)).json().data.window.toBlock).toBe(200);
    clock += WALLET_CACHE_MS;
    expect((await get(OWNER)).json().data.window.toBlock).toBe(300);
    expect(resolveCalls.length).toBe(2);
  });

  test('the cache is keyed by address only: varying limit reuses one lookup and slices it', async () => {
    await setup();
    const a = (await get(`${OWNER}?limit=2`)).json().data;
    const b = (await get(`${OWNER}?limit=200`)).json().data;
    const c = (await get(`${OWNER.toLowerCase()}?limit=1`)).json().data;
    expect(resolveCalls).toEqual([OWNER]);
    expect([a.limit, a.positions.length, b.limit, b.positions.length, c.positions.length]).toEqual([2, 2, 200, 6, 1]);
    expect(a.positions[0]).toEqual(b.positions[0]); // newest first in every slice
  });

  test('a resolved account id is reused after the result cache expires; misses are not', async () => {
    await setup();
    await get(OWNER);
    await get('0x000000000000000000000000000000000000dEaD');
    clock += WALLET_CACHE_MS;
    await get(OWNER);
    await get('0x000000000000000000000000000000000000dEaD');
    expect(resolveCalls).toEqual([OWNER, '0x000000000000000000000000000000000000dEaD', '0x000000000000000000000000000000000000dEaD']);
    clock += ACCOUNT_ID_CACHE_MS;
    await get(OWNER);
    expect(resolveCalls.filter((a) => a === OWNER)).toHaveLength(2);
  });

  test('a failing chain read is a 503 without leaking the error', async () => {
    await setup({
      resolver: async () => {
        throw new Error('HTTP request failed. URL: https://x.quiknode.pro/SECRET_KEY');
      }
    });
    const res = await get(OWNER);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(res.body).not.toContain('SECRET_KEY');
  });

  test('503 until the jobs database exists', async () => {
    await setup({ seed: false });
    const res = await get(OWNER);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('WALLET_DATA_NOT_READY');
  });

  test('rate limited to 20 per minute per IP', async () => {
    await setup();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await get(OWNER)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  test('reads while the jobs writer holds the database open (shared WAL volume)', async () => {
    await setup();
    const writer = openJobsDb(join(dir, 'jobs.sqlite'));
    try {
      writer.run('UPDATE ingest_state SET next_block = 300 WHERE id = 1');
      const res = await get(OWNER);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.window.toBlock).toBe(300);
    } finally {
      writer.close();
    }
  });
});

describe('jobs database handle used by the relay', () => {
  test('is read-only and never creates the file', () => {
    dir = mkdtempSync(join(tmpdir(), 'gapless-wallet-ro-'));
    const path = join(dir, 'jobs.sqlite');
    expect(() => openJobsDbReadonly(path)).toThrow('jobs database not found');
    openJobsDb(path).close();
    const ro = openJobsDbReadonly(path);
    try {
      expect(() => ro.run('DELETE FROM perps')).toThrow();
      expect(() => ro.run('CREATE TABLE x (a INTEGER)')).toThrow();
    } finally {
      ro.close();
    }
  });
});

describe('W4d: native stops and the Gapless block', () => {
  // Test-only addresses: a Gapless owner whose clone owns Perpl account 4739, and one whose clone has none yet.
  const OWNER2 = getAddress('0x00000000000000000000000000000000000000b2');
  const CLONE2 = getAddress('0x00000000000000000000000000000000000000c2');
  const OWNER3 = getAddress('0x00000000000000000000000000000000000000b3');
  const CLONE3 = getAddress('0x00000000000000000000000000000000000000c3');
  const MANAGER = '0x00000000000000000000000000000000000000a1';
  const FACTORY = '0x00000000000000000000000000000000000000a3';
  const COVER = `0x${'12'.repeat(32)}` as Hex;

  function seedW4d() {
    const db = openJobsDb(join(dir, 'jobs.sqlite'));
    const placement = {
      block: 150, logIndex: 1, ts: 1, txHash: TX, accountId: 4739, perpId: 1, closeType: 2 as const, lotLNS: 116,
      triggerPNS: 850_000, condition: 3, kind: 'market' as const, limitPNS: null, requestId: '0', positionId: '9'
    };
    const execution = {
      block: 160, logIndex: 4, ts: 2, txHash: TX, execFrom: null, calldataMatch: 1, accountId: 4739, perpId: 1, closeType: 2 as const,
      lotLNS: 116, iocLimitPNS: 841_000, orderDescId: '5', filledLNS: 116, fillNotional: String(849_150 * 116), fillVwapPNS: 849_150
    };
    commitNativePage(db, { placements: [placement], cancels: [], executions: [execution], problems: [] }, { nextBlock: 200, windowFromBlock: 100, coverageFromBlock: 100 }, 't');
    refreshNativeJoins(db);
    const ins = db.query(
      `INSERT INTO gapless_logs (block, log_index, ts, tx_hash, address, source, topic0, topic1, topic2, topic3, data)
       VALUES ($block, $logIndex, 1, $tx, $address, $source, $t0, $t1, $t2, $t3, $data)`
    );
    const put = (block: number, source: 'manager' | 'factory', abi: Abi, name: string, args: Record<string, unknown>) => {
      const { topics, data } = encodeEvent(abi, name, args);
      const t = [...topics, null, null, null];
      ins.run({ block, logIndex: 0, tx: TX, address: source === 'manager' ? MANAGER : FACTORY, source, t0: t[0]!, t1: t[1]!, t2: t[2]!, t3: t[3]!, data });
    };
    put(110, 'factory', IGaplessFactoryAbi, 'AccountCreated', { owner: OWNER2, account: CLONE2, operator: OWNER2 });
    put(111, 'factory', IGaplessFactoryAbi, 'AccountCreated', { owner: OWNER3, account: CLONE3, operator: OWNER3 });
    put(120, 'manager', ICoverManagerAbi, 'CoverBought', {
      coverId: COVER, account: CLONE2, perpId: 1n, isLong: true, lots: 116n, stopPNS: 850_000n, maxGapBps: 200n, escrowCNS: 1n, rentCNS: 1n,
      capCNS: 1n, expiryBlock: 9_999n
    });
    db.close();
  }

  test('nativeStops and nativeStopSummary for the resolved account; WALLET_METHOD bumped; no Gapless block', async () => {
    await setup();
    seedW4d();
    const data = (await get(OWNER)).json().data;
    expect(data.method.version).toBe('gapless-wallet/2');
    expect(data.gapless).toBeNull();
    expect(data.nativeStops).toEqual([
      {
        perpId: 1, symbol: 'BTC', side: 'long', triggerPNS: 850_000, condition: 'mark', kind: 'market', lotLNS: 116, lots: '0.00116',
        placedBlock: 150, placedTx: TX, cancelledBlock: null, executedBlock: 160, execTx: TX, fillVwapPNS: 849_150, filledLNS: 116,
        // (850000 - 849150) / 850000 = 10 bps worse for a long close
        slippageVsTriggerBps: 10, slippageVsMarkBps: null, delayBlocks: null, joinStatus: 'joined'
      }
    ]);
    expect(data.nativeStopSummary).toEqual({ count: 1, executed: 1, p50SlippageBps: 10, worstSlippageBps: 10 });
  });

  test('a Gapless owner resolves through its clone and gets its covers', async () => {
    await setup({ resolver: async (addr) => (resolveCalls.push(addr), addr === CLONE2 ? 4739n : null) });
    seedW4d();
    const data = (await get(OWNER2)).json().data;
    expect(resolveCalls).toEqual([OWNER2, CLONE2]);
    expect(data).toMatchObject({ address: OWNER2, accountId: '4739', gapless: { account: CLONE2, owner: OWNER2 } });
    expect(data.gapless.covers).toEqual([{ coverId: COVER, status: 'live', stopPNS: '850000', paidCNS: '0', perpId: 1 }]);
    expect(data.nativeStops).toHaveLength(1);
    // The clone address itself maps to the same block.
    expect((await get(CLONE2)).json().data.gapless).toEqual(data.gapless);
  });

  test('a Gapless owner without a Perpl account yet: 200 with empty Perpl history, not 404', async () => {
    await setup({ resolver: async () => null });
    seedW4d();
    const res = await get(OWNER3);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ accountId: null, totals: null, positions: [], nativeStops: [], gapless: { account: CLONE3, covers: [] } });
    expect(res.json().data.nativeStopSummary).toEqual({ count: 0, executed: 0, p50SlippageBps: null, worstSlippageBps: null });
  });
});
