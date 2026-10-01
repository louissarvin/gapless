import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import type { Query, QueryResponse } from '@envio-dev/hypersync-client';
import pino from 'pino';
import { getAddress, toEventSelector, toEventSignature, toFunctionSelector, type Abi, type AbiEvent, type AbiFunction, type Hex } from 'viem';
import { PERPL_EXCHANGE } from '../../src/lib/addresses.ts';
import { CONFIRMATION_BLOCKS } from '../../src/jobs/config.ts';
import type { HypersyncLike } from '../../src/jobs/hypersync.ts';
import {
  accountNativeStops,
  assembleJoinAllPage,
  createNativeStopSource,
  ingestNativeStops,
  nativeStopReport,
  nativeStopSummary,
  NATIVE_MAX_PAGES_PER_RUN,
  NATIVE_MAX_TXS_PER_PAGE,
  refreshNativeJoins,
  type NativeStopSource
} from '../../src/jobs/native-ingest.ts';
import {
  adverseBps,
  delayBlocks,
  forwardedTriggerOrders,
  joinNativeStops,
  NATIVE_EVENTS_ABI,
  NATIVE_TOPICS,
  parseNativeTx,
  parseNativeTxs,
  rowKey,
  slippageVsMarkBps,
  slippageVsTriggerBps,
  spread,
  TRIGGER_TOPICS,
  type MarkLookup,
  type NativeTx,
  type Placement
} from '../../src/jobs/native-stops.ts';
import { commitPage, openJobsDb } from '../../src/jobs/store.ts';
import { emptyBatch, type RawLog } from '../../src/jobs/rows.ts';
import { encodeEvent } from './encodeEvent.ts';

const silent = pino({ level: 'silent' });
const ABI = NATIVE_EVENTS_ABI as unknown as Abi;
const EXCHANGE = PERPL_EXCHANGE.toLowerCase();

// Real execution tx (test-only fixture, see its `note`).
const real = JSON.parse(readFileSync(new URL('../fixtures/perpl/native-stop-exec.mainnet.json', import.meta.url), 'utf8')) as {
  transactionHash: Hex;
  blockNumber: number;
  from: string;
  input: Hex;
  logs: { address: string; blockNumber: number; logIndex: number; transactionHash: Hex; topics: Hex[]; data: Hex }[];
};
// Block timestamp was not captured with the fixture; any value works for these tests.
const REAL_TS = 1_791_000_000;

const realResponse = (): QueryResponse => ({
  nextBlock: real.blockNumber + 1,
  totalExecutionTime: 5,
  data: {
    blocks: [{ number: real.blockNumber, timestamp: REAL_TS }],
    transactions: [{ hash: real.transactionHash, from: real.from, input: real.input }],
    logs: real.logs.map((l) => ({ ...l, topics: [...l.topics, null, null, null].slice(0, 4) })),
    traces: []
  }
});

// Synthetic txs in the measured shapes, encoded with the real ABI (test-only values).
let txCounter = 0;
const txHash = () => `0x${(++txCounter).toString(16).padStart(64, '0')}` as Hex;
function orderReq(o: { perp?: number; account: number; type: number; price?: number; lots: number; descId?: number }) {
  return encodeEvent(ABI, 'OrderRequestV2', {
    perpId: BigInt(o.perp ?? 1), accountId: BigInt(o.account), orderDescId: BigInt(o.descId ?? 1), orderId: 0n,
    orderType: o.type, pricePNS: BigInt(o.price ?? 0), lotLNS: BigInt(o.lots), expiryBlock: 0n, postOnly: false,
    fillOrKill: false, immediateOrCancel: o.price !== undefined && o.price > 0, maxMatches: 50n, leverageHdths: 1000n,
    lastExecutionBlock: 0n, amountCNS: 0n, maxNegPnlCollatBPS: 300n, gasLeft: 1_000_000n, extension: '0x'
  });
}
const trigReq = (price: number, condition: number) =>
  encodeEvent(ABI, 'TriggerOrderRequest', { triggerPricePNS: BigInt(price), triggerPriceCondition: condition, triggerRequestId: 0n, triggerPositionId: 7n });
