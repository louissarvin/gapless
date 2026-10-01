import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { migrate, openDb } from '../../src/lib/db.ts';
import { JOBS_MIGRATIONS } from '../../src/jobs/migrations.ts';
import type { Hex } from 'viem';
import { ingest, windowBlocks, type LogPage, type LogSource } from '../../src/jobs/hypersync.ts';
import { emptyBatch, type PositionRow, type RowBatch } from '../../src/jobs/rows.ts';
import {
  acquireLease,
  commitPage,
  getIngestState,
  loadMarks,
  openJobsDb,
  openJobsDbReadonly,
  pruneBefore,
  quarantineSummary,
  readAccountTotals,
  refreshAccountTotals,
  releaseLease,
  upsertPerps
} from '../../src/jobs/store.ts';
import { buildWalletHistory, exitVsMarkBps } from '../../src/jobs/wallet.ts';
import { encodeLog } from './synthetic.ts';

const silent = pino({ level: 'silent' });
const TX = `0x${'ab'.repeat(32)}` as Hex;
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'gapless-jobs-'));
  dirs.push(d);
  return d;
};

function batch(partial: Partial<RowBatch>): RowBatch {
  return { ...emptyBatch(), ...partial };
}
const st = (nextBlock: number, windowFromBlock = 0, coverageFromBlock = windowFromBlock) => ({ nextBlock, windowFromBlock, coverageFromBlock });
const pos = (x: Partial<PositionRow>): PositionRow => ({
  block: 1, logIndex: 0, ts: 1, perpId: 1, accountId: 7, kind: 'decrease', positionType: 0, pricePNS: null,
  lotBeforeLNS: 2, lotAfterLNS: 1, deltaPnlCNS: null, fundingCNS: null, txHash: TX, liqLotLNS: null, posLotLNS: null, ...x
});

describe('store', () => {
  test('commitPage is idempotent and advances the cursor atomically', () => {
    const db = openJobsDb(':memory:');
    const b = batch({ marks: [{ block: 10, logIndex: 0, ts: 100, perpId: 1, pricePNS: 5 }] });
    commitPage(db, b, st(11), 't1');
    commitPage(db, b, st(12, 1), 't2');
    expect(loadMarks(db, 1)).toEqual({ block: [10], ts: [100], price: [5] });
    expect(getIngestState(db)).toEqual({ nextBlock: 12, windowFromBlock: 1, coverageFromBlock: 1 });
  });

  test('the cursor never moves backwards (a slower concurrent writer cannot rewind it)', () => {
    const db = openJobsDb(':memory:');
    commitPage(db, emptyBatch(), st(500), 't1');
    commitPage(db, emptyBatch(), st(300), 't2');
    expect(getIngestState(db)!.nextBlock).toBe(500);
  });

  test('loadMarks keeps the last publish per block', () => {
    const db = openJobsDb(':memory:');
    commitPage(
      db,
      batch({
        marks: [
          { block: 10, logIndex: 5, ts: 100, perpId: 1, pricePNS: 7 },
          { block: 10, logIndex: 2, ts: 100, perpId: 1, pricePNS: 6 },
          { block: 12, logIndex: 0, ts: 101, perpId: 1, pricePNS: 8 },
          { block: 12, logIndex: 1, ts: 101, perpId: 2, pricePNS: 99 }
        ]
      }),
      st(13),
      't'
    );
    expect(loadMarks(db, 1)).toEqual({ block: [10, 12], ts: [100, 101], price: [7, 8] });
  });

  test('pruneBefore drops event rows older than the window but keeps quarantined logs', () => {
    const db = openJobsDb(':memory:');
    commitPage(
      db,
      batch({
        marks: [
          { block: 1, logIndex: 0, ts: 1, perpId: 1, pricePNS: 1 },
          { block: 5, logIndex: 0, ts: 5, perpId: 1, pricePNS: 2 }
        ],
        collateral: [{ block: 1, logIndex: 1, ts: 1, accountId: 3, kind: 'deposit', amountCNS: '1', balanceCNS: '1', txHash: TX }],
        quarantined: [{ block: 2, logIndex: 0, txHash: TX, topic0: null, data: '0x', reason: 'decode: test' }]
      }),
      st(6),
      't'
    );
    expect(pruneBefore(db, 5)).toBe(2);
    expect(loadMarks(db, 1).block).toEqual([5]);
    expect(quarantineSummary(db, 5)).toEqual({
      inWindow: 0,
      total: 1,
      latest: { block: 2, logIndex: 0, txHash: TX, reason: 'decode: test' }
    });
  });

  test('migration 2 upgrades a store written by migration 1 without losing rows', () => {
    const path = join(tempDir(), 'jobs.sqlite');
    const v1 = openDb(path);
    migrate(v1, JOBS_MIGRATIONS.slice(0, 1));
    v1.run("INSERT INTO ingest_state VALUES (1, 500, 100, 't')");
    v1.run(`INSERT INTO position_events VALUES (150, 0, 1, 1, 7, 'close', 0, 830000, NULL, 0, '-5', '1', '${TX}')`);
    v1.close();
    const db = openJobsDb(path);
    expect(getIngestState(db)).toEqual({ nextBlock: 500, windowFromBlock: 100, coverageFromBlock: 100 });
    expect(buildWalletHistory(db, 7, 10).positions[0]).toMatchObject({ kind: 'close', liquidation: null, deltaPnl: '-0.000005' });
    db.close();
  });

  test('read-only open refuses a missing file and refuses writes', () => {
    const dir = tempDir();
    const path = join(dir, 'jobs.sqlite');
    expect(() => openJobsDbReadonly(path)).toThrow('not found');
    openJobsDb(path).close();
    const ro = openJobsDbReadonly(path);
    expect(() => ro.run("INSERT INTO perps VALUES (1, 'a', 'b', 1, 1, 4, 't')")).toThrow();
    ro.close();
  });
});

