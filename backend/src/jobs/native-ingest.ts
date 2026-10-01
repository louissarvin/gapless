import { JoinMode, type Query, type QueryResponse } from '@envio-dev/hypersync-client';
import { getAddress, type Address, type Hex } from 'viem';
import { PERPL_EXCHANGE } from '../lib/addresses.ts';
import type { Database } from '../lib/db.ts';
import type { Logger } from '../lib/log.ts';
import { CONFIRMATION_BLOCKS } from './config.ts';
import type { HypersyncLike } from './hypersync.ts';
import { windowBlocks } from './hypersync.ts';
import {
  delayBlocks,
  joinNativeStops,
  parseNativeTxs,
  rowKey,
  slippageVsMarkBps,
  slippageVsTriggerBps,
  spread,
  TRIGGER_TOPICS,
  type Cancel,
  type CloseType,
  type Execution,
  type JoinStatus,
  type MarkLookup,
  type NativeTx,
  type ParsedNative,
  type Placement
} from './native-stops.ts';
import type { RawLog } from './rows.ts';
import { markAtOrBefore } from './store.ts';

export interface NativePage {
  txs: NativeTx[];
  nextBlock: number;
}

/** What native-stop ingest needs from HyperSync; tests pass a fake. */
export interface NativeStopSource {
  getHeight(): Promise<number>;
  getPage(fromBlock: number, toBlock: number): Promise<NativePage>;
}

/** Bounds one response: a placement batch from a market maker can carry hundreds of logs (JoinAll returns all). */
export const NATIVE_MAX_TXS_PER_PAGE = 2_000;
/** Pages per cycle (5 s server limit each, so about 5 min worst case before the Gap Index runs); the rest continues next cycle. */
export const NATIVE_MAX_PAGES_PER_RUN = 60;

export const NATIVE_QUERY_FIELDS = {
  log: ['BlockNumber', 'LogIndex', 'TransactionHash', 'Address', 'Data', 'Topic0'],
  transaction: ['Hash', 'From', 'Input'],
  block: ['Number', 'Timestamp']
} as const satisfies Query['fieldSelection'];

export function nativeStopQuery(fromBlock: number, toBlock: number): Query {
  return {
    fromBlock,
    toBlock,
    logs: [{ address: [PERPL_EXCHANGE], topics: [[...TRIGGER_TOPICS]] }],
    fieldSelection: {
      log: [...NATIVE_QUERY_FIELDS.log],
      transaction: [...NATIVE_QUERY_FIELDS.transaction],
      block: [...NATIVE_QUERY_FIELDS.block]
    },
    joinMode: JoinMode.JoinAll,
    maxNumTransactions: NATIVE_MAX_TXS_PER_PAGE
  };
}

const HEX = /^0x[0-9a-fA-F]*$/;
const asHex = (v: unknown, field: string): Hex => {
  if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`hypersync: bad ${field}`);
  return v.toLowerCase() as Hex;
};
const asInt = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`hypersync: bad ${field}`);
  return v;
};
const asAddr = (v: unknown): Address | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : null);

/**
 * Groups a JoinAll response into txs: Exchange logs only (JoinAll also returns other contracts' logs, such as AUSD
 * transfers), sorted by logIndex, with the tx sender and calldata. HyperSync pages end on whole block groups, so a
 * tx is never split across pages. A malformed field or a missing block timestamp fails the page (retried).
 */
