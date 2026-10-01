import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { Hex } from 'viem';
import { CONFIRMATION_BLOCKS, METHOD_VERSION, SPEC_DEFAULT_PARAMS } from '../../src/jobs/config.ts';
import type { LogSource } from '../../src/jobs/hypersync.ts';
import { writeJsonAtomic } from '../../src/jobs/output.ts';
import type { RawLog } from '../../src/jobs/rows.ts';
import { LeaseHeldError, runOnce, type RunDeps } from '../../src/jobs/run.ts';
import { startRunner, type RunnerTimers } from '../../src/jobs/runner.ts';
import { acquireLease, openJobsDb } from '../../src/jobs/store.ts';
import { goldenMarket } from './golden-market.ts';

const silent = pino({ level: 'silent' });
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'gapless-run-'));
  dirs.push(d);
  return d;
};
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('writeJsonAtomic', () => {
  test('replaces the file and leaves no temp files', async () => {
    const dir = tempDir();
    await writeJsonAtomic(dir, 'a.json', { v: 1 });
    await writeJsonAtomic(dir, 'a.json', { v: 2 });
    expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'))).toEqual({ v: 2 });
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  test('fails loudly on bigint and keeps the old file', async () => {
    const dir = tempDir();
    await writeJsonAtomic(dir, 'a.json', { v: 1 });
    await expect(writeJsonAtomic(dir, 'a.json', { v: 1n })).rejects.toThrow();
    expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'))).toEqual({ v: 1 });
    expect(readdirSync(dir)).toEqual(['a.json']);
  });
});

describe('startRunner (manual clock)', () => {
  function manual() {
    let fn: (() => void) | null = null;
    let cleared = false;
    const timers: RunnerTimers = {
      setInterval: (f) => {
        fn = f;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      }
    };
    return { timers, tick: () => fn?.(), cleared: () => cleared };
  }
  function capture() {
    const lines: { level: number; msg: string }[] = [];
    return { lines, log: pino({ level: 'info' }, { write: (l: string) => lines.push(JSON.parse(l)) }) };
  }

  test('runs at once, skips ticks while a run is going, and stop() aborts and waits', async () => {
    const clock = manual();
    const { lines, log } = capture();
    const pending: { resolve: () => void; signal: AbortSignal }[] = [];
    const runner = startRunner({
      intervalMs: 60_000,
      log,
      timers: clock.timers,
      now: () => 0,
      task: (signal) => new Promise<void>((resolve) => pending.push({ resolve, signal }))
    });
    expect(pending).toHaveLength(1);
    clock.tick();
    clock.tick();
    expect(pending).toHaveLength(1);
    expect(lines.filter((l) => l.msg.startsWith('jobs.tick_skipped'))).toHaveLength(2);
    pending[0]!.resolve();
    await flush();
    clock.tick();
    expect(pending).toHaveLength(2);
    const stopped = runner.stop();
    expect(pending[1]!.signal.aborted).toBe(true);
    expect(clock.cleared()).toBe(true);
    pending[1]!.resolve();
    await stopped;
    clock.tick();
    expect(pending).toHaveLength(2);
  });

  test('failures warn, then log jobs.degraded at error level; a success resets the count', async () => {
    const clock = manual();
    const { lines, log } = capture();
    let fail = true;
    const runner = startRunner({
      intervalMs: 60_000,
      log,
      alertAfter: 2,
      timers: clock.timers,
      task: async () => {
        if (fail) throw new Error('boom');
      }
    });
    await flush();
    clock.tick();
    await flush();
    clock.tick();
    await flush();
    fail = false;
    clock.tick();
    await flush();
    fail = true;
    clock.tick();
    await flush();
    await runner.stop();
    expect(lines.filter((l) => l.msg.startsWith('jobs.')).map((l) => [l.level, l.msg])).toEqual([
      [40, 'jobs.run_failed'],
      [50, 'jobs.degraded'],
      [50, 'jobs.degraded'],
      [30, 'jobs.run_ok'],
      [40, 'jobs.run_failed']
    ]);
  });
});

const HEIGHT = 400_000;
const FROM = HEIGHT - CONFIRMATION_BLOCKS - 297_932; // windowBlocks(1)
const PERPS = [
  { perpId: 1, name: 'BTC Perp', symbol: 'BTC', priceDecimals: 1, lotDecimals: 5, status: 4 },
  { perpId: 30, name: 'SOL', symbol: 'SOL', priceDecimals: 2, lotDecimals: 3, status: 0 }
];

function oneShotSource(logs: RawLog[], ts: Map<number, number>): LogSource {
  let served = false;
  return {
    getHeight: async () => HEIGHT,
    getPage: async (f, t) => {
      if (served) return { logs: [], blockTs: new Map(), nextBlock: t };
      served = true;
      expect([f, t]).toEqual([FROM, HEIGHT - CONFIRMATION_BLOCKS]);
      return { logs, blockTs: ts, nextBlock: t };
    }
  };
}

function deps(over: Partial<RunDeps> & { db: RunDeps['db']; outDir: string; source: LogSource }): RunDeps {
  return {
    log: silent,
    windowDays: 1,
    curveNotionalCNS: 50_000_000n,
    leaseOwner: 'test-daemon',
    now: () => new Date('2026-10-05T12:00:00Z'),
    readPerps: async () => PERPS,
    ...over
  };
}

describe('runOnce', () => {
  test('ingests, computes every report and writes them atomically; a bad log is surfaced, not fatal', async () => {
    const out = tempDir();
    const db = openJobsDb(join(tempDir(), 'jobs.sqlite'));
    const { logs, ts } = goldenMarket(FROM, HEIGHT - CONFIRMATION_BLOCKS);
    const bad: RawLog = { ...logs[5]!, logIndex: 9, data: '0x00' as Hex };
    const d = deps({ db, outDir: out, source: oneShotSource([...logs, bad], ts) });
    const res = await runOnce(d, new AbortController().signal);
    expect(res.wrote).toBe(true);
    expect(res.ingest.quarantined).toBe(1);
    expect(readdirSync(out).sort()).toEqual(['fit.json', 'gaps.json', 'premium-curve.json', 'staleness.json', 'summary.json']);

    const read = (f: string) => JSON.parse(readFileSync(join(out, f), 'utf8'));
    const summary = read('summary.json');
    expect(summary).toMatchObject({ schemaVersion: 1, methodVersion: METHOD_VERSION, generatedAt: '2026-10-05T12:00:00.000Z' });
    expect(summary.window).toMatchObject({ fromBlock: FROM, configuredFromBlock: FROM, toBlock: HEIGHT - CONFIRMATION_BLOCKS, requestedDays: 1 });
    expect(summary.ingest.quarantinedLogs).toMatchObject({ inWindow: 1, total: 1, lastRun: 1, latest: { block: bad.blockNumber, logIndex: 9 } });
    expect(summary.perps.map((p: { perpId: number }) => p.perpId)).toEqual([1]);
    expect(summary.excluded).toEqual([{ perpId: 30, symbol: 'SOL', reason: 'status 0 (not active)' }]);

    const staleness = read('staleness.json');
    expect(staleness.perps[0].oracle.failures.other).toBe(0);
    expect(staleness.perps[0].oracle.failures.reportNotNewer).toBeGreaterThan(0);

    const fit = read('fit.json');
    expect(fit.perps[0].boundsViolations).toEqual([]);
    const g = fit.perps[0].proposedParams.gapBpsE2 as number[];
    expect(g.every((v, i) => v >= SPEC_DEFAULT_PARAMS.gapBpsE2[i]!)).toBe(true);

    const curve = read('premium-curve.json');
    expect(curve.method.inputs.notionalCNS).toBe('50000000');
    expect(curve.perps[0].curves.specDefault).toHaveLength(15);

    // Second run: nothing new, same window, still writes; the lease was released and re-taken.
    const again = await runOnce({ ...d, now: () => new Date('2026-10-05T12:05:00Z') }, new AbortController().signal);
    expect(again.ingest.pages).toBe(0);
    expect(read('summary.json').generatedAt).toBe('2026-10-05T12:05:00.000Z');
    db.close();
  }, 60_000);

  test('golden output: any method change shows up here and needs a METHOD_VERSION bump', async () => {
    const out = tempDir();
    const db = openJobsDb(':memory:');
    const { logs, ts } = goldenMarket(FROM, HEIGHT - CONFIRMATION_BLOCKS);
    await runOnce(deps({ db, outDir: out, source: oneShotSource(logs, ts) }), new AbortController().signal);
    const read = (f: string) => JSON.parse(readFileSync(join(out, f), 'utf8'));
    const gaps = read('gaps.json').perps[0];
    const fit = read('fit.json').perps[0];
    const summary = read('summary.json');

    // Values below were produced by gapless-gap-index/3 (C4 arm rule) and are unchanged in /4 (which only adds
    // native-stops.json and stats.json). If they change, the published numbers changed: bump METHOD_VERSION in
    // config.ts, then update this block.
    expect(METHOD_VERSION).toBe('gapless-gap-index/4');
    expect(fit.inputDigest).toBe('sha256:0fc6b3a07858f006b6cb9c904536b6a903a85a88c966c9c3cfbb9ecfe1721a2c');
    expect(gaps.sim).toEqual({ starts: 1429, skippedNoMark: 0, skippedStaleMark: 0 });
    const long100 = gaps.rows.find((r: { side: string; distanceBps: number; horizonBlocks: number }) => r.side === 'long' && r.distanceBps === 100 && r.horizonBlocks === 12_000);
    expect(long100).toMatchObject({
      samples: 1429,
      hits: 120,
      pHit: 0.084,
      distinctTriggers: 2,
      markGapBps: { n: 120, mean: 55.48, p50: 55.28, p90: 74, p99: 79.53, max: 79.95, events: 2, eventsAtOrAbove: { p50: 2, p90: 1, p99: 1, max: 1 } },
      pMarkGapAbove: { '5': 1, '10': 1, '25': 1, '50': 0.675, '100': 0, '200': 0 },
      eventsMarkGapAbove: { '5': 2, '10': 2, '25': 2, '50': 2, '100': 0, '200': 0 },
      pHitMarkGapAbove100Bps: 0
    });
    expect(summary.perps[0].headline.map((h: Record<string, unknown>) => [h.side, h.hits, h.distinctTriggers, h.markGapP99Bps, h.markGapP99Events])).toEqual([
      ['long', 120, 2, 79.53, 1],
      ['short', 0, 0, null, 0]
    ]);
    expect(fit.coverSim).toEqual({ starts: 1369, skippedNoMark: 0, skippedStaleMark: 0, skippedNoSigma: 60, rejectedStopTooClose: 2480 });
    expect(fit.sigmaNowBlkBpsE2).toBe(5);
    expect(fit.table).toEqual({
      measuredE2: [478, 1812, 1764, 1770, 3603, 2010, 2475, 4114, 7466],
      liftedE2: [478, 1812, 1812, 1812, 3603, 3603, 3603, 4114, 7466],
      source: Array(9).fill('measured'),
      pavaE2: [478, 1783, 1783, 1783, 2303, 2303, 2475, 4114, 7466],
      proposedE2: [478, 1812, 1812, 1812, 3603, 3603, 3603, 4114, 7466]
    });
    expect(
      fit.buckets.map((b: Record<string, number>) => [b.bucket, b.samples, b.hits, b.distinctEvents, b.meanPayoutBps, b.meanRefBoundBps])
    ).toEqual([
      [0, 1034, 322, 322, 4.78, 5.2],
      [1, 3888, 770, 539, 18.12, 18.61],
      [2, 3434, 380, 337, 17.64, 18.3],
      [3, 3644, 843, 757, 17.7, 18.17],
      [4, 2096, 135, 101, 36.02, 36.4],
      [5, 2660, 512, 449, 20.1, 20.54],
      [6, 3806, 485, 395, 24.75, 25.4],
      [7, 5424, 379, 218, 41.14, 41.82],
      [8, 23814, 573, 44, 74.66, 74.72]
    ]);
    expect(read('premium-curve.json').perps[0].curves.fitProposal[0]).toEqual({
      distanceBps: 10,
      allowed: true,
      rejectReasons: [],
      minDistanceBps: 10,
      zE2: 183,
      bucket: 3,
      gapBpsE2: 1812,
      feeBpsE2: 2718,
      escrowCNS: '135900',
      rentCNS: '20000'
    });
  }, 60_000);

  test('refuses to run while another process holds the lease, and writes nothing', async () => {
    const out = tempDir();
    const db = openJobsDb(':memory:');
    expect(acquireLease(db, 'test-daemon', 600_000, Date.parse('2026-10-05T11:59:00Z'))).toBe(true);
    const source: LogSource = {
      getHeight: async () => {
        throw new Error('must not be called');
      },
      getPage: async () => {
        throw new Error('must not be called');
      }
    };
    await expect(runOnce(deps({ db, outDir: out, source, leaseOwner: 'test-once' }), new AbortController().signal)).rejects.toBeInstanceOf(
      LeaseHeldError
    );
    expect(existsSync(join(out, 'summary.json'))).toBe(false);
  });

  test('falls back to stored perp metadata when the chain read fails, and refuses to write without data', async () => {
    const out = tempDir();
    const db = openJobsDb(':memory:');
    const source: LogSource = {
      getHeight: async () => 400_000,
      getPage: async (_f, t) => ({ logs: [], blockTs: new Map(), nextBlock: t })
    };
    await expect(
      runOnce(
        deps({
          db,
          outDir: out,
          source,
          readPerps: async () => {
            throw new Error('rpc down');
          }
        }),
        new AbortController().signal
      )
    ).rejects.toThrow('no perp metadata');
    expect(existsSync(join(out, 'summary.json'))).toBe(false);
    // The failed run still released the lease.
    expect(acquireLease(db, 'someone-else', 1, Date.now())).toBe(true);
  });
});