describe('writer lease', () => {
  test('one holder at a time; renewable by the holder; free after release or expiry', () => {
    const db = openJobsDb(':memory:');
    expect(acquireLease(db, 'daemon', 1_000, 0)).toBe(true);
    expect(acquireLease(db, 'once', 1_000, 500)).toBe(false);
    expect(acquireLease(db, 'daemon', 1_000, 900)).toBe(true); // renew to 1,900
    expect(acquireLease(db, 'once', 1_000, 1_800)).toBe(false);
    expect(acquireLease(db, 'once', 1_000, 1_900)).toBe(true); // expired: the holder died
    releaseLease(db, 'daemon'); // not the holder: no effect
    expect(acquireLease(db, 'daemon', 1_000, 2_000)).toBe(false);
    releaseLease(db, 'once');
    expect(acquireLease(db, 'daemon', 1_000, 2_000)).toBe(true);
  });

  test('holds across connections to the same file', () => {
    const path = join(tempDir(), 'jobs.sqlite');
    const a = openJobsDb(path);
    const b = openJobsDb(path);
    expect(acquireLease(a, 'daemon', 60_000, 0)).toBe(true);
    expect(acquireLease(b, 'once', 60_000, 1)).toBe(false);
    a.close();
    b.close();
  });
});

describe('account totals', () => {
  test('precomputed per account, exact above 2^53, zeros for unknown accounts once computed', () => {
    const db = openJobsDb(':memory:');
    expect(readAccountTotals(db, 7)).toBeNull();
    const big = '9007199254740993'; // 2^53 + 1
    commitPage(
      db,
      batch({
        positions: [
          pos({ logIndex: 0, deltaPnlCNS: big, fundingCNS: '-1' }),
          pos({ logIndex: 1, deltaPnlCNS: big, fundingCNS: '-1' }),
          pos({ logIndex: 2, kind: 'liquidation', lotBeforeLNS: null, lotAfterLNS: null, liqLotLNS: 5, posLotLNS: 3, deltaPnlCNS: '-2', fundingCNS: '0' }),
          pos({ logIndex: 3, kind: 'open', lotBeforeLNS: 0 })
        ],
        fills: [{ block: 1, logIndex: 4, ts: 1, perpId: 1, accountId: 7, orderId: 1, pricePNS: 1, lotLNS: 1, feeCNS: '0', txHash: TX }]
      }),
      st(2),
      't'
    );
    expect(refreshAccountTotals(db, 2)).toBe(1);
    const t = readAccountTotals(db, 7)!;
    expect(t.deltaPnlCNS).toBe(18014398509481984n); // 2 x (2^53 + 1) - 2
    expect(t.fundingCNS).toBe(-2n);
    expect(t.positionEvents).toMatchObject({ decrease: 2, liquidation: 1, open: 1, close: 0 });
    expect(t.makerFills).toBe(1);
    expect(t.asOfBlock).toBe(2);
    expect(readAccountTotals(db, 999)).toMatchObject({ makerFills: 0, deltaPnlCNS: 0n, asOfBlock: 2 });
  });
});