const trigExec = () => encodeEvent(ABI, 'TriggerOrderExecution', {});
const takerFill = (price: number, lots: number) =>
  encodeEvent(ABI, 'TakerOrderFilledV2', {
    entryPricePNS: BigInt(price), collatPricePNS: BigInt(price), pnlPricePNS: BigInt(price), lotLNS: BigInt(lots), feeCNS: 1n,
    amountCNS: 0n, balanceCNS: 0n, builderId: 0n, builderFeeCNS: 0n
  });

function tx(block: number, parts: { topics: Hex[]; data: Hex }[], firstIndex = 0): NativeTx {
  const hash = txHash();
  const logs: RawLog[] = parts.map((p, i) => ({ blockNumber: block, logIndex: firstIndex + i, transactionHash: hash, topics: p.topics, data: p.data }));
  return { hash, block, ts: 1_791_000_000 + block, from: null, input: null, logs };
}
const placeTx = (block: number, o: { account: number; type: 2 | 3; lots: number; trigger: number; cond?: number; price?: number; perp?: number }) =>
  tx(block, [orderReq({ account: o.account, type: o.type, lots: o.lots, price: o.price ?? 0, perp: o.perp }), trigReq(o.trigger, o.cond ?? (o.type === 3 ? 2 : 3))]);
const cancelTx = (block: number, account: number, trigger: number) => tx(block, [orderReq({ account, type: 4, lots: 0 }), trigReq(trigger, 3)]);
const execTx = (block: number, o: { account: number; type: 2 | 3; lots: number; limit: number; fills: [number, number][]; perp?: number }) =>
  tx(block, [orderReq({ account: o.account, type: o.type, lots: o.lots, price: o.limit, perp: o.perp }), trigExec(), ...o.fills.map(([p, l]) => takerFill(p, l))]);

/** Test-only marks: block -> price for perp 1. */
function marksFrom(points: [number, number][]): MarkLookup {
  const s = [...points].sort((a, b) => a[0] - b[0]);
  return {
    markAtOrBefore: (_perp, block) => {
      const hit = [...s].reverse().find(([b]) => b <= block);
      return hit ? { block: hit[0], pricePNS: hit[1] } : null;
    },
    firstMarkCrossing: (_perp, from, to, price, gte) => s.find(([b, p]) => b > from && b <= to && (gte ? p >= price : p <= price))?.[0] ?? null
  };
}

const ABI_PATH = new URL('../../../gapless/perpl-fork-gate/Exchange.abi.json', import.meta.url);

describe('native stop ABI', () => {
  test.skipIf(!existsSync(ABI_PATH))('events and execFwd calldata match Exchange.abi.json', () => {
    const raw = JSON.parse(readFileSync(ABI_PATH, 'utf8')) as Abi | { abi: Abi };
    const file: Abi = Array.isArray(raw) ? (raw as Abi) : (raw as { abi: Abi }).abi;
    for (const ev of NATIVE_EVENTS_ABI) {
      const ref = file.find((e): e is AbiEvent => e.type === 'event' && e.name === ev.name)!;
      expect(toEventSignature(ev)).toBe(toEventSignature(ref));
      expect(toEventSelector(ev)).toBe(toEventSelector(ref));
    }
    const fwd = file.find((f): f is AbiFunction => f.type === 'function' && f.name === 'execFwdPositionOpsV2')!;
    expect(real.input.slice(0, 10)).toBe(toFunctionSelector(fwd));
  });

  test('trigger topics are the two selection topics, distinct from the Perpl ingest set', () => {
    expect(TRIGGER_TOPICS).toEqual([NATIVE_TOPICS.triggerRequest, NATIVE_TOPICS.triggerExecution]);
    expect(real.logs.map((l) => l.topics[0]).filter((t) => t !== undefined && TRIGGER_TOPICS.includes(t))).toEqual([NATIVE_TOPICS.triggerExecution]);
  });
});

