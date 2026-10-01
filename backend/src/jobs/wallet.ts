import { formatUnits } from 'viem';
import { AUSD_DECIMALS } from '../lib/addresses.ts';
import type { Database } from '../lib/db.ts';
import { MAX_START_MARK_AGE_BLOCKS } from './config.ts';
import { accountNativeStops, nativeStopSummary, type AccountNativeStop } from './native-ingest.ts';
import type { PerpMeta } from './perpl.ts';
import { round2 } from './stats.ts';
import { accountEvents, getIngestState, listPerps, markAtOrBefore, readAccountTotals } from './store.ts';

export const WALLET_METHOD = {
  version: 'gapless-wallet/2',
  scope: 'Perpl Exchange events for one account id inside the jobs window (MakerOrderFilledV2, Position*, Collateral*)',
  takerFills: 'TakerOrderFilledV2 has no account id, so taker activity shows through Position* events, not in fills',
  exitVsLastMark: `PositionClosed price (exit VWAP) vs the latest onchain mark from an earlier block within ${MAX_START_MARK_AGE_BLOCKS} blocks; positive bps = worse than that mark for the closing side. Includes mark lag (the mark publishes on 5 bps moves, about every 50 s when calm) and does not tell stop closes from manual ones, so it is not stop slippage`,
  liquidation: 'liqLots and posLots are PositionLiquidated liqLotLNS and posLotLNS as emitted; their exact meaning is unverified, so no size is derived',
  totals:
    'whole-window aggregates precomputed by the jobs process each cycle (asOfBlock); null until the first cycle. deltaPnl sums deltaPnlCNS as emitted on decrease, close, invert, liquidation and deleverage (price PnL, before fees)',
  nativeStops:
    'Perpl native stops of this account in the jobs window (native-stops.json method): placements with their joined execution, plus executions no placement could be joined to (joinStatus unjoined). slippageVsTriggerBps only for joinStatus joined; positive = worse for the closing side',
  gapless: 'present when the address is a Gapless owner or account (factory AccountCreated); cover status from the latest lifecycle event; paidCNS = Finalized totalPaid, else the sum of Triggered paidNow'
} as const;

const side = (positionType: number) => (positionType === 0 ? 'long' : positionType === 1 ? 'short' : 'unknown');
const fmt = (v: number | null, decimals: number | undefined) =>
  v === null || decimals === undefined ? null : formatUnits(BigInt(v), decimals);
const ausd = (v: string | bigint | null) => (v === null ? null : formatUnits(BigInt(v), AUSD_DECIMALS));

/** Adverse bps of an exit vs mark: long closes sell, short closes buy. */
export function exitVsMarkBps(positionType: number, exitPNS: number, markPNS: number): number | null {
  if (markPNS <= 0) return null;
  if (positionType === 0) return round2(((markPNS - exitPNS) / markPNS) * 1e4);
  if (positionType === 1) return round2(((exitPNS - markPNS) / markPNS) * 1e4);
  return null;
}

/** Native stops; empty when the store predates migration 3 (relay deployed before jobs) or has none. */
function nativeStopsOf(db: Database, accountId: number, limit: number): AccountNativeStop[] {
  try {
    return accountNativeStops(db, accountId, limit);
  } catch {
    return [];
  }
}