describe('wallet history', () => {
  test('formats units per perp and compares a close to the prior mark under an honest name', () => {
    const db = openJobsDb(':memory:');
    upsertPerps(db, [{ perpId: 40, name: 'HYPE', symbol: 'HYPE', priceDecimals: 4, lotDecimals: 2, status: 4 }], 't');
    commitPage(
      db,
      batch({
        marks: [{ block: 99, logIndex: 0, ts: 10, perpId: 40, pricePNS: 916_000 }],
        positions: [
          pos({
            block: 100, logIndex: 3, ts: 11, perpId: 40, accountId: 4739, kind: 'close', positionType: 1, pricePNS: 917_134,
            lotBeforeLNS: null, lotAfterLNS: 0, deltaPnlCNS: '-10802906', fundingCNS: '308670'
          }),
          pos({
            block: 100, logIndex: 4, ts: 11, perpId: 40, accountId: 4739, kind: 'liquidation', pricePNS: 900_000,
            lotBeforeLNS: null, lotAfterLNS: null, liqLotLNS: 150, posLotLNS: 50, deltaPnlCNS: '-1', fundingCNS: '0'
          })
        ],
        fills: [
          { block: 100, logIndex: 1, ts: 11, perpId: 40, accountId: 4739, orderId: 5, pricePNS: 916_886, lotLNS: 10, feeCNS: '413', txHash: TX }
        ]
      }),
      st(101, 50),
      't'
    );
    refreshAccountTotals(db, 101);
    const w = buildWalletHistory(db, 4739, 10);
    expect(w.window).toEqual({ fromBlock: 50, toBlock: 101 });
    expect(w.totals).toMatchObject({ makerFills: 1, deltaPnl: '-10.802907', funding: '0.30867', liquidations: 1, asOfBlock: 101 });
    const [liq, close] = w.positions;
    expect(liq).toMatchObject({ kind: 'liquidation', lotsBefore: null, lotsAfter: null, liquidation: { liqLots: '1.5', posLots: '0.5' } });
    expect(close).toMatchObject({
      kind: 'close', side: 'short', symbol: 'HYPE', price: '91.7134', lotsAfter: '0', deltaPnl: '-10.802906', liquidation: null,
      exitVsLastMark: { markPNS: 916_000, markBlock: 99 }
    });
    // Short close buys: (917,134 - 916,000) / 916,000 = 12.38 bps worse than that mark.
    expect(close!.exitVsLastMark!.bps).toBe(12.38);
    expect(w.method.exitVsLastMark).toContain('not stop slippage');
    // 916,886 x 10 x 10^(6 - 4 - 2) = 9,168,860 CNS.
    expect(w.fills[0]).toMatchObject({ price: '91.6886', lots: '0.1', notional: '9.16886', fee: '0.000413' });
    expect(buildWalletHistory(db, 1, 10).positions).toEqual([]);
  });

  test('totals are null until the jobs process has computed them', () => {
    const db = openJobsDb(':memory:');
    expect(buildWalletHistory(db, 1, 10).totals).toBeNull();
  });

  test('exitVsMarkBps sign: positive means worse than mark for the closing side', () => {
    expect(exitVsMarkBps(0, 9_900, 10_000)).toBe(100);
    expect(exitVsMarkBps(0, 10_100, 10_000)).toBe(-100);
    expect(exitVsMarkBps(1, 10_100, 10_000)).toBe(100);
    expect(exitVsMarkBps(2, 1, 1)).toBeNull();
  });
});

