import type { Hex } from 'viem';
import { decodePerplLog, type PerplEvent } from './perpl.ts';

export interface RawLog {
  blockNumber: number;
  logIndex: number;
  transactionHash: Hex;
  topics: Hex[];
  data: Hex;
}

// Type aliases, not interfaces: they must be assignable to bun:sqlite binding records.
type At = {
  block: number;
  logIndex: number;
  ts: number;
};

export type MarkRow = At & {
  perpId: number;
  pricePNS: number;
};
export type OracleRow = At & {
  perpId: number;
  pricePNS: number;
  reportTs: number;
};
export type RejectionKind = 'oracle_report_not_newer' | 'oracle_update_failed' | 'mark_exceeds_tol';
export type RejectionRow = At & {
  perpId: number;
  kind: RejectionKind;
};
export type FillRow = At & {
  perpId: number;
  accountId: number;
  orderId: number;
  pricePNS: number;
  lotLNS: number;
  feeCNS: string;
  txHash: Hex;
};
export type PositionKind = 'open' | 'increase' | 'decrease' | 'close' | 'invert' | 'liquidation' | 'deleverage';
export type PositionRow = At & {
  perpId: number;
  accountId: number;
  kind: PositionKind;
  positionType: number;
  /** open: entry; increase: new average entry; close: exit VWAP; invert: as emitted; liquidation: liqPrice; deleverage: deleveragePrice. */
  pricePNS: number | null;
  lotBeforeLNS: number | null;
  lotAfterLNS: number | null;
  deltaPnlCNS: string | null;
  fundingCNS: string | null;
  txHash: Hex;
  /** PositionLiquidated fields as emitted; null for other kinds. */
  liqLotLNS: number | null;
  posLotLNS: number | null;
};
export type CollateralRow = At & {
  accountId: number;
  kind: 'deposit' | 'withdrawal';
  amountCNS: string;
  balanceCNS: string;
  txHash: Hex;
};
/** A log that could not be decoded or mapped; stored instead of halting ingest. */
export type QuarantineRow = {
  block: number;
  logIndex: number;
  txHash: Hex;
  topic0: Hex | null;
  data: string;
  reason: string;
};

export interface RowBatch {
  marks: MarkRow[];
  oracle: OracleRow[];
  rejections: RejectionRow[];
  fills: FillRow[];
  positions: PositionRow[];
  collateral: CollateralRow[];
  quarantined: QuarantineRow[];
}

export const emptyBatch = (): RowBatch => ({
  marks: [],
  oracle: [],
  rejections: [],
  fills: [],
  positions: [],
  collateral: [],
  quarantined: []
});

export const batchRowCount = (b: RowBatch): number =>
  b.marks.length + b.oracle.length + b.rejections.length + b.fills.length + b.positions.length + b.collateral.length;