/** Totals plus the `limit` most recent rows per table (bounded work: index range scans, at most limit mark lookups). */
export function buildWalletHistory(db: Database, accountId: number, limit: number) {
  const perps = new Map<number, PerpMeta>(listPerps(db).map((p) => [p.perpId, p]));
  const state = getIngestState(db);
  const ev = accountEvents(db, accountId, limit);
  const totals = readAccountTotals(db, accountId);
  const symbol = (id: number) => perps.get(id)?.symbol ?? null;

  const positions = ev.positions.map((p) => {
    const meta = perps.get(p.perpId);
    let exitVsLastMark: { markPNS: number; markBlock: number; bps: number | null } | null = null;
    if (p.kind === 'close' && p.pricePNS !== null) {
      const m = markAtOrBefore(db, p.perpId, p.block - 1);
      if (m && p.block - m.block <= MAX_START_MARK_AGE_BLOCKS) {
        exitVsLastMark = { markPNS: m.pricePNS, markBlock: m.block, bps: exitVsMarkBps(p.positionType, p.pricePNS, m.pricePNS) };
      }
    }
    return {
      block: p.block,
      logIndex: p.logIndex,
      ts: p.ts,
      txHash: p.txHash,
      perpId: p.perpId,
      symbol: symbol(p.perpId),
      kind: p.kind,
      side: side(p.positionType),
      pricePNS: p.pricePNS,
      price: fmt(p.pricePNS, meta?.priceDecimals),
      lotsBefore: fmt(p.lotBeforeLNS, meta?.lotDecimals),
      lotsAfter: fmt(p.lotAfterLNS, meta?.lotDecimals),
      liquidation:
        p.kind === 'liquidation' ? { liqLots: fmt(p.liqLotLNS, meta?.lotDecimals), posLots: fmt(p.posLotLNS, meta?.lotDecimals) } : null,
      deltaPnl: ausd(p.deltaPnlCNS),
      funding: ausd(p.fundingCNS),
      exitVsLastMark
    };
  });

  const fills = ev.fills.map((f) => {
    const meta = perps.get(f.perpId);
    const scaleExp = meta ? 6 - meta.priceDecimals - meta.lotDecimals : null;
    // notionalCNS = price x lots x 10^(6 - pd - ld) (01 §3.3)
    const notionalCNS =
      scaleExp === null || scaleExp < 0 ? null : BigInt(f.pricePNS) * BigInt(f.lotLNS) * 10n ** BigInt(scaleExp);
    return {
      block: f.block,
      logIndex: f.logIndex,
      ts: f.ts,
      txHash: f.txHash,
      perpId: f.perpId,
      symbol: symbol(f.perpId),
      orderId: f.orderId,
      price: fmt(f.pricePNS, meta?.priceDecimals),
      lots: fmt(f.lotLNS, meta?.lotDecimals),
      notional: notionalCNS === null ? null : ausd(notionalCNS),
      fee: ausd(f.feeCNS)
    };
  });

  const collateral = ev.collateral.map((c) => ({
    block: c.block,
    logIndex: c.logIndex,
    ts: c.ts,
    txHash: c.txHash,
    kind: c.kind,
    amount: ausd(c.amountCNS),
    balance: ausd(c.balanceCNS)
  }));

  const nativeStops = nativeStopsOf(db, accountId, limit).map((n) => {
    const meta = perps.get(n.perpId);
    return { ...n, symbol: symbol(n.perpId), lots: fmt(n.lotLNS, meta?.lotDecimals) };
  });

  return {
    accountId: String(accountId),
    window: state ? { fromBlock: Math.max(state.windowFromBlock, state.coverageFromBlock), toBlock: state.nextBlock } : null,
    limit,
    totals: totals && {
      asOfBlock: totals.asOfBlock,
      positionEvents: totals.positionEvents,
      liquidations: totals.positionEvents.liquidation,
      makerFills: totals.makerFills,
      deltaPnl: ausd(totals.deltaPnlCNS),
      funding: ausd(totals.fundingCNS)
    },
    positions,
    fills,
    collateral,
    nativeStops,
    nativeStopSummary: nativeStopSummary(nativeStops),
    method: WALLET_METHOD
  };
}

/** Same shape for a Gapless owner or account whose Perpl account does not exist yet. */
export function emptyWalletHistory(db: Database, limit: number): Omit<WalletHistory, 'accountId'> & { accountId: null } {
  const state = getIngestState(db);
  return {
    accountId: null,
    window: state ? { fromBlock: Math.max(state.windowFromBlock, state.coverageFromBlock), toBlock: state.nextBlock } : null,
    limit,
    totals: null,
    positions: [],
    fills: [],
    collateral: [],
    nativeStops: [],
    nativeStopSummary: nativeStopSummary([]),
    method: WALLET_METHOD
  };
}

export type WalletHistory = ReturnType<typeof buildWalletHistory>;
