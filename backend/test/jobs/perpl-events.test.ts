import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { decodeEventLog, parseAbi, toEventSelector, toEventSignature, type AbiEvent, type Hex } from 'viem';
import { PERPL_EVENTS_ABI, PERPL_TOPICS, decodePerplLog, perpIdsFromBitmap } from '../../src/jobs/perpl.ts';
import { logsToRows, type RawLog } from '../../src/jobs/rows.ts';
import { encodeLog } from './synthetic.ts';

// Real Perpl Exchange logs from Monad mainnet, fetched read-only via public RPC (test-only).
const fixture = JSON.parse(readFileSync(new URL('../fixtures/perpl-logs.mainnet.json', import.meta.url), 'utf8')) as {
  singles: { event: string; blockNumber: number; transactionHash: Hex; logIndex: number; topics: Hex[]; data: Hex }[];
  receipts: { transactionHash: Hex; blockNumber: number; logs: { event: string | null; logIndex: number; topics: Hex[]; data: Hex }[] }[];
};

const ABI_PATH = new URL('../../../gapless/perpl-fork-gate/Exchange.abi.json', import.meta.url);

describe('Perpl event ABI', () => {
  test.skipIf(!existsSync(ABI_PATH))('matches Exchange.abi.json: signature, param names, no indexed params', () => {
    const raw = JSON.parse(readFileSync(ABI_PATH, 'utf8')) as AbiEvent[] | { abi: AbiEvent[] };
    const fileEvents = (Array.isArray(raw) ? raw : raw.abi).filter((x) => x.type === 'event');
    for (const ev of PERPL_EVENTS_ABI) {
      const ref = fileEvents.find((e) => e.name === ev.name);
      expect(ref, ev.name).toBeDefined();
      expect(toEventSignature(ev)).toBe(toEventSignature(ref!));
      const names: (string | undefined)[] = ev.inputs.map((i) => i.name);
      expect(names).toEqual(ref!.inputs.map((i) => i.name));
      expect(ref!.inputs.some((i) => i.indexed)).toBe(false);
      expect(toEventSelector(ev)).toBe(toEventSelector(ref!));
    }
  });

  test('topic0 values for the gap-history events equal keccak of the canonical signatures (04 §2.4)', () => {
    const byName = Object.fromEntries(PERPL_EVENTS_ABI.map((e, i) => [e.name, PERPL_TOPICS[i]]));
    expect(byName.MakerOrderFilledV2).toBe('0xa59d6df87b5cb9e8cca8c09e8f1e240b7a1d4a2ee8f6c636c12ce22b43b82d70');
    expect(byName.MarkUpdated).toBe('0x65ec400f2e8b22c7064f99991d01828c6a55acaa066b3fdba3bf5a491b1a6a4c');
    expect(byName.LinkPriceUpdated).toBe('0x5e3f1c81da4dcfcb835cba6457aa389114f5d309917179746b46ac03953f56b2');
    expect(byName.UpdateOracleFailed).toBe('0xa8c2945f7db53a36d192551c9b4c3ea4cbc53140f60d0dc8b1a8b58499958cdf');
    expect(byName.PositionClosed).toBe('0x599b5f439ed4daf1f28ae8638e5439d3982e8001fb26dd8f70021b38672eb26f');
    expect(byName.PositionLiquidated).toBe('0x6fc9c0ea1c0531654320ba06740c802447dbdef7c26cf749c4f12553cdd958a9');
    expect(new Set(PERPL_TOPICS).size).toBe(PERPL_TOPICS.length);
  });
});