export function assembleJoinAllPage(res: QueryResponse): NativePage {
  const ts = new Map<number, number>();
  for (const b of res.data.blocks) ts.set(asInt(b.number, 'block.number'), asInt(b.timestamp, 'block.timestamp'));
  const meta = new Map<string, { from: Address | null; input: Hex | null }>();
  for (const t of res.data.transactions) {
    if (t.hash === undefined) continue;
    meta.set(asHex(t.hash, 'tx.hash'), { from: asAddr(t.from), input: t.input === undefined || t.input === null ? null : asHex(t.input, 'tx.input') });
  }
  const exchange = PERPL_EXCHANGE.toLowerCase();
  const byTx = new Map<string, NativeTx>();
  for (const l of res.data.logs) {
    if (typeof l.address !== 'string' || l.address.toLowerCase() !== exchange) continue;
    const block = asInt(l.blockNumber, 'log.blockNumber');
    const hash = asHex(l.transactionHash, 'log.transactionHash');
    const blockTs = ts.get(block);
    if (blockTs === undefined) throw new Error(`hypersync: missing timestamp for block ${block}`);
    const log: RawLog = {
      blockNumber: block,
      logIndex: asInt(l.logIndex, 'log.logIndex'),
      transactionHash: hash,
      topics: l.topics.filter((t): t is string => typeof t === 'string').map((t) => asHex(t, 'log.topic')),
      data: asHex(l.data ?? '0x', 'log.data')
    };
    let tx = byTx.get(hash);
    if (!tx) {
      const m = meta.get(hash);
      tx = { hash, block, ts: blockTs, from: m?.from ?? null, input: m?.input ?? null, logs: [] };
      byTx.set(hash, tx);
    }
    tx.logs.push(log);
  }
  const txs = [...byTx.values()].sort((a, b) => a.block - b.block || (a.logs[0]?.logIndex ?? 0) - (b.logs[0]?.logIndex ?? 0));
  for (const tx of txs) tx.logs.sort((a, b) => a.logIndex - b.logIndex);
  return { txs, nextBlock: asInt(res.nextBlock, 'nextBlock') };
}

export function createNativeStopSource(client: HypersyncLike): NativeStopSource {
  return {
    getHeight: () => client.getHeight(),
    getPage: async (fromBlock, toBlock) => assembleJoinAllPage(await client.get(nativeStopQuery(fromBlock, toBlock)))
  };
}

interface NativeState {
  nextBlock: number;
  windowFromBlock: number;
  coverageFromBlock: number;
}

export function getNativeState(db: Database): NativeState | null {
  const row = db
    .query<{ next_block: number; window_from_block: number; coverage_from_block: number }, []>(
      'SELECT next_block, window_from_block, coverage_from_block FROM native_stop_state WHERE id = 1'
    )
    .get();
  return row ? { nextBlock: row.next_block, windowFromBlock: row.window_from_block, coverageFromBlock: row.coverage_from_block } : null;
}

/** Inserts one page and moves the cursor in one transaction; the cursor never moves backwards. */
export function commitNativePage(db: Database, p: ParsedNative, state: NativeState, nowIso: string): void {
  const ins = {
    placement: db.query(
      `INSERT OR IGNORE INTO native_stop_placements (block, log_index, ts, tx_hash, account_id, perp_id, close_type, lot_lns,
         trigger_pns, condition, kind, limit_pns, request_id, position_id)
       VALUES ($block, $logIndex, $ts, $txHash, $accountId, $perpId, $closeType, $lotLNS, $triggerPNS, $condition, $kind,
         $limitPNS, $requestId, $positionId)`
    ),
    cancel: db.query(
      `INSERT OR IGNORE INTO native_stop_cancels (block, log_index, ts, tx_hash, account_id, perp_id, trigger_pns, condition)
       VALUES ($block, $logIndex, $ts, $txHash, $accountId, $perpId, $triggerPNS, $condition)`
    ),
    execution: db.query(
      `INSERT OR IGNORE INTO native_stop_executions (block, log_index, ts, tx_hash, exec_from, calldata_match, account_id,
         perp_id, close_type, lot_lns, ioc_limit_pns, order_desc_id, filled_lns, fill_notional, fill_vwap_pns)
       VALUES ($block, $logIndex, $ts, $txHash, $execFrom, $calldataMatch, $accountId, $perpId, $closeType, $lotLNS,
         $iocLimitPNS, $orderDescId, $filledLNS, $fillNotional, $fillVwapPNS)`
    ),
    problem: db.query(
      `INSERT OR IGNORE INTO quarantined_logs (block, log_index, tx_hash, topic0, data, reason, quarantined_at)
       VALUES ($block, $logIndex, $txHash, $topic0, $data, $reason, $at)`
    ),
    state: db.query(
      `INSERT INTO native_stop_state (id, next_block, window_from_block, coverage_from_block, updated_at)
       VALUES (1, $next, $from, $coverage, $at)
       ON CONFLICT (id) DO UPDATE SET next_block = MAX(next_block, $next), window_from_block = $from,
         coverage_from_block = $coverage, updated_at = $at`
    )
  };
  db.transaction(() => {
    for (const r of p.placements) ins.placement.run(r);
    for (const r of p.cancels) ins.cancel.run(r);
    for (const r of p.executions) ins.execution.run(r);
    for (const r of p.problems) ins.problem.run({ ...r, at: nowIso });
    ins.state.run({ next: state.nextBlock, from: state.windowFromBlock, coverage: state.coverageFromBlock, at: nowIso });
  }).immediate();
}

