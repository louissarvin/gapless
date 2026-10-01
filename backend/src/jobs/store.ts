import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { migrate, openDb } from '../lib/db.ts';
import { JOBS_MIGRATIONS } from './migrations.ts';
import type { PerpMeta } from './perpl.ts';
import type { PositionKind, RejectionKind, RowBatch } from './rows.ts';

export function openJobsDb(path: string): Database {
  const db = openDb(path);
  migrate(db, JOBS_MIGRATIONS);
  return db;
}

/** For the relay: never creates the file and refuses writes. */
export function openJobsDbReadonly(path: string): Database {
  if (!existsSync(path)) throw new Error('jobs database not found');
  const db = new Database(path, { readonly: true, strict: true });
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA query_only = ON');
  return db;
}

export interface IngestState {
  nextBlock: number;
  windowFromBlock: number;
  /** First block of the contiguous ingested range (moves forward after downtime longer than the window). */
  coverageFromBlock: number;
}

export function getIngestState(db: Database): IngestState | null {
  const row = db
    .query<{ next_block: number; window_from_block: number; coverage_from_block: number | null }, []>(
      'SELECT next_block, window_from_block, coverage_from_block FROM ingest_state WHERE id = 1'
    )
    .get();
  if (!row) return null;
  return {
    nextBlock: row.next_block,
    windowFromBlock: row.window_from_block,
    coverageFromBlock: row.coverage_from_block ?? row.window_from_block
  };
}

/**
 * Inserts one page and advances the cursor atomically, so a crash never skips or half-stores a page.
 * The cursor never moves backwards, so a slower concurrent writer cannot rewind it.
 */
export function commitPage(db: Database, batch: RowBatch, state: IngestState, nowIso: string): void {
  const ins = {
    mark: db.query(
      'INSERT OR IGNORE INTO marks (block, log_index, ts, perp_id, price_pns) VALUES ($block, $logIndex, $ts, $perpId, $pricePNS)'
    ),
    oracle: db.query(
      `INSERT OR IGNORE INTO oracle_updates (block, log_index, ts, perp_id, price_pns, report_ts)
       VALUES ($block, $logIndex, $ts, $perpId, $pricePNS, $reportTs)`
    ),
    rejection: db.query(
      'INSERT OR IGNORE INTO price_rejections (block, log_index, ts, perp_id, kind) VALUES ($block, $logIndex, $ts, $perpId, $kind)'
    ),
    fill: db.query(
      `INSERT OR IGNORE INTO fills (block, log_index, ts, perp_id, account_id, order_id, price_pns, lot_lns, fee_cns, tx_hash)
       VALUES ($block, $logIndex, $ts, $perpId, $accountId, $orderId, $pricePNS, $lotLNS, $feeCNS, $txHash)`
    ),
    position: db.query(
      `INSERT OR IGNORE INTO position_events (block, log_index, ts, perp_id, account_id, kind, position_type, price_pns,
         lot_before_lns, lot_after_lns, delta_pnl_cns, funding_cns, tx_hash, liq_lot_lns, pos_lot_lns)
       VALUES ($block, $logIndex, $ts, $perpId, $accountId, $kind, $positionType, $pricePNS, $lotBeforeLNS,
         $lotAfterLNS, $deltaPnlCNS, $fundingCNS, $txHash, $liqLotLNS, $posLotLNS)`
    ),
    collateral: db.query(
      `INSERT OR IGNORE INTO collateral_events (block, log_index, ts, account_id, kind, amount_cns, balance_cns, tx_hash)
       VALUES ($block, $logIndex, $ts, $accountId, $kind, $amountCNS, $balanceCNS, $txHash)`
    ),
    quarantine: db.query(
      `INSERT OR IGNORE INTO quarantined_logs (block, log_index, tx_hash, topic0, data, reason, quarantined_at)
       VALUES ($block, $logIndex, $txHash, $topic0, $data, $reason, $at)`
    ),
    state: db.query(
      `INSERT INTO ingest_state (id, next_block, window_from_block, coverage_from_block, updated_at)
       VALUES (1, $next, $from, $coverage, $at)
       ON CONFLICT (id) DO UPDATE SET next_block = MAX(next_block, $next), window_from_block = $from,
         coverage_from_block = $coverage, updated_at = $at`
    )
  };
  db.transaction(() => {
    for (const r of batch.marks) ins.mark.run(r);
    for (const r of batch.oracle) ins.oracle.run(r);
    for (const r of batch.rejections) ins.rejection.run(r);
    for (const r of batch.fills) ins.fill.run(r);
    for (const r of batch.positions) ins.position.run(r);
    for (const r of batch.collateral) ins.collateral.run(r);
    for (const r of batch.quarantined) ins.quarantine.run({ ...r, at: nowIso });
    ins.state.run({ next: state.nextBlock, from: state.windowFromBlock, coverage: state.coverageFromBlock, at: nowIso });
  }).immediate();
}