describe('decoding real mainnet logs', () => {
  test('every sampled event of ours decodes; foreign topics return null', () => {
    const ours = new Set<string>(PERPL_EVENTS_ABI.map((e) => e.name));
    for (const s of fixture.singles) {
      const ev = decodePerplLog(s.topics, s.data);
      if (ours.has(s.event)) expect(ev?.eventName).toBe(s.event as never);
      else expect(ev).toBeNull();
    }
    expect(fixture.singles.some((s) => s.event === 'MarkUpdated')).toBe(true);
    expect(fixture.singles.some((s) => s.event === 'MakerOrderFilledV2')).toBe(true);
  });

  test('MarkUpdated carries a listed perp id and a positive PNS price', () => {
    const s = fixture.singles.find((x) => x.event === 'MarkUpdated')!;
    const ev = decodePerplLog(s.topics, s.data);
    if (ev?.eventName !== 'MarkUpdated') throw new Error('expected MarkUpdated');
    expect([1, 10, 20, 30, 31, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]).toContain(Number(ev.args.perpId));
    expect(ev.args.pricePNS > 0n).toBe(true);
  });

  test('close tx 0x5b91...3674: PositionClosed.pricePNS equals the taker fill price', () => {
    const r = fixture.receipts.find((x) => x.transactionHash.startsWith('0x5b919d2d'))!;
    const raws: RawLog[] = r.logs.map((l) => ({ ...l, blockNumber: r.blockNumber, transactionHash: r.transactionHash }));
    const rows = logsToRows(raws, new Map([[r.blockNumber, 1_791_180_100]]));

    const close = rows.positions.find((p) => p.kind === 'close')!;
    expect(close).toMatchObject({ perpId: 40, accountId: 4739, positionType: 1, pricePNS: 917_134, lotAfterLNS: 0 });
    expect(close.deltaPnlCNS).toBe('-10802906');
    expect(close.fundingCNS).toBe('308670');

    const takerAbi = parseAbi([
      'event TakerOrderFilledV2(uint256 entryPricePNS, uint256 collatPricePNS, uint256 pnlPricePNS, uint256 lotLNS, uint256 feeCNS, int256 amountCNS, uint256 balanceCNS, uint256 builderId, uint256 builderFeeCNS)'
    ]);
    const takerLog = r.logs.find((l) => l.event === 'TakerOrderFilledV2')!;
    const taker = decodeEventLog({ abi: takerAbi, topics: takerLog.topics as [Hex], data: takerLog.data });
    expect(Number((taker.args as { collatPricePNS: bigint }).collatPricePNS)).toBe(close.pricePNS!);

    expect(rows.fills.map((f) => [f.accountId, f.pricePNS, f.lotLNS])).toEqual([
      [5346, 916_886, 10],
      [4638, 917_136, 1092]
    ]);
    expect(rows.positions.filter((p) => p.kind === 'increase').map((p) => p.accountId)).toEqual([5346, 4638]);
    expect(rows.fills.every((f) => f.txHash === r.transactionHash && f.ts === 1_791_180_100)).toBe(true);
  });

  test('oracle tx 0x6851...8dc0: failure after a not-newer report is classified as a duplicate', () => {
    const r = fixture.receipts.find((x) => x.transactionHash.startsWith('0x68514704'))!;
    const raws: RawLog[] = r.logs.map((l) => ({ ...l, blockNumber: r.blockNumber, transactionHash: r.transactionHash }));
    const rows = logsToRows(raws, new Map([[r.blockNumber, 1]]));
    expect(rows.rejections.length).toBeGreaterThan(0);
    expect(rows.rejections.every((x) => x.kind === 'oracle_report_not_newer')).toBe(true);
    expect(rows.rejections.map((x) => x.perpId)).toContain(1);
  });

  test('an UpdateOracleFailed without a not-newer report counts as a real failure', () => {
    const r = fixture.receipts.find((x) => x.transactionHash.startsWith('0x68514704'))!;
    const failed = r.logs.find((l) => l.event === 'UpdateOracleFailed')!;
    const rows = logsToRows(
      [{ ...failed, blockNumber: r.blockNumber, transactionHash: r.transactionHash }],
      new Map([[r.blockNumber, 1]])
    );
    expect(rows.rejections).toEqual([
      { block: r.blockNumber, logIndex: failed.logIndex, ts: 1, perpId: 1, kind: 'oracle_update_failed' }
    ]);
  });

  test('refuses a page whose block timestamp is missing', () => {
    const s = fixture.singles.find((x) => x.event === 'MarkUpdated')!;
    expect(() => logsToRows([s as RawLog], new Map())).toThrow('missing timestamp');
  });
});