export interface NativeIngestResult {
  fromBlock: number;
  toBlock: number;
  pages: number;
  placements: number;
  cancels: number;
  executions: number;
  problems: number;
  /** Stopped at NATIVE_MAX_PAGES_PER_RUN before the target; the next cycle continues. */
  capped: boolean;
}

/**
 * Same cursor rules as the Perpl ingest (window start, contiguous coverage, CONFIRMATION_BLOCKS below height),
 * own cursor so a JoinAll backfill never holds back the Gap Index. Executions and cancels older than the window
 * are pruned; placements are kept for two windows so a long-lived stop can still join.
 */
export async function ingestNativeStops(
  db: Database,
  source: NativeStopSource,
  opts: { windowDays: number; signal: AbortSignal; log: Logger; now?: () => Date; renewLease?: () => void }
): Promise<NativeIngestResult> {
  const now = opts.now ?? (() => new Date());
  const target = (await source.getHeight()) - CONFIRMATION_BLOCKS;
  const span = windowBlocks(opts.windowDays);
  const windowFromBlock = Math.max(0, target - span);
  const state = getNativeState(db);
  const contiguous = state !== null && state.nextBlock >= windowFromBlock;
  let from = contiguous ? state.nextBlock : windowFromBlock;
  const coverageFromBlock = contiguous ? state.coverageFromBlock : from;
  const res: NativeIngestResult = { fromBlock: from, toBlock: from, pages: 0, placements: 0, cancels: 0, executions: 0, problems: 0, capped: false };
  while (from < target && !opts.signal.aborted) {
    if (res.pages >= NATIVE_MAX_PAGES_PER_RUN) {
      res.capped = true;
      break;
    }
    const page = await source.getPage(from, target);
    if (page.nextBlock <= from) throw new Error(`hypersync: no progress at block ${from}`);
    const next = Math.min(page.nextBlock, target);
    const parsed = parseNativeTxs(page.txs);
    for (const q of parsed.problems) opts.log.error({ block: q.block, logIndex: q.logIndex, txHash: q.txHash, reason: q.reason }, 'jobs.native_log_quarantined');
    opts.renewLease?.();
    commitNativePage(db, parsed, { nextBlock: next, windowFromBlock, coverageFromBlock }, now().toISOString());
    res.pages++;
    res.placements += parsed.placements.length;
    res.cancels += parsed.cancels.length;
    res.executions += parsed.executions.length;
    res.problems += parsed.problems.length;
    opts.log.debug({ from, next, txs: page.txs.length }, 'jobs.native_page');
    from = next;
  }
  if (res.pages === 0) {
    opts.renewLease?.();
    commitNativePage(db, { placements: [], cancels: [], executions: [], problems: [] }, { nextBlock: from, windowFromBlock, coverageFromBlock }, now().toISOString());
  }
  res.toBlock = from;
  db.transaction(() => {
    db.query('DELETE FROM native_stop_executions WHERE block < $min').run({ min: windowFromBlock });
    db.query('DELETE FROM native_stop_cancels WHERE block < $min').run({ min: windowFromBlock });
    db.query('DELETE FROM native_stop_placements WHERE block < $min').run({ min: Math.max(0, windowFromBlock - span) });
  }).immediate();
  return res;
}

type PlacementRow = Placement & { cancelledBlock: number | null; cancelTx: Hex | null; executedBlock: number | null; execTx: Hex | null };
type ExecutionRow = Execution & {
  joinStatus: JoinStatus | 'pending';
  placementBlock: number | null;
  placementLogIndex: number | null;
  delayBlocks: number | null;
  slippageVsMarkBps: number | null;
};