const EVENT_TABLES = ['marks', 'oracle_updates', 'price_rejections', 'fills', 'position_events', 'collateral_events'] as const;

/** Drops event rows older than the window (quarantined logs are kept). Table names are constants. */
export function pruneBefore(db: Database, minBlock: number): number {
  let removed = 0;
  db.transaction(() => {
    for (const t of EVENT_TABLES) removed += db.query(`DELETE FROM ${t} WHERE block < $min`).run({ min: minBlock }).changes;
  }).immediate();
  return removed;
}

export interface QuarantineSummary {
  inWindow: number;
  total: number;
  latest: { block: number; logIndex: number; txHash: string; reason: string } | null;
}

export function quarantineSummary(db: Database, fromBlock: number): QuarantineSummary {
  const counts = db
    .query<{ total: number; inWindow: number | null }, { from: number }>(
      'SELECT COUNT(*) AS total, SUM(block >= $from) AS inWindow FROM quarantined_logs'
    )
    .get({ from: fromBlock });
  const latest = db
    .query<{ block: number; logIndex: number; txHash: string; reason: string }, []>(
      `SELECT block, log_index AS logIndex, tx_hash AS txHash, reason FROM quarantined_logs
       ORDER BY block DESC, log_index DESC LIMIT 1`
    )
    .get();
  return { inWindow: counts?.inWindow ?? 0, total: counts?.total ?? 0, latest: latest ?? null };
}

/**
 * Single-writer lease so `once` and the daemon never ingest or publish at the same time.
 * Takes the lease when it is free, expired or already ours; returns false when someone else holds it.
 */
export function acquireLease(db: Database, owner: string, ttlMs: number, nowMs: number): boolean {
  return db.transaction(() => {
    const row = db.query<{ owner: string; exp: number }, []>('SELECT owner, expires_at_ms AS exp FROM jobs_lease WHERE id = 1').get();
    if (row && row.owner !== owner && row.exp > nowMs) return false;
    db.query(
      `INSERT INTO jobs_lease (id, owner, expires_at_ms) VALUES (1, $owner, $exp)
       ON CONFLICT (id) DO UPDATE SET owner = $owner, expires_at_ms = $exp`
    ).run({ owner, exp: nowMs + ttlMs });
    return true;
  }).immediate();
}

export function releaseLease(db: Database, owner: string): void {
  db.query('DELETE FROM jobs_lease WHERE id = 1 AND owner = $owner').run({ owner });
}

export function upsertPerps(db: Database, perps: readonly PerpMeta[], nowIso: string): void {
  const q = db.query(
    `INSERT INTO perps VALUES ($perpId, $name, $symbol, $priceDecimals, $lotDecimals, $status, $at)
     ON CONFLICT (perp_id) DO UPDATE SET name = $name, symbol = $symbol, price_decimals = $priceDecimals,
       lot_decimals = $lotDecimals, status = $status, updated_at = $at`
  );
  db.transaction(() => {
    for (const p of perps) q.run({ ...p, at: nowIso });
  }).immediate();
}

export function listPerps(db: Database): PerpMeta[] {
  return db
    .query<
      { perp_id: number; name: string; symbol: string; price_decimals: number; lot_decimals: number; status: number },
      []
    >('SELECT perp_id, name, symbol, price_decimals, lot_decimals, status FROM perps ORDER BY perp_id')
    .all()
    .map((r) => ({
      perpId: r.perp_id,
      name: r.name,
      symbol: r.symbol,
      priceDecimals: r.price_decimals,
      lotDecimals: r.lot_decimals,
      status: r.status
    }));
}

/** Ascending by block, one value per block (the last log in the block wins). */
export interface StepSeries {
  block: number[];
  ts: number[];
  price: number[];
}

export function loadMarks(db: Database, perpId: number): StepSeries {
  const rows = db
    .query<[number, number, number], { perpId: number }>(
      'SELECT block, ts, price_pns FROM marks WHERE perp_id = $perpId ORDER BY block, log_index'
    )
    .values({ perpId }) as [number, number, number][];
  const out: StepSeries = { block: [], ts: [], price: [] };
  for (const [block, ts, price] of rows) {
    const n = out.block.length;
    if (n > 0 && out.block[n - 1] === block) {
      out.price[n - 1] = price;
      continue;
    }
    out.block.push(block);
    out.ts.push(ts);
    out.price.push(price);
  }
  return out;
}

