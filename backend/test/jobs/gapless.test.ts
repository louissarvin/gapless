import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Query, QueryResponse } from '@envio-dev/hypersync-client';
import pino from 'pino';
import { getAddress, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { ICoverManagerAbi, ICoverVaultAbi, IGaplessCreSinkAbi, IGaplessFactoryAbi } from '../../src/abi/index.ts';
import { CONFIRMATION_BLOCKS } from '../../src/jobs/config.ts';
import {
  computeGaplessStats,
  createGaplessSource,
  decodeGaplessLogs,
  gaplessForAddress,
  gaplessState,
  ingestGapless,
  loadGaplessLogs,
  mapGaplessPage,
  type GaplessConfig,
  type GaplessLog,
  type GaplessSource,
  type GaplessSourceKind
} from '../../src/jobs/gapless.ts';
import type { HypersyncLike, LogSource } from '../../src/jobs/hypersync.ts';
import type { NativeStopSource } from '../../src/jobs/native-ingest.ts';
import { runOnce } from '../../src/jobs/run.ts';
import { openJobsDb } from '../../src/jobs/store.ts';
import { encodeEvent } from './encodeEvent.ts';
import { encodeLog } from './synthetic.ts';

// Test-only addresses and values: nothing here is a deployed contract.
const ADDR: Record<GaplessSourceKind, Address> = {
  manager: getAddress('0x00000000000000000000000000000000000000a1'),
  vault: getAddress('0x00000000000000000000000000000000000000a2'),
  factory: getAddress('0x00000000000000000000000000000000000000a3'),
  sink: getAddress('0x00000000000000000000000000000000000000a4')
};
const CFG: GaplessConfig = { startBlock: 100, addresses: ADDR };
const ABIS: Record<GaplessSourceKind, Abi> = { manager: ICoverManagerAbi, vault: ICoverVaultAbi, factory: IGaplessFactoryAbi, sink: IGaplessCreSinkAbi };
const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const [O1, O2, A1, A2, K1, LP1, LP2] = [a(0xb1), a(0xb2), a(0xc1), a(0xc2), a(0xd1), a(0xe1), a(0xe2)];
const id = (n: number) => keccak256(toHex(`cover-${n}`));
const ZERO = '0x0000000000000000000000000000000000000000';

let logIndex = 0;
function log(source: GaplessSourceKind, block: number, name: string, args: Record<string, unknown>, tx?: Hex): GaplessLog {
  const { topics, data } = encodeEvent(ABIS[source], name, args);
  const t = [...topics.map((x) => x.toLowerCase() as Hex), null, null, null, null];
  return {
    block,
    logIndex: logIndex++,
    ts: 1_791_000_000 + block,
    txHash: tx ?? (`0x${block.toString(16).padStart(64, '0')}` as Hex),
    address: ADDR[source].toLowerCase() as Hex,
    source,
    topic0: t[0]!,
    topic1: t[1]!,
    topic2: t[2]!,
    topic3: t[3]!,
    data
  };
}

const bought = (n: number, account: Address, lots: bigint, stop: bigint, block: number) =>
  log('manager', block, 'CoverBought', {
    coverId: id(n), account, perpId: 1n, isLong: true, lots, stopPNS: stop, maxGapBps: 200n, escrowCNS: 100_000n, rentCNS: 20_000n,
    capCNS: 400_000n, expiryBlock: 20_000n
  });

/** A small protocol history: listing, two accounts, three covers (finalized, expired, re-armed then disarmed). */
function history(): GaplessLog[] {
  logIndex = 0;
  return [
    log('manager', 100, 'RoleGranted', { role: `0x${'00'.repeat(32)}`, account: O1, sender: O1 }, `0x${'aa'.repeat(32)}`),
    log('manager', 101, 'MarketListed', {
      perpId: 1n,
      cfg: { listed: true, priceDecimals: 1, lotDecimals: 5, scale: 1n, feed: a(0xf1), feedDecimals: 8, creRefStore: ZERO }
    }),
    log('factory', 110, 'AccountCreated', { owner: O1, account: A1, operator: K1 }),
    log('factory', 111, 'AccountCreated', { owner: O2, account: A2, operator: K1 }),
    log('vault', 112, 'Transfer', { from: ZERO, to: LP1, value: 1_000n }),
    log('vault', 113, 'Transfer', { from: ZERO, to: LP2, value: 500n }),
    log('vault', 114, 'Transfer', { from: LP2, to: ADDR.vault, value: 500n }),
    bought(1, A1, 22n, 830_000n, 200),
    log('manager', 210, 'Armed', { coverId: id(1), perpId: 1n, armer: K1, blockNumber: 210n, bookPNS: 829_000n, refPNS: 829_500n }),
    log('sink', 210, 'CreReport', { kind: 3, perpId: 1n, refPricePNS: 829_500n, armed: 1n, triggered: 0n }),
    log('manager', 213, 'Triggered', {
      coverId: id(1), perpId: 1n, blockNumber: 213n, filledLots: 22n, realizedCNS: -10n, gRealCumCNS: 2_000_000n, refTrigPNS: 829_000n,
      paidNowCNS: 1_500_000n, owedCNS: 0n
    }),
    log('sink', 213, 'CreReport', { kind: 2, perpId: 1n, refPricePNS: 829_000n, armed: 0n, triggered: 1n }),
    log('vault', 213, 'Paid', { perpId: 1n, account: A1, amountCNS: 1_500_000n }),
    log('vault', 213, 'OwedUpdated', { owedTotalCNS: 100n }),
    log('manager', 260, 'Finalized', { coverId: id(1), topUpCNS: 0n, totalPaidCNS: 1_500_000n, refFinalPNS: 828_000n, escrowToVaultCNS: 300_000n }),
    log('vault', 260, 'PremiumReceived', { amountCNS: 60_000n, toLpsCNS: 54_000n, toTreasuryCNS: 6_000n }),
    log('vault', 261, 'OwedUpdated', { owedTotalCNS: 0n }),
    bought(2, A1, 10n, 800_000n, 300),
    log('manager', 400, 'CoverEnded', { coverId: id(2), status: 6, reason: 2, refundCNS: 50_000n }),
    log('manager', 400, 'EscrowForfeited', { coverId: id(2), amountCNS: 50_000n }),
    bought(3, A2, 5n, 900_000n, 410),
    log('manager', 420, 'Armed', { coverId: id(3), perpId: 1n, armer: K1, blockNumber: 420n, bookPNS: 1n, refPNS: 1n }),
    log('manager', 430, 'Disarmed', { coverId: id(3), reason: 1 })
  ];
}

const silent = pino({ level: 'silent' });
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('Gapless stats arithmetic', () => {
  test('every number of the stats block from a synthetic log set', () => {
    const logs = history();
    const { decoded, undecoded } = decodeGaplessLogs(logs);
    expect(undecoded).toBe(0);
    const s = computeGaplessStats(decoded, { totalAssetsCNS: 25_000_000n, utilizationBps: 1_234 }, ADDR.vault);
    expect(s).toEqual({
      covers: { total: 3, live: 1, armed: 0, triggered: 0, finalized: 1, expired: 1, cancelled: 0, voided: 0 },
      owners: 2,
      accounts: 2,
      // 22 x 830000 + 10 x 800000 + 5 x 900000, scale 1
      notionalCoveredCNS: '30760000',
      premiums: { escrowToVaultCNS: '350000', rentCNS: '60000', toLpsCNS: '54000', toTreasuryCNS: '6000' },
      payouts: { count: 1, paidCNS: '1500000', owedCNS: '0' },
      armToTriggerBlocks: { n: 1, p50: 3, max: 3 },
      vault: { totalAssetsCNS: '25000000', lpCount: 1, utilizationBps: 1_234 },
      cre: { reports: 2, armed: 1, triggered: 1 },
      firsts: { deployTx: `0x${'aa'.repeat(32)}`, firstCoverTx: logs[7]!.txHash, firstTriggerTx: logs[10]!.txHash }
    });
  });

  test('no logs and no vault read: zeros and nulls, never a throw', () => {
    const s = computeGaplessStats([], null, undefined);
    expect(s.covers.total).toBe(0);
    expect(s.vault).toEqual({ totalAssetsCNS: null, lpCount: 0, utilizationBps: null });
    expect(s.armToTriggerBlocks).toEqual({ n: 0, p50: null, max: null });
    expect(s.firsts).toEqual({ deployTx: null, firstCoverTx: null, firstTriggerTx: null });
  });

  test('an undecodable log is counted, not fatal', () => {
    const bad = { ...history()[0]!, topic0: `0x${'ee'.repeat(32)}` as Hex };
    expect(decodeGaplessLogs([bad]).undecoded).toBe(1);
  });
});

describe('Gapless ingest', () => {
  const wire = (l: GaplessLog) => ({
    address: l.address, blockNumber: l.block, logIndex: l.logIndex, transactionHash: l.txHash, data: l.data,
    topics: [l.topic0, l.topic1, l.topic2, l.topic3]
  });

  test('query and mapping: configured addresses only, all topics, a foreign address fails the page', async () => {
    const queries: Query[] = [];
    const logs = history().slice(0, 3);
    const res: QueryResponse = {
      nextBlock: 200,
      totalExecutionTime: 1,
      data: { blocks: [100, 101, 110].map((n) => ({ number: n, timestamp: n })), transactions: [], logs: logs.map(wire), traces: [] }
    };
    const client: HypersyncLike = { getHeight: async () => 1, get: async (q) => (queries.push(q), res) };
    const page = await createGaplessSource(client, CFG).getPage(100, 300);
    expect(queries[0]).toEqual({
      fromBlock: 100,
      toBlock: 300,
      logs: [{ address: Object.values(ADDR) }],
      fieldSelection: {
        log: ['BlockNumber', 'LogIndex', 'TransactionHash', 'Address', 'Data', 'Topic0', 'Topic1', 'Topic2', 'Topic3'],
        block: ['Number', 'Timestamp']
      }
    });
    expect(page.logs.map((l) => [l.source, l.block, l.ts])).toEqual([['manager', 100, 100], ['manager', 101, 101], ['factory', 110, 110]]);
    const foreign = { ...res, data: { ...res.data, logs: [{ ...wire(logs[0]!), address: '0x00000000000000000000000000000000000000ff' }] } };
    expect(() => mapGaplessPage(CFG, foreign)).toThrow('unexpected address');
  });

  function fake(logs: GaplessLog[], height: number): GaplessSource & { calls: number } {
    const s = {
      calls: 0,
      getHeight: async () => height,
      getPage: async (from: number, to: number) => {
        s.calls++;
        return { logs: logs.filter((l) => l.block >= from && l.block < to), nextBlock: to };
      }
    };
    return s;
  }

  test('from the start block to height minus confirmations; resumes; a config change refetches from the start', async () => {
    const db = openJobsDb(':memory:');
    const logs = history();
    const opts = { signal: new AbortController().signal, log: silent };
    const r1 = await ingestGapless(db, fake(logs, 300), CFG, opts);
    expect(r1).toMatchObject({ fromBlock: 100, toBlock: 300 - CONFIRMATION_BLOCKS, reset: false });
    expect(loadGaplessLogs(db).length).toBe(logs.filter((l) => l.block < 290).length);
    const r2 = await ingestGapless(db, fake(logs, 1_000), CFG, opts);
    expect(r2.fromBlock).toBe(290);
    expect(loadGaplessLogs(db)).toHaveLength(logs.length);
    const moved = { ...CFG, addresses: { manager: ADDR.manager } };
    const r3 = await ingestGapless(db, fake(logs.filter((l) => l.source === 'manager'), 1_000), moved, opts);
    expect(r3).toMatchObject({ reset: true, fromBlock: 100 });
    expect(loadGaplessLogs(db).every((l) => l.source === 'manager')).toBe(true);
    expect(gaplessState(db)?.addresses).toContain(ADDR.manager.toLowerCase());
    db.close();
  });

  test('wallet lookup: owner and account map to the same covers, newest first; unknown is null', async () => {
    const db = openJobsDb(':memory:');
    await ingestGapless(db, fake(history(), 1_000), CFG, { signal: new AbortController().signal, log: silent });
    const byOwner = gaplessForAddress(db, O1)!;
    expect(byOwner.account).toBe(A1);
    expect(byOwner.owner).toBe(O1);
    expect(byOwner.covers.map((c) => [c.coverId, c.status, c.stopPNS, c.paidCNS])).toEqual([
      [id(2), 'expired', '800000', '0'],
      [id(1), 'finalized', '830000', '1500000']
    ]);
    expect(gaplessForAddress(db, A1)).toEqual(byOwner);
    expect(gaplessForAddress(db, O2)!.covers.map((c) => c.status)).toEqual(['live']);
    expect(gaplessForAddress(db, LP1)).toBeNull();
    db.close();
  });
});

describe('runOnce side reports', () => {
  const HEIGHT = 2_000;
  // Two marks so the Gap Index cycle completes; values are test-only.
  const perplSource = (): LogSource => {
    let served = false;
    return {
      getHeight: async () => HEIGHT,
      getPage: async (_f, t) => {
        if (served) return { logs: [], blockTs: new Map(), nextBlock: t };
        served = true;
        const logs = [encodeLog('MarkUpdated', { perpId: 1n, pricePNS: 830_000n }, 1_000, 0), encodeLog('MarkUpdated', { perpId: 1n, pricePNS: 830_100n }, 1_400, 0)];
        return { logs, blockTs: new Map([[1_000, 1_791_000_000], [1_400, 1_791_000_120]]), nextBlock: t };
      }
    };
  };
  const nativeSource: NativeStopSource = { getHeight: async () => HEIGHT, getPage: async (_f, t) => ({ txs: [], nextBlock: t }) };
  const gaplessSource = (): GaplessSource => ({ getHeight: async () => HEIGHT, getPage: async (f, t) => ({ logs: history().filter((l) => l.block >= f && l.block < t), nextBlock: t }) });

  async function run(withGapless: boolean, readVault = async () => ({ totalAssetsCNS: 7n, utilizationBps: 0 })) {
    const out = mkdtempSync(join(tmpdir(), 'gapless-side-'));
    dirs.push(out);
    const db = openJobsDb(':memory:');
    const res = await runOnce(
      {
        db,
        log: silent,
        source: perplSource(),
        readPerps: async () => [{ perpId: 1, name: 'BTC Perp', symbol: 'BTC', priceDecimals: 1, lotDecimals: 5, status: 4 }],
        outDir: out,
        windowDays: 1,
        curveNotionalCNS: 20_000_000n,
        leaseOwner: 't',
        now: () => new Date('2026-10-06T12:00:00Z'),
        nativeSource,
        gapless: withGapless ? { source: gaplessSource(), config: CFG, readVault } : undefined
      },
      new AbortController().signal
    );
    db.close();
    return { out, res };
  }

  test('writes native-stops.json and stats.json in the response contract shape', async () => {
    const { out, res } = await run(true);
    expect(res.wrote).toBe(true);
    const native = JSON.parse(readFileSync(join(out, 'native-stops.json'), 'utf8'));
    expect(native).toMatchObject({ schemaVersion: 1, totals: { executions: 0, joinRate: null }, perps: [] });
    const stats = JSON.parse(readFileSync(join(out, 'stats.json'), 'utf8'));
    expect(stats).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-10-06T12:00:00.000Z',
      window: { fromBlock: 100, toBlock: HEIGHT - CONFIRMATION_BLOCKS },
      gapless: { covers: { total: 3 }, vault: { totalAssetsCNS: '7', lpCount: 1 }, undecodedLogs: 0 },
      perplNativeStops: { executions: 0, joinRate: null, slippageVsTriggerBps: { p50: null, p95: null }, delayBlocks: { p50: null, p95: null } }
    });
    expect(Object.keys(stats.gapless).sort()).toEqual(
      ['accounts', 'armToTriggerBlocks', 'covers', 'cre', 'firsts', 'notionalCoveredCNS', 'owners', 'payouts', 'premiums', 'undecodedLogs', 'vault'].sort()
    );
  });

  test('without deploy addresses there is no stats.json (the route stays 503); a vault read failure is not fatal', async () => {
    expect(existsSync(join((await run(false)).out, 'stats.json'))).toBe(false);
    const { out } = await run(true, async () => {
      throw new Error('rpc down');
    });
    expect(JSON.parse(readFileSync(join(out, 'stats.json'), 'utf8')).gapless.vault.totalAssetsCNS).toBeNull();
  });
});