describe('row mapping (ABI-encoded test-only values)', () => {
  const ts = (b: number) => new Map([[b, 1_000]]);

  test('liquidation stores liqLotLNS and posLotLNS as emitted, derives no sizes', () => {
    // posLot < liqLot would make the old posLot - liqLot negative and halt ingest.
    const log = encodeLog('PositionLiquidated', {
      perpId: 1n, posAccountId: 77n, positionType: 0, markPricePNS: 830_000n, liqPricePNS: 829_500n, liqLotLNS: 500n,
      posLotLNS: 200n, deltaPnlCNS: -1_234n, fundingCNS: 5n, posAmountCNS: -9n, posDepositCNS: 10n, accAmountCNS: 1n,
      accBalanceCNS: 2n, onOrderBook: true
    }, 10, 0);
    const rows = logsToRows([log], ts(10));
    expect(rows.quarantined).toEqual([]);
    expect(rows.positions).toEqual([
      {
        block: 10, logIndex: 0, ts: 1_000, perpId: 1, accountId: 77, kind: 'liquidation', positionType: 0, pricePNS: 829_500,
        lotBeforeLNS: null, lotAfterLNS: null, deltaPnlCNS: '-1234', fundingCNS: '5', txHash: log.transactionHash,
        liqLotLNS: 500, posLotLNS: 200
      }
    ]);
  });

  test('invert and deleverage keep start and end lots and their own price fields', () => {
    const inv = encodeLog('PositionInverted', {
      perpId: 10n, accountId: 5n, positionType: 1, leverageHdths: 1_000n, startDepositCNS: 1n, endDepositCNS: 2n,
      pnlCollateralizedCNS: 0n, pricePNS: 33_000n, startLotLNS: 40n, endLotLNS: 15n, deltaPnlCNS: 7n, fundingCNS: -1n,
      insFeeCNS: 0n, protFeeCNS: 0n
    }, 10, 0);
    const del = encodeLog('PositionDeleveragedV2', {
      perpId: 10n, accountId: 6n, forceClose: false, positionType: 0, entryPricePNS: 34_000n, markPricePNS: 33_100n,
      deleveragePricePNS: 33_050n, deltaPnlCNS: -70n, fundingCNS: 0n, startDepositCNS: 9n, endDepositCNS: 4n,
      startLotLNS: 100n, endLotLNS: 60n, amountCNS: 1n, balanceCNS: 2n, priceResiduePNSQ16: 0n
    }, 10, 1);
    const rows = logsToRows([inv, del], ts(10));
    expect(rows.positions.map((p) => [p.kind, p.accountId, p.pricePNS, p.lotBeforeLNS, p.lotAfterLNS, p.deltaPnlCNS, p.liqLotLNS])).toEqual([
      ['invert', 5, 33_000, 40, 15, '7', null],
      ['deleverage', 6, 33_050, 100, 60, '-70', null]
    ]);
  });

  test('an undecodable or out-of-range log is quarantined and the rest of the page still maps', () => {
    const good = encodeLog('MarkUpdated', { perpId: 1n, pricePNS: 830_000n }, 10, 0);
    const truncated: RawLog = { ...encodeLog('MarkUpdated', { perpId: 1n, pricePNS: 1n }, 10, 1), data: '0x01' };
    const huge = encodeLog('MarkUpdated', { perpId: 1n, pricePNS: 2n ** 60n }, 10, 2);
    const rows = logsToRows([good, truncated, huge], ts(10));
    expect(rows.marks.map((m) => m.logIndex)).toEqual([0]);
    expect(rows.quarantined.map((q) => [q.logIndex, q.reason.split(':')[0], q.topic0])).toEqual([
      [1, 'decode', good.topics[0]],
      [2, 'map', good.topics[0]]
    ]);
    expect(rows.quarantined[1]!.reason).toContain('pricePNS out of safe integer range');
    expect(rows.quarantined[0]!.data).toBe('0x01');
  });
});

test('perpIdsFromBitmap reads bits across words', () => {
  // Live bitmap word 0 on 2026-10-05 has bits 1, 10, 20, ...; word 1 bit 0 is perp 256.
  expect(perpIdsFromBitmap([(1n << 1n) | (1n << 10n) | (1n << 150n), 1n, 0n, 0n])).toEqual([1, 10, 150, 256]);
});