export interface OracleSeries extends StepSeries {
  reportTs: number[];
}

export function loadOracle(db: Database, perpId: number): OracleSeries {
  const rows = db
    .query<[number, number, number, number], { perpId: number }>(
      'SELECT block, ts, price_pns, report_ts FROM oracle_updates WHERE perp_id = $perpId ORDER BY block, log_index'
    )
    .values({ perpId }) as [number, number, number, number][];
  const out: OracleSeries = { block: [], ts: [], price: [], reportTs: [] };
  for (const [block, ts, price, reportTs] of rows) {
    const n = out.block.length;
    if (n > 0 && out.block[n - 1] === block) {
      out.price[n - 1] = price;
      out.reportTs[n - 1] = reportTs;
      continue;
    }
    out.block.push(block);
    out.ts.push(ts);
    out.price.push(price);
    out.reportTs.push(reportTs);
  }
  return out;
}

/** Every maker fill print, ascending by block (several per block allowed). */
export interface Prints {
  block: number[];
  price: number[];
}

export function loadPrints(db: Database, perpId: number): Prints {
  const rows = db
    .query<[number, number], { perpId: number }>(
      'SELECT block, price_pns FROM fills WHERE perp_id = $perpId ORDER BY block, log_index'
    )
    .values({ perpId }) as [number, number][];
  return { block: rows.map((r) => r[0]), price: rows.map((r) => r[1]) };
}

export function countRejections(db: Database, perpId: number): Record<RejectionKind, number> {
  const out: Record<RejectionKind, number> = { oracle_report_not_newer: 0, oracle_update_failed: 0, mark_exceeds_tol: 0 };
  const rows = db
    .query<{ kind: RejectionKind; n: number }, { perpId: number }>(
      'SELECT kind, COUNT(*) AS n FROM price_rejections WHERE perp_id = $perpId GROUP BY kind'
    )
    .all({ perpId });
  for (const r of rows) out[r.kind] = r.n;
  return out;
}