const PLACEMENT_COLS = `block, log_index AS logIndex, ts, tx_hash AS txHash, account_id AS accountId, perp_id AS perpId,
  close_type AS closeType, lot_lns AS lotLNS, trigger_pns AS triggerPNS, condition, kind, limit_pns AS limitPNS,
  request_id AS requestId, position_id AS positionId, cancelled_block AS cancelledBlock, cancel_tx AS cancelTx,
  executed_block AS executedBlock, exec_tx AS execTx`;
const EXECUTION_COLS = `block, log_index AS logIndex, ts, tx_hash AS txHash, exec_from AS execFrom, calldata_match AS calldataMatch,
  account_id AS accountId, perp_id AS perpId, close_type AS closeType, lot_lns AS lotLNS, ioc_limit_pns AS iocLimitPNS,
  order_desc_id AS orderDescId, filled_lns AS filledLNS, fill_notional AS fillNotional, fill_vwap_pns AS fillVwapPNS,
  join_status AS joinStatus, placement_block AS placementBlock, placement_log_index AS placementLogIndex,
  delay_blocks AS delayBlocks, slippage_vs_mark_bps AS slippageVsMarkBps`;
const CANCEL_COLS = `block, log_index AS logIndex, ts, tx_hash AS txHash, account_id AS accountId, perp_id AS perpId,
  trigger_pns AS triggerPNS, condition`;

/** Mark reads from the jobs event store (marks table, indexed by perp and block). */
export function storeMarks(db: Database): MarkLookup {
  const crossUp = db.query<{ block: number }, { perpId: number; from: number; to: number; price: number }>(
    'SELECT block FROM marks WHERE perp_id = $perpId AND block > $from AND block <= $to AND price_pns >= $price ORDER BY block LIMIT 1'
  );
  const crossDown = db.query<{ block: number }, { perpId: number; from: number; to: number; price: number }>(
    'SELECT block FROM marks WHERE perp_id = $perpId AND block > $from AND block <= $to AND price_pns <= $price ORDER BY block LIMIT 1'
  );
  return {
    markAtOrBefore: (perpId, block) => markAtOrBefore(db, perpId, block),
    firstMarkCrossing: (perpId, from, to, price, gte) => (gte ? crossUp : crossDown).get({ perpId, from, to, price })?.block ?? null
  };
}

/**
 * Recomputes every join from the stored raw rows and writes the results back (one transaction). Deterministic,
 * so a restart or a prune never leaves stale join columns.
 */
export function refreshNativeJoins(db: Database): { executions: number; joined: number; ambiguous: number; unjoined: number } {
  const placements = db.query<PlacementRow, []>(`SELECT ${PLACEMENT_COLS} FROM native_stop_placements`).all();
  const cancels = db.query<Cancel, []>(`SELECT ${CANCEL_COLS} FROM native_stop_cancels`).all();
  const executions = db.query<ExecutionRow, []>(`SELECT ${EXECUTION_COLS} FROM native_stop_executions`).all();
  const join = joinNativeStops(placements, cancels, executions);
  const marks = storeMarks(db);
  const counts = { executions: executions.length, joined: 0, ambiguous: 0, unjoined: 0 };
  const updExec = db.query(
    `UPDATE native_stop_executions SET join_status = $status, placement_block = $pb, placement_log_index = $pl,
       delay_blocks = $delay, slippage_vs_mark_bps = $slip WHERE block = $block AND log_index = $logIndex`
  );
  const updPlace = db.query(
    `UPDATE native_stop_placements SET cancelled_block = $cb, cancel_tx = $ct, executed_block = $eb, exec_tx = $et
     WHERE block = $block AND log_index = $logIndex`
  );
  db.transaction(() => {
    for (const e of executions) {
      const j = join.executions.get(rowKey(e)) ?? { status: 'unjoined' as const, placement: null };
      counts[j.status]++;
      updExec.run({
        status: j.status,
        pb: j.placement?.block ?? null,
        pl: j.placement?.logIndex ?? null,
        delay: j.status === 'joined' && j.placement ? delayBlocks(j.placement, e, marks) : null,
        slip: slippageVsMarkBps(e, marks),
        block: e.block,
        logIndex: e.logIndex
      });
    }
    for (const p of placements) {
      const end = join.ended.get(rowKey(p));
      updPlace.run({
        cb: end?.cancelledBlock ?? null,
        ct: end?.cancelTx ?? null,
        eb: end?.executedBlock ?? null,
        et: end?.execTx ?? null,
        block: p.block,
        logIndex: p.logIndex
      });
    }
  }).immediate();
  return counts;
}