describe('ingest', () => {
  function source(height: number, pages: LogPage[]): LogSource & { calls: [number, number][] } {
    const calls: [number, number][] = [];
    return {
      calls,
      getHeight: async () => height,
      getPage: async (from, to) => {
        calls.push([from, to]);
        const p = pages.shift();
        if (!p) throw new Error('unexpected page request');
        return p;
      }
    };
  }
  const opts = (signal = new AbortController().signal, windowDays = 1) => ({ windowDays, signal, log: silent, now: () => new Date(0) });

  test('starts at the window start, pages until height minus confirmations, then resumes from the cursor', async () => {
    const db = openJobsDb(':memory:');
    const height = 1_000_000;
    const target = height - 10;
    const from = target - windowBlocks(1);
    const mark = (block: number) => encodeLog('MarkUpdated', { perpId: 1n, pricePNS: 100n }, block, 0);
    const src = source(height, [
      { logs: [mark(from + 1)], blockTs: new Map([[from + 1, 1]]), nextBlock: from + 500 },
      { logs: [mark(target - 1)], blockTs: new Map([[target - 1, 2]]), nextBlock: target + 5 }
    ]);
    const res = await ingest(db, src, opts());
    expect(src.calls).toEqual([[from, target], [from + 500, target]]);
    expect(res).toMatchObject({ fromBlock: from, toBlock: target, pages: 2, rows: 2, quarantined: 0, aborted: false, coverageFromBlock: from });
    expect(getIngestState(db)).toEqual({ nextBlock: target, windowFromBlock: from, coverageFromBlock: from });

    const again = source(height + 100, [{ logs: [], blockTs: new Map(), nextBlock: target + 100 }]);
    const res2 = await ingest(db, again, opts());
    expect(again.calls).toEqual([[target, target + 100]]);
    expect(res2.coverageFromBlock).toBe(from); // contiguous: coverage start unchanged
  });

  test('a bad log is quarantined, logged and skipped; the cursor still advances', async () => {
    const db = openJobsDb(':memory:');
    const height = 1_000_000;
    const target = height - 10;
    const from = target - windowBlocks(1);
    const good = encodeLog('MarkUpdated', { perpId: 1n, pricePNS: 100n }, from + 1, 0);
    const bad = { ...encodeLog('MarkUpdated', { perpId: 1n, pricePNS: 100n }, from + 2, 0), data: '0xdead' as Hex };
    const errors: { obj: unknown; msg: string }[] = [];
    const log = pino({ level: 'error' }, { write: (line: string) => errors.push(JSON.parse(line)) });
    const src = source(height, [
      { logs: [good, bad], blockTs: new Map([[from + 1, 1], [from + 2, 2]]), nextBlock: target }
    ]);
    const res = await ingest(db, src, { ...opts(), log });
    expect(res).toMatchObject({ rows: 1, quarantined: 1, toBlock: target });
    expect(getIngestState(db)!.nextBlock).toBe(target);
    expect(quarantineSummary(db, from)).toMatchObject({ inWindow: 1, total: 1, latest: { block: from + 2, logIndex: 0 } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ msg: 'jobs.log_quarantined', block: from + 2, txHash: bad.transactionHash });
  });

  test('after downtime longer than the window the covered range restarts at the window start', async () => {
    const db = openJobsDb(':memory:');
    commitPage(db, emptyBatch(), st(100, 0, 0), 't');
    const height = 1_000_000;
    const from = height - 10 - windowBlocks(1);
    const src = source(height, [{ logs: [], blockTs: new Map(), nextBlock: height - 10 }]);
    const res = await ingest(db, src, opts());
    expect(src.calls[0]).toEqual([from, height - 10]);
    expect(res.coverageFromBlock).toBe(from);
    expect(getIngestState(db)!.coverageFromBlock).toBe(from);
  });

  test('raising the window does not claim blocks that were never ingested', async () => {
    const db = openJobsDb(':memory:');
    const height = 10_000_000;
    const target = height - 10;
    const from1 = target - windowBlocks(1);
    await ingest(db, source(height, [{ logs: [], blockTs: new Map(), nextBlock: target }]), opts());
    await ingest(db, source(height, [{ logs: [], blockTs: new Map(), nextBlock: target }]), opts(undefined, 7));
    const s = getIngestState(db)!;
    expect(s.windowFromBlock).toBe(target - windowBlocks(7));
    expect(s.coverageFromBlock).toBe(from1);
  });

  test('a page with a missing block timestamp fails without moving the cursor', async () => {
    const db = openJobsDb(':memory:');
    const height = 1_000_000;
    const src = source(height, [
      { logs: [encodeLog('MarkUpdated', { perpId: 1n, pricePNS: 1n }, 999_000, 0)], blockTs: new Map(), nextBlock: 999_500 }
    ]);
    await expect(ingest(db, src, opts())).rejects.toThrow('missing timestamp');
    expect(getIngestState(db)).toBeNull();
  });

  test('a lost lease stops ingest before the page is committed', async () => {
    const db = openJobsDb(':memory:');
    const height = 1_000_000;
    const src = source(height, [{ logs: [], blockTs: new Map(), nextBlock: height - 10 }]);
    const renewLease = () => {
      throw new Error('jobs: writer lease lost to another process');
    };
    await expect(ingest(db, src, { ...opts(), renewLease })).rejects.toThrow('lease lost');
    expect(getIngestState(db)).toBeNull();
  });

  test('throws when the source makes no progress', async () => {
    const db = openJobsDb(':memory:');
    const height = 1_000_000;
    const from = height - 10 - windowBlocks(1);
    const src = source(height, [{ logs: [], blockTs: new Map(), nextBlock: from }]);
    await expect(ingest(db, src, opts())).rejects.toThrow('no progress');
  });

  test('stops between pages once aborted', async () => {
    const db = openJobsDb(':memory:');
    const ac = new AbortController();
    ac.abort();
    const src = source(1_000_000, []);
    const res = await ingest(db, src, opts(ac.signal));
    expect(res.aborted).toBe(true);
    expect(src.calls).toEqual([]);
  });
});