/** PNS, LNS and ids fit in 2^53 (uint32/uint40 onchain); anything larger is corrupt input. */
export function safeNum(v: bigint, field: string): number {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${field} out of safe integer range`);
  return Number(v);
}

const MAX_REASON = 300;
const MAX_DATA = 16_384;

function quarantine(log: RawLog, stage: string, err: unknown): QuarantineRow {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    block: log.blockNumber,
    logIndex: log.logIndex,
    txHash: log.transactionHash,
    topic0: log.topics[0] ?? null,
    data: log.data.length > MAX_DATA ? `${log.data.slice(0, MAX_DATA)}...` : log.data,
    reason: `${stage}: ${msg}`.slice(0, MAX_REASON)
  };
}

/**
 * Decodes Exchange logs into store rows; a log that fails to decode or map is quarantined, not fatal.
 * @throws when a log's block has no timestamp (the page itself is incomplete, so retry it).
 */
export function logsToRows(logs: readonly RawLog[], blockTs: ReadonlyMap<number, number>): RowBatch {
  const out = emptyBatch();
  const decoded: { log: RawLog; ev: PerplEvent; at: At }[] = [];
  for (const log of logs) {
    const ts = blockTs.get(log.blockNumber);
    if (ts === undefined) throw new Error(`missing timestamp for block ${log.blockNumber}`);
    let ev: PerplEvent | null;
    try {
      ev = decodePerplLog(log.topics, log.data);
    } catch (err) {
      out.quarantined.push(quarantine(log, 'decode', err));
      continue;
    }
    if (ev) decoded.push({ log, ev, at: { block: log.blockNumber, logIndex: log.logIndex, ts } });
  }

  // UpdateOracleFailed with a ReportAgeExceedsLastUpdate(validFrom <= last) anywhere in the same tx
  // is a duplicate report, not a broken oracle (seen live: tx 0x6851...8dc0).
  const notNewer = new Set<string>();
  for (const { log, ev } of decoded) {
    if (ev.eventName === 'ReportAgeExceedsLastUpdate' && ev.args.reportValidFromTimestamp <= ev.args.lastUpdateTimestamp) {
      notNewer.add(`${log.transactionHash}:${ev.args.perpId}`);
    }
  }

  for (const d of decoded) {
    try {
      mapEvent(out, d.ev, d.at, d.log.transactionHash, notNewer);
    } catch (err) {
      out.quarantined.push(quarantine(d.log, 'map', err));
    }
  }
  return out;
}

// Each case builds its row before pushing, so a throw leaves `out` untouched.
function mapEvent(out: RowBatch, ev: PerplEvent, at: At, tx: Hex, notNewer: ReadonlySet<string>): void {
  switch (ev.eventName) {
    case 'MarkUpdated':
      out.marks.push({ ...at, perpId: safeNum(ev.args.perpId, 'perpId'), pricePNS: safeNum(ev.args.pricePNS, 'pricePNS') });
      return;
    case 'LinkPriceUpdated':
      out.oracle.push({
        ...at,
        perpId: safeNum(ev.args.perpId, 'perpId'),
        pricePNS: safeNum(ev.args.oraclePricePNS, 'oraclePricePNS'),
        reportTs: safeNum(ev.args.timestamp, 'timestamp')
      });
      return;
    case 'UpdateOracleFailed':
      out.rejections.push({
        ...at,
        perpId: safeNum(ev.args.perpId, 'perpId'),
        kind: notNewer.has(`${tx}:${ev.args.perpId}`) ? 'oracle_report_not_newer' : 'oracle_update_failed'
      });
      return;
    case 'MarkExceedsTol':
      out.rejections.push({ ...at, perpId: safeNum(ev.args.perpId, 'perpId'), kind: 'mark_exceeds_tol' });
      return;
    case 'MakerOrderFilledV2':
      out.fills.push({
        ...at,
        perpId: safeNum(ev.args.perpId, 'perpId'),
        accountId: safeNum(ev.args.accountId, 'accountId'),
        orderId: safeNum(ev.args.orderId, 'orderId'),
        pricePNS: safeNum(ev.args.pricePNS, 'pricePNS'),
        lotLNS: safeNum(ev.args.lotLNS, 'lotLNS'),
        feeCNS: ev.args.feeCNS.toString(),
        txHash: tx
      });
      return;
    case 'PositionOpenedV2':
      out.positions.push(position(at, tx, ev.args, 'open', { price: ev.args.pricePNS, before: 0n, after: ev.args.lotLNS }));
      return;
    case 'PositionIncreasedV2':
      out.positions.push(
        position(at, tx, ev.args, 'increase', { price: ev.args.pricePNS, before: ev.args.startLotLNS, after: ev.args.endLotLNS })
      );
      return;
    case 'PositionDecreased':
      out.positions.push(
        position(at, tx, ev.args, 'decrease', {
          before: ev.args.startLotLNS,
          after: ev.args.endLotLNS,
          pnl: ev.args.deltaPnlCNS,
          funding: ev.args.fundingCNS
        })
      );
      return;
    case 'PositionClosed':
      out.positions.push(
        position(at, tx, ev.args, 'close', { price: ev.args.pricePNS, after: 0n, pnl: ev.args.deltaPnlCNS, funding: ev.args.fundingCNS })
      );
      return;
    case 'PositionInverted':
      out.positions.push(
        position(at, tx, ev.args, 'invert', {
          price: ev.args.pricePNS,
          before: ev.args.startLotLNS,
          after: ev.args.endLotLNS,
          pnl: ev.args.deltaPnlCNS,
          funding: ev.args.fundingCNS
        })
      );
      return;
    case 'PositionLiquidated': {
      const a = ev.args;
      out.positions.push(
        position(at, tx, { perpId: a.perpId, accountId: a.posAccountId, positionType: a.positionType }, 'liquidation', {
          price: a.liqPricePNS,
          pnl: a.deltaPnlCNS,
          funding: a.fundingCNS,
          liqLot: a.liqLotLNS,
          posLot: a.posLotLNS
        })
      );
      return;
    }
    case 'PositionDeleveragedV2':
      out.positions.push(
        position(at, tx, ev.args, 'deleverage', {
          price: ev.args.deleveragePricePNS,
          before: ev.args.startLotLNS,
          after: ev.args.endLotLNS,
          pnl: ev.args.deltaPnlCNS,
          funding: ev.args.fundingCNS
        })
      );
      return;
    case 'CollateralDeposit':
    case 'CollateralWithdrawal':
      out.collateral.push({
        ...at,
        accountId: safeNum(ev.args.accountId, 'accountId'),
        kind: ev.eventName === 'CollateralDeposit' ? 'deposit' : 'withdrawal',
        amountCNS: ev.args.amountCNS.toString(),
        balanceCNS: ev.args.balanceCNS.toString(),
        txHash: tx
      });
      return;
    case 'ReportAgeExceedsLastUpdate':
      return;
  }
}

interface PositionFields {
  price?: bigint;
  before?: bigint;
  after?: bigint;
  pnl?: bigint;
  funding?: bigint;
  liqLot?: bigint;
  posLot?: bigint;
}

const opt = (v: bigint | undefined, field: string) => (v === undefined ? null : safeNum(v, field));

function position(
  at: At,
  txHash: Hex,
  ids: { perpId: bigint; accountId: bigint; positionType: number },
  kind: PositionKind,
  f: PositionFields
): PositionRow {
  return {
    ...at,
    perpId: safeNum(ids.perpId, 'perpId'),
    accountId: safeNum(ids.accountId, 'accountId'),
    kind,
    positionType: ids.positionType,
    pricePNS: opt(f.price, 'pricePNS'),
    lotBeforeLNS: opt(f.before, 'lotLNS'),
    lotAfterLNS: opt(f.after, 'lotLNS'),
    deltaPnlCNS: f.pnl === undefined ? null : f.pnl.toString(),
    fundingCNS: f.funding === undefined ? null : f.funding.toString(),
    txHash,
    liqLotLNS: opt(f.liqLot, 'liqLotLNS'),
    posLotLNS: opt(f.posLot, 'posLotLNS')
  };
}