const countWhere = (db: Database, table: 'fills' | 'oracle_updates', perpId: number): number =>
  db.query<{ n: number }, { perpId: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE perp_id = $perpId`).get({ perpId })
    ?.n ?? 0;

export const countFills = (db: Database, perpId: number): number => countWhere(db, 'fills', perpId);
/** Every LinkPriceUpdated log, not deduped per block, so it is comparable with failure counts. */
export const countOracleUpdates = (db: Database, perpId: number): number => countWhere(db, 'oracle_updates', perpId);

/** First and last mark timestamps in the store (marks are the densest series). */
export function markTsBounds(db: Database): { minTs: number; maxTs: number } | null {
  const row = db
    .query<{ minTs: number | null; maxTs: number | null }, []>('SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs FROM marks')
    .get();
  return row && row.minTs !== null && row.maxTs !== null ? { minTs: row.minTs, maxTs: row.maxTs } : null;
}

/** Latest mark at or before `block`. */
export function markAtOrBefore(db: Database, perpId: number, block: number): { block: number; pricePNS: number } | null {
  const row = db
    .query<{ block: number; price_pns: number }, { perpId: number; block: number }>(
      `SELECT block, price_pns FROM marks WHERE perp_id = $perpId AND block <= $block
       ORDER BY block DESC, log_index DESC LIMIT 1`
    )
    .get({ perpId, block });
  return row ? { block: row.block, pricePNS: row.price_pns } : null;
}

export interface PositionEventRow {
  block: number;
  logIndex: number;
  ts: number;
  perpId: number;
  kind: PositionKind;
  positionType: number;
  pricePNS: number | null;
  lotBeforeLNS: number | null;
  lotAfterLNS: number | null;
  deltaPnlCNS: string | null;
  fundingCNS: string | null;
  txHash: string;
  liqLotLNS: number | null;
  posLotLNS: number | null;
}

export interface FillEventRow {
  block: number;
  logIndex: number;
  ts: number;
  perpId: number;
  orderId: number;
  pricePNS: number;
  lotLNS: number;
  feeCNS: string;
  txHash: string;
}

export interface CollateralEventRow {
  block: number;
  logIndex: number;
  ts: number;
  kind: 'deposit' | 'withdrawal';
  amountCNS: string;
  balanceCNS: string;
  txHash: string;
}

/** Most recent rows first, at most `limit` per table (index range scans on account_id, block). */
export function accountEvents(db: Database, accountId: number, limit: number) {
  const args = { accountId, limit };
  const positions = db
    .query<PositionEventRow, typeof args>(
      `SELECT block, log_index AS logIndex, ts, perp_id AS perpId, kind, position_type AS positionType,
         price_pns AS pricePNS, lot_before_lns AS lotBeforeLNS, lot_after_lns AS lotAfterLNS,
         delta_pnl_cns AS deltaPnlCNS, funding_cns AS fundingCNS, tx_hash AS txHash,
         liq_lot_lns AS liqLotLNS, pos_lot_lns AS posLotLNS
       FROM position_events WHERE account_id = $accountId ORDER BY block DESC, log_index DESC LIMIT $limit`
    )
    .all(args);
  const fills = db
    .query<FillEventRow, typeof args>(
      `SELECT block, log_index AS logIndex, ts, perp_id AS perpId, order_id AS orderId, price_pns AS pricePNS,
         lot_lns AS lotLNS, fee_cns AS feeCNS, tx_hash AS txHash
       FROM fills WHERE account_id = $accountId ORDER BY block DESC, log_index DESC LIMIT $limit`
    )
    .all(args);
  const collateral = db
    .query<CollateralEventRow, typeof args>(
      `SELECT block, log_index AS logIndex, ts, kind, amount_cns AS amountCNS, balance_cns AS balanceCNS,
         tx_hash AS txHash
       FROM collateral_events WHERE account_id = $accountId ORDER BY block DESC, log_index DESC LIMIT $limit`
    )
    .all(args);
  return { positions, fills, collateral };
}

export interface AccountTotals {
  positionEvents: Record<PositionKind, number>;
  makerFills: number;
  /** Sum of deltaPnlCNS over reducing events, as emitted (price PnL; fees not included). */
  deltaPnlCNS: bigint;
  fundingCNS: bigint;
  asOfBlock: number;
}

/**
 * Recomputes per-account window aggregates in the jobs process, so the relay reads one row
 * instead of scanning a market maker's history on its event loop. SQLite raises on 64-bit overflow.
 */
export function refreshAccountTotals(db: Database, asOfBlock: number): number {
  return db.transaction(() => {
    db.run('DELETE FROM account_totals');
    return db
      .query(
        `INSERT INTO account_totals
         SELECT account_id,
           COALESCE(SUM(kind = 'open'), 0), COALESCE(SUM(kind = 'increase'), 0), COALESCE(SUM(kind = 'decrease'), 0),
           COALESCE(SUM(kind = 'close'), 0), COALESCE(SUM(kind = 'invert'), 0), COALESCE(SUM(kind = 'liquidation'), 0),
           COALESCE(SUM(kind = 'deleverage'), 0), SUM(fill),
           CAST(COALESCE(SUM(pnl), 0) AS TEXT), CAST(COALESCE(SUM(funding), 0) AS TEXT), $block
         FROM (
           SELECT account_id, kind, 0 AS fill, CAST(delta_pnl_cns AS INTEGER) AS pnl, CAST(funding_cns AS INTEGER) AS funding
           FROM position_events
           UNION ALL
           SELECT account_id, NULL, 1, NULL, NULL FROM fills
         ) GROUP BY account_id`
      )
      .run({ block: asOfBlock }).changes;
  }).immediate();
}

/** Precomputed totals; zeros for an account with no events; null before the first refresh. */
export function readAccountTotals(db: Database, accountId: number): AccountTotals | null {
  const row = db
    .query<
      {
        n_open: number; n_increase: number; n_decrease: number; n_close: number; n_invert: number;
        n_liquidation: number; n_deleverage: number; maker_fills: number; delta_pnl_cns: string;
        funding_cns: string; as_of_block: number;
      },
      { accountId: number }
    >('SELECT * FROM account_totals WHERE account_id = $accountId')
    .get({ accountId });
  if (!row) {
    const any = db.query<{ b: number | null }, []>('SELECT MAX(as_of_block) AS b FROM account_totals').get();
    if (any?.b === null || any?.b === undefined) return null;
    return {
      positionEvents: { open: 0, increase: 0, decrease: 0, close: 0, invert: 0, liquidation: 0, deleverage: 0 },
      makerFills: 0,
      deltaPnlCNS: 0n,
      fundingCNS: 0n,
      asOfBlock: any.b
    };
  }
  return {
    positionEvents: {
      open: row.n_open,
      increase: row.n_increase,
      decrease: row.n_decrease,
      close: row.n_close,
      invert: row.n_invert,
      liquidation: row.n_liquidation,
      deleverage: row.n_deleverage
    },
    makerFills: row.maker_fills,
    deltaPnlCNS: BigInt(row.delta_pnl_cns),
    fundingCNS: BigInt(row.funding_cns),
    asOfBlock: row.as_of_block
  };
}