function loadJoined(db: Database, where: string, args: Record<string, number>): { e: ExecutionRow; p: PlacementRow | null }[] {
  const rows = db.query<ExecutionRow, Record<string, number>>(`SELECT ${EXECUTION_COLS} FROM native_stop_executions ${where}`).all(args);
  const place = db.query<PlacementRow, { block: number; logIndex: number }>(
    `SELECT ${PLACEMENT_COLS} FROM native_stop_placements WHERE block = $block AND log_index = $logIndex`
  );
  return rows.map((e) => ({
    e,
    p: e.placementBlock === null || e.placementLogIndex === null ? null : (place.get({ block: e.placementBlock, logIndex: e.placementLogIndex }) ?? null)
  }));
}

export interface NativeOutcomeStats {
  executions: number;
  joined: number;
  ambiguous: number;
  unjoined: number;
  joinRate: number | null;
  byKind: { market: number; limit: number };
  full: number;
  partial: number;
  unfilled: number;
  slippageVsTriggerBps: ReturnType<typeof spread>;
  slippageVsMarkBps: ReturnType<typeof spread>;
  delayBlocks: ReturnType<typeof spread>;
  calldataUnverified: number;
}

/** Outcome stats over executions; slippage vs trigger and delay use joined rows only. */
export function outcomeStats(rows: readonly { e: ExecutionRow; p: PlacementRow | null }[]): NativeOutcomeStats {
  const joined = rows.filter((r) => r.e.joinStatus === 'joined' && r.p);
  const vsTrigger = joined.map((r) => slippageVsTriggerBps(r.p!, r.e)).filter((x): x is number => x !== null);
  const vsMark = rows.map((r) => r.e.slippageVsMarkBps).filter((x): x is number => x !== null);
  const delay = joined.map((r) => r.e.delayBlocks).filter((x): x is number => x !== null);
  const n = rows.length;
  return {
    executions: n,
    joined: joined.length,
    ambiguous: rows.filter((r) => r.e.joinStatus === 'ambiguous').length,
    unjoined: rows.filter((r) => r.e.joinStatus === 'unjoined' || r.e.joinStatus === 'pending').length,
    joinRate: n ? Math.round((joined.length / n) * 1e4) / 1e4 : null,
    byKind: { market: joined.filter((r) => r.p!.kind === 'market').length, limit: joined.filter((r) => r.p!.kind === 'limit').length },
    full: rows.filter((r) => r.e.filledLNS >= r.e.lotLNS).length,
    partial: rows.filter((r) => r.e.filledLNS > 0 && r.e.filledLNS < r.e.lotLNS).length,
    unfilled: rows.filter((r) => r.e.filledLNS === 0).length,
    slippageVsTriggerBps: spread(vsTrigger),
    slippageVsMarkBps: spread(vsMark),
    delayBlocks: spread(delay),
    calldataUnverified: rows.filter((r) => r.e.calldataMatch !== 1).length
  };
}

/** Per-perp and total outcome stats for native-stops.json. */
export function nativeStopReport(db: Database, perpSymbols: ReadonlyMap<number, string>) {
  const rows = loadJoined(db, 'ORDER BY block, log_index', {});
  const byPerp = new Map<number, typeof rows>();
  for (const r of rows) byPerp.set(r.e.perpId, [...(byPerp.get(r.e.perpId) ?? []), r]);
  const counts = db
    .query<{ placements: number; cancels: number }, []>(
      'SELECT (SELECT COUNT(*) FROM native_stop_placements) AS placements, (SELECT COUNT(*) FROM native_stop_cancels) AS cancels'
    )
    .get();
  return {
    totals: { placements: counts?.placements ?? 0, cancels: counts?.cancels ?? 0, ...outcomeStats(rows) },
    perps: [...byPerp.entries()].sort((a, b) => a[0] - b[0]).map(([perpId, rs]) => ({ perpId, symbol: perpSymbols.get(perpId) ?? null, ...outcomeStats(rs) }))
  };
}