describe('HyperSync JoinAll decoding (real execution tx)', () => {
  test('query: Exchange, both trigger topics, JoinAll, tx From and Input, bounded page', async () => {
    const queries: Query[] = [];
    const client: HypersyncLike = { getHeight: async () => 1, get: async (q) => (queries.push(q), realResponse()) };
    await createNativeStopSource(client).getPage(100, 200);
    expect(queries[0]).toEqual({
      fromBlock: 100,
      toBlock: 200,
      logs: [{ address: [PERPL_EXCHANGE], topics: [[NATIVE_TOPICS.triggerRequest, NATIVE_TOPICS.triggerExecution]] }],
      fieldSelection: {
        log: ['BlockNumber', 'LogIndex', 'TransactionHash', 'Address', 'Data', 'Topic0'],
        transaction: ['Hash', 'From', 'Input'],
        block: ['Number', 'Timestamp']
      },
      joinMode: 1,
      maxNumTransactions: NATIVE_MAX_TXS_PER_PAGE
    });
  });

  test('decodes the execution: account, perp, close short, IOC limit, full fill at 829324, calldata verified', () => {
    const page = assembleJoinAllPage(realResponse());
    expect(page.nextBlock).toBe(real.blockNumber + 1);
    expect(page.txs).toHaveLength(1);
    expect(page.txs[0]!.logs).toHaveLength(17);
    const p = parseNativeTx(page.txs[0]!);
    expect(p.placements).toEqual([]);
    expect(p.problems).toEqual([]);
    expect(p.executions).toEqual([
      {
        block: 108_730_659,
        logIndex: 239,
        ts: REAL_TS,
        txHash: real.transactionHash,
        execFrom: getAddress(real.from),
        calldataMatch: 1,
        accountId: 3849,
        perpId: 1,
        closeType: 3,
        lotLNS: 1901,
        iocLimitPNS: 837_617,
        orderDescId: '168',
        filledLNS: 1901,
        fillNotional: (829_324n * 1901n).toString(),
        fillVwapPNS: 829_324
      }
    ]);
    expect(forwardedTriggerOrders(real.input)).toEqual(new Set(['3849:168']));
  });

  test('with its placement (trigger 829190, GTEMark) it joins: delay 4 blocks, 1.62 bps worse than the trigger', () => {
    const e = parseNativeTx(assembleJoinAllPage(realResponse()).txs[0]!).executions[0]!;
    // Test-only placement with the trigger price recorded in the memory evidence.
    const place = parseNativeTx(placeTx(108_700_000, { account: 3849, type: 3, lots: 1901, trigger: 829_190, cond: 2 })).placements;
    const j = joinNativeStops(place, [], [e]);
    expect(j.executions.get(rowKey(e))?.status).toBe('joined');
    const marks = marksFrom([[108_700_000, 828_000], [108_730_655, 829_263], [108_730_658, 829_400]]);
    expect(delayBlocks(place[0]!, e, marks)).toBe(4);
    expect(slippageVsTriggerBps(place[0]!, e)).toBe(1.62);
    // vs the latest mark before the execution block (829400): the fill was better than that mark.
    expect(slippageVsMarkBps(e, marks)).toBe(-0.92);
  });

  test('page assembly: Exchange logs only, grouped per tx, sorted by logIndex; missing tx row keeps from/input null', () => {
    const a = placeTx(500, { account: 1, type: 2, lots: 10, trigger: 100 });
    const b = execTx(501, { account: 1, type: 2, lots: 10, limit: 99, fills: [[100, 10]] });
    const foreign = { address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', blockNumber: 500, logIndex: 5, transactionHash: a.hash, topics: [`0x${'dd'.repeat(32)}`, null, null, null], data: '0x' };
    const toWire = (t: NativeTx) => t.logs.map((l) => ({ address: EXCHANGE, blockNumber: l.blockNumber, logIndex: l.logIndex, transactionHash: l.transactionHash, data: l.data, topics: [...l.topics, null, null, null].slice(0, 4) }));
    const res: QueryResponse = {
      nextBlock: 600,
      totalExecutionTime: 1,
      data: {
        blocks: [{ number: 500, timestamp: 10 }, { number: 501, timestamp: 11 }],
        transactions: [{ hash: b.hash, from: '0x28f6000000000000000000000000000000002eec', input: '0x' }],
        logs: [...toWire(b).reverse(), foreign, ...toWire(a)],
        traces: []
      }
    };
    const page = assembleJoinAllPage(res);
    expect(page.txs.map((t) => t.hash)).toEqual([a.hash, b.hash]);
    expect(page.txs[0]!.logs.map((l) => l.logIndex)).toEqual([0, 1]);
    expect(page.txs[1]!.logs.map((l) => l.logIndex)).toEqual([0, 1, 2]);
    expect(page.txs[0]!.from).toBeNull();
    expect(page.txs[1]!.from).toBe(getAddress('0x28f6000000000000000000000000000000002eec'));
    // Undecodable calldata: execution kept, verification unknown.
    expect(parseNativeTxs(page.txs).executions[0]!.calldataMatch).toBeNull();
  });

  test.each([
    ['missing block timestamp', (r: QueryResponse) => void (r.data.blocks = [])],
    ['malformed tx hash', (r: QueryResponse) => void (r.data.logs[0]!.transactionHash = 'nothex')],
    ['bad nextBlock', (r: QueryResponse) => void ((r as { nextBlock: unknown }).nextBlock = -1)]
  ])('rejects a malformed page (%s)', (_n, mutate) => {
    const r = realResponse();
    mutate(r);
    expect(() => assembleJoinAllPage(r)).toThrow('hypersync:');
  });

  test('orphan trigger logs become problems, not rows', () => {
    const p = parseNativeTx(tx(10, [trigExec(), trigReq(5, 3)]));
    expect(p.executions).toEqual([]);
    expect(p.placements).toEqual([]);
    expect(p.problems.map((x) => x.reason)).toEqual([
      'native: trigger execution without a preceding close order request',
      'native: trigger request without a preceding order request'
    ]);
  });

  test('two executions in one tx keep their own fills; a market placement and a limit placement are told apart', () => {
    const t = tx(20, [
      orderReq({ account: 1, type: 2, lots: 10, price: 90 }), trigExec(), takerFill(100, 4), takerFill(98, 6),
      orderReq({ account: 2, type: 3, lots: 5, price: 110 }), trigExec()
    ]);
    const [e1, e2] = parseNativeTx(t).executions;
    expect(e1).toMatchObject({ accountId: 1, filledLNS: 10, fillVwapPNS: 98, fillNotional: '988' });
    expect(e2).toMatchObject({ accountId: 2, filledLNS: 0, fillVwapPNS: null });
    expect(parseNativeTx(placeTx(1, { account: 1, type: 2, lots: 1, trigger: 50, price: 49 })).placements[0]).toMatchObject({ kind: 'limit', limitPNS: 49 });
    expect(parseNativeTx(placeTx(1, { account: 1, type: 2, lots: 1, trigger: 50 })).placements[0]).toMatchObject({ kind: 'market', limitPNS: null });
  });
});

describe('join rule', () => {
  const run = (txs: NativeTx[]) => {
    const p = parseNativeTxs(txs);
    return { p, j: joinNativeStops(p.placements, p.cancels, p.executions) };
  };

  test('cancel then re-place: the execution joins the new placement, the old one is cancelled', () => {
    const { p, j } = run([
      placeTx(100, { account: 9, type: 2, lots: 50, trigger: 1000 }),
      cancelTx(110, 9, 1000),
      placeTx(110, { account: 9, type: 2, lots: 50, trigger: 990 }),
      execTx(200, { account: 9, type: 2, lots: 50, limit: 980, fills: [[985, 50]] })
    ]);
    const e = p.executions[0]!;
    expect(j.executions.get(rowKey(e))).toMatchObject({ status: 'joined', placement: { triggerPNS: 990 } });
    expect(j.ended.get(rowKey(p.placements[0]!))).toMatchObject({ cancelledBlock: 110 });
    expect(slippageVsTriggerBps(p.placements[1]!, e)).toBe(50.51);
  });

  test('two live placements with the same key: ambiguous, joined to the latest, the earlier stays live', () => {
    const { p, j } = run([
      placeTx(100, { account: 9, type: 2, lots: 50, trigger: 1000 }),
      placeTx(105, { account: 9, type: 2, lots: 50, trigger: 995 }),
      execTx(200, { account: 9, type: 2, lots: 50, limit: 980, fills: [[990, 50]] }),
      execTx(300, { account: 9, type: 2, lots: 50, limit: 980, fills: [[990, 50]] })
    ]);
    expect(j.executions.get(rowKey(p.executions[0]!))).toMatchObject({ status: 'ambiguous', placement: { block: 105 } });
    // The second execution finds exactly one live placement left.
    expect(j.executions.get(rowKey(p.executions[1]!))).toMatchObject({ status: 'joined', placement: { block: 100 } });
  });

  test('partial fill still joins; other lots, other account, other side or a later placement do not', () => {
    const { p, j } = run([
      placeTx(100, { account: 9, type: 2, lots: 50, trigger: 1000 }),
      placeTx(101, { account: 7, type: 2, lots: 50, trigger: 1000 }),
      execTx(200, { account: 9, type: 2, lots: 50, limit: 980, fills: [[990, 20]] }),
      execTx(201, { account: 7, type: 2, lots: 40, limit: 980, fills: [[990, 40]] }),
      execTx(202, { account: 7, type: 3, lots: 50, limit: 1020, fills: [] }),
      execTx(203, { account: 5, type: 2, lots: 10, limit: 980, fills: [] }),
      placeTx(204, { account: 5, type: 2, lots: 10, trigger: 1000 })
    ]);
    const status = p.executions.map((e) => j.executions.get(rowKey(e))!.status);
    expect(status).toEqual(['joined', 'unjoined', 'unjoined', 'unjoined']);
    expect(p.executions[0]).toMatchObject({ filledLNS: 20, lotLNS: 50 });
  });
});

describe('metrics and percentiles', () => {
  test('nearest-rank p50 and p95', () => {
    expect(spread(Array.from({ length: 20 }, (_, i) => 20 - i))).toEqual({ n: 20, p50: 10, p95: 19, max: 20 });
    expect(spread([3.333])).toEqual({ n: 1, p50: 3.33, p95: 3.33, max: 3.33 });
    expect(spread([])).toEqual({ n: 0, p50: null, p95: null, max: null });
  });

  test('adverse bps sign: closing a long sells, closing a short buys', () => {
    expect(adverseBps(2, 990, 1000)).toBe(100);
    expect(adverseBps(2, 1010, 1000)).toBe(-100);
    expect(adverseBps(3, 1010, 1000)).toBe(100);
    expect(adverseBps(3, 990, 0)).toBeNull();
  });

  test('delay: mark already through at placement counts from the placement; last-price and never-crossed are null', () => {
    const e = parseNativeTx(execTx(110, { account: 1, type: 2, lots: 1, limit: 1, fills: [[95, 1]] })).executions[0]!;
    const base: Placement = parseNativeTx(placeTx(100, { account: 1, type: 2, lots: 1, trigger: 100, cond: 3 })).placements[0]!;
    expect(delayBlocks(base, e, marksFrom([[99, 99]]))).toBe(10);
    expect(delayBlocks(base, e, marksFrom([[99, 101], [106, 100]]))).toBe(4);
    expect(delayBlocks(base, e, marksFrom([[99, 101]]))).toBeNull();
    expect(delayBlocks({ ...base, condition: 1 }, e, marksFrom([[99, 99]]))).toBeNull();
    // Mark older than MAX_START_MARK_AGE_BLOCKS before execution: no mark slippage.
    expect(slippageVsMarkBps({ ...e, block: 1_000 }, marksFrom([[1, 100]]))).toBeNull();
    expect(slippageVsMarkBps(e, marksFrom([[1, 100]]))).toBe(500);
  });
});

describe('native stop store, joins and report', () => {
  const HEIGHT = 10_000;
  function source(pages: NativeTx[][]): NativeStopSource & { calls: [number, number][] } {
    const calls: [number, number][] = [];
    let i = 0;
    return {
      calls,
      getHeight: async () => HEIGHT,
      getPage: async (from, to) => {
        calls.push([from, to]);
        const txs = pages[i++] ?? [];
        return { txs, nextBlock: i >= pages.length ? to : from + 100 };
      }
    };
  }

  test('ingest pages, refresh joins, report per perp and per account', async () => {
    const db = openJobsDb(':memory:');
    // Marks for the delay: perp 1 crosses 1000 downward at block 7_100.
    commitPage(
      db,
      { ...emptyBatch(), marks: [{ block: 7_000, logIndex: 0, ts: 1, perpId: 1, pricePNS: 1_010 }, { block: 7_100, logIndex: 0, ts: 2, perpId: 1, pricePNS: 999 }] },
      { nextBlock: 7_101, windowFromBlock: 0, coverageFromBlock: 0 },
      't'
    );
    const src = source([
      [placeTx(7_050, { account: 9, type: 2, lots: 50, trigger: 1000 }), placeTx(7_060, { account: 4, type: 3, lots: 5, trigger: 2000, perp: 2 })],
      [execTx(7_104, { account: 9, type: 2, lots: 50, limit: 980, fills: [[995, 50]] }), execTx(7_200, { account: 3, type: 2, lots: 1, limit: 1, fills: [] })]
    ]);
    const r = await ingestNativeStops(db, src, { windowDays: 1, signal: new AbortController().signal, log: silent });
    expect(r).toMatchObject({ pages: 2, placements: 2, executions: 2, problems: 0, capped: false, toBlock: HEIGHT - CONFIRMATION_BLOCKS });
    expect(refreshNativeJoins(db)).toEqual({ executions: 2, joined: 1, ambiguous: 0, unjoined: 1 });

    const report = nativeStopReport(db, new Map([[1, 'BTC']]));
    expect(report.totals).toMatchObject({ placements: 2, cancels: 0, executions: 2, joined: 1, unjoined: 1, joinRate: 0.5, full: 1, unfilled: 1 });
    expect(report.totals.slippageVsTriggerBps).toEqual({ n: 1, p50: 50, p95: 50, max: 50 });
    expect(report.totals.delayBlocks).toEqual({ n: 1, p50: 4, p95: 4, max: 4 });
    expect(report.perps.map((p) => [p.perpId, p.symbol, p.executions])).toEqual([[1, 'BTC', 2]]);

    const mine = accountNativeStops(db, 9, 10);
    expect(mine).toEqual([
      expect.objectContaining({ perpId: 1, side: 'long', triggerPNS: 1000, condition: 'mark', kind: 'market', joinStatus: 'joined', executedBlock: 7_104, fillVwapPNS: 995, slippageVsTriggerBps: 50, delayBlocks: 4 })
    ]);
    expect(nativeStopSummary(mine)).toEqual({ count: 1, executed: 1, p50SlippageBps: 50, worstSlippageBps: 50 });
    expect(accountNativeStops(db, 4, 10)[0]).toMatchObject({ joinStatus: 'open', side: 'short' });
    expect(accountNativeStops(db, 3, 10)[0]).toMatchObject({ joinStatus: 'unjoined', placedBlock: null, executedBlock: 7_200 });

    // Rerun is idempotent: same rows, same joins.
    await ingestNativeStops(db, source([]), { windowDays: 1, signal: new AbortController().signal, log: silent });
    expect(refreshNativeJoins(db)).toEqual({ executions: 2, joined: 1, ambiguous: 0, unjoined: 1 });
    db.close();
  });

  test('a cycle stops at the page cap and resumes from the cursor', async () => {
    const db = openJobsDb(':memory:');
    let calls = 0;
    const endless: NativeStopSource = { getHeight: async () => 1_000_000, getPage: async (from) => (calls++, { txs: [], nextBlock: from + 1 }) };
    const r = await ingestNativeStops(db, endless, { windowDays: 1, signal: new AbortController().signal, log: silent });
    expect(r.capped).toBe(true);
    expect(calls).toBe(NATIVE_MAX_PAGES_PER_RUN);
    const again = await ingestNativeStops(db, endless, { windowDays: 1, signal: new AbortController().signal, log: silent });
    expect(again.fromBlock).toBe(r.toBlock);
    db.close();
  });
});