export interface AccountNativeStop {
  perpId: number;
  side: 'long' | 'short';
  triggerPNS: number | null;
  condition: 'mark' | 'last' | null;
  kind: 'market' | 'limit' | null;
  lotLNS: number;
  placedBlock: number | null;
  placedTx: Hex | null;
  cancelledBlock: number | null;
  executedBlock: number | null;
  execTx: Hex | null;
  fillVwapPNS: number | null;
  filledLNS: number | null;
  slippageVsTriggerBps: number | null;
  slippageVsMarkBps: number | null;
  delayBlocks: number | null;
  /** open, cancelled, joined, ambiguous (placement side); unjoined for an execution with no placement found. */
  joinStatus: 'open' | 'cancelled' | 'joined' | 'ambiguous' | 'unjoined';
}

const sideOf = (closeType: CloseType) => (closeType === 2 ? 'long' : 'short');
const condOf = (c: number) => (c >= 2 ? 'mark' : 'last');

/** One account's stops, newest first: placements (with their execution when joined) plus unjoined executions. */
export function accountNativeStops(db: Database, accountId: number, limit: number): AccountNativeStop[] {
  const args = { accountId, limit };
  const places = db
    .query<PlacementRow, typeof args>(`SELECT ${PLACEMENT_COLS} FROM native_stop_placements WHERE account_id = $accountId ORDER BY block DESC, log_index DESC LIMIT $limit`)
    .all(args);
  const execs = db
    .query<ExecutionRow, typeof args>(`SELECT ${EXECUTION_COLS} FROM native_stop_executions WHERE account_id = $accountId ORDER BY block DESC, log_index DESC LIMIT $limit`)
    .all(args);
  const execByPlacement = new Map(execs.filter((e) => e.placementBlock !== null).map((e) => [`${e.placementBlock}:${e.placementLogIndex}`, e]));
  const out: AccountNativeStop[] = places.map((p) => {
    const e = execByPlacement.get(rowKey(p)) ?? null;
    const status: AccountNativeStop['joinStatus'] = e ? (e.joinStatus === 'ambiguous' ? 'ambiguous' : 'joined') : p.cancelledBlock !== null ? 'cancelled' : 'open';
    return {
      perpId: p.perpId,
      side: sideOf(p.closeType),
      triggerPNS: p.triggerPNS,
      condition: condOf(p.condition),
      kind: p.kind,
      lotLNS: p.lotLNS,
      placedBlock: p.block,
      placedTx: p.txHash,
      cancelledBlock: p.cancelledBlock,
      executedBlock: e?.block ?? null,
      execTx: e?.txHash ?? null,
      fillVwapPNS: e?.fillVwapPNS ?? null,
      filledLNS: e?.filledLNS ?? null,
      slippageVsTriggerBps: e && e.joinStatus === 'joined' ? slippageVsTriggerBps(p, e) : null,
      slippageVsMarkBps: e?.slippageVsMarkBps ?? null,
      delayBlocks: e?.delayBlocks ?? null,
      joinStatus: status
    };
  });
  for (const e of execs) {
    if (e.joinStatus === 'joined' || e.joinStatus === 'ambiguous') continue;
    out.push({
      perpId: e.perpId,
      side: sideOf(e.closeType),
      triggerPNS: null,
      condition: null,
      kind: null,
      lotLNS: e.lotLNS,
      placedBlock: null,
      placedTx: null,
      cancelledBlock: null,
      executedBlock: e.block,
      execTx: e.txHash,
      fillVwapPNS: e.fillVwapPNS,
      filledLNS: e.filledLNS,
      slippageVsTriggerBps: null,
      slippageVsMarkBps: e.slippageVsMarkBps,
      delayBlocks: null,
      joinStatus: 'unjoined'
    });
  }
  const at = (s: AccountNativeStop) => s.placedBlock ?? s.executedBlock ?? 0;
  return out.sort((a, b) => at(b) - at(a)).slice(0, limit);
}

/** count, executed, p50 and worst slippage vs trigger over the account's joined executions in the list. */
export function nativeStopSummary(stops: readonly AccountNativeStop[]) {
  const slips = stops.map((s) => s.slippageVsTriggerBps).filter((x): x is number => x !== null);
  const sp = spread(slips);
  return {
    count: stops.length,
    executed: stops.filter((s) => s.executedBlock !== null).length,
    p50SlippageBps: sp.p50,
    worstSlippageBps: sp.max
  };
}
