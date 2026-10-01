import type { Migration } from '../lib/db.ts';

// Jobs event store: a rolling window of public Perpl logs, re-fetchable from HyperSync, so
// pruning old rows loses nothing. PNS/LNS/ids are INTEGER (uint32/uint40 onchain, under 2^53);
// CNS amounts are decimal TEXT. Append-only: never edit a shipped migration.
export const JOBS_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'perpl_event_store',
    sql: `
      CREATE TABLE ingest_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_block INTEGER NOT NULL,
        window_from_block INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE marks (
        block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL,
        perp_id INTEGER NOT NULL, price_pns INTEGER NOT NULL,
        PRIMARY KEY (block, log_index)
      ) WITHOUT ROWID;
      CREATE INDEX marks_perp_block ON marks (perp_id, block);
      CREATE TABLE oracle_updates (
        block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL,
        perp_id INTEGER NOT NULL, price_pns INTEGER NOT NULL, report_ts INTEGER NOT NULL,
        PRIMARY KEY (block, log_index)
      ) WITHOUT ROWID;
      CREATE INDEX oracle_perp_block ON oracle_updates (perp_id, block);
      CREATE TABLE price_rejections (
        block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL,
        perp_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('oracle_report_not_newer', 'oracle_update_failed', 'mark_exceeds_tol')),
        PRIMARY KEY (block, log_index)
      ) WITHOUT ROWID;
      CREATE INDEX rejections_perp_block ON price_rejections (perp_id, block);
      CREATE TABLE fills (
        block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL,
        perp_id INTEGER NOT NULL, account_id INTEGER NOT NULL, order_id INTEGER NOT NULL,
        price_pns INTEGER NOT NULL, lot_lns INTEGER NOT NULL, fee_cns TEXT NOT NULL, tx_hash TEXT NOT NULL,
        PRIMARY KEY (block, log_index)
      ) WITHOUT ROWID;
      CREATE INDEX fills_perp_block ON fills (perp_id, block);
      CREATE INDEX fills_account_block ON fills (account_id, block);
      CREATE TABLE position_events (
        block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL,
        perp_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('open', 'increase', 'decrease', 'close', 'invert', 'liquidation', 'deleverage')),
        position_type INTEGER NOT NULL, price_pns INTEGER, lot_before_lns INTEGER, lot_after_lns INTEGER,
        delta_pnl_cns TEXT, funding_cns TEXT, tx_hash TEXT NOT NULL,
        PRIMARY KEY (block, log_index)
      ) WITHOUT ROWID;
      CREATE INDEX positions_account_block ON position_events (account_id, block);
      CREATE TABLE collateral_events (
        block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL,
        account_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
        amount_cns TEXT NOT NULL, balance_cns TEXT NOT NULL, tx_hash TEXT NOT NULL,
        PRIMARY KEY (block, log_index)
      ) WITHOUT ROWID;
      CREATE INDEX collateral_account_block ON collateral_events (account_id, block);
      CREATE TABLE perps (
        perp_id INTEGER PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL,
        price_decimals INTEGER NOT NULL, lot_decimals INTEGER NOT NULL, status INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    id: 2,
    name: 'quarantine_lease_totals',
    // Liquidation lots are stored as emitted: what posLotLNS means is unverified (no live sample).
    // Quarantined logs are kept past the window prune: they are the audit trail for skipped data.
    sql: `
      ALTER TABLE position_events ADD COLUMN liq_lot_lns INTEGER;
      ALTER TABLE position_events ADD COLUMN pos_lot_lns INTEGER;
      CREATE TABLE quarantined_logs (
        block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx_hash TEXT NOT NULL, topic0 TEXT,
        data TEXT NOT NULL, reason TEXT NOT NULL, quarantined_at TEXT NOT NULL,
        PRIMARY KEY (block, log_index)
      ) WITHOUT ROWID;
      ALTER TABLE ingest_state ADD COLUMN coverage_from_block INTEGER;
      UPDATE ingest_state SET coverage_from_block = window_from_block;
      CREATE TABLE jobs_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE account_totals (
        account_id INTEGER PRIMARY KEY,
        n_open INTEGER NOT NULL, n_increase INTEGER NOT NULL, n_decrease INTEGER NOT NULL,
        n_close INTEGER NOT NULL, n_invert INTEGER NOT NULL, n_liquidation INTEGER NOT NULL,
        n_deleverage INTEGER NOT NULL, maker_fills INTEGER NOT NULL,
        delta_pnl_cns TEXT NOT NULL, funding_cns TEXT NOT NULL, as_of_block INTEGER NOT NULL
      );
    `
  },
  {
    id: 3,
    name: 'native_stops_and_gapless_logs',
    // Native stops (W4a): raw placements, cancels and executions from a JoinAll HyperSync stream with its own cursor.
    // Join columns are recomputed each cycle from the raw rows. Gapless logs (W4b) are kept from GAPLESS_START_BLOCK
    // on, never pruned; topics as lowercase hex.
    sql: `
      CREATE TABLE native_stop_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_block INTEGER NOT NULL, window_from_block INTEGER NOT NULL, coverage_from_block INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE native_stop_placements (
        block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL, tx_hash TEXT NOT NULL,
        account_id INTEGER NOT NULL, perp_id INTEGER NOT NULL,
        close_type INTEGER NOT NULL CHECK (close_type IN (2, 3)), lot_lns INTEGER NOT NULL,
        trigger_pns INTEGER NOT NULL, condition INTEGER NOT NULL CHECK (condition BETWEEN 0 AND 3),
        kind TEXT NOT NULL CHECK (kind IN ('market', 'limit')), limit_pns INTEGER,
        request_id TEXT NOT NULL, position_id TEXT NOT NULL,
        cancelled_block INTEGER, cancel_tx TEXT, executed_block INTEGER, exec_tx TEXT,
        PRIMARY KEY (block, log_index)
      ) WITHOUT ROWID;
      CREATE INDEX native_placements_account ON native_stop_placements (account_id, block);
      CREATE TABLE native_stop_cancels (
        block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL, tx_hash TEXT NOT NULL,
        account_id INTEGER NOT NULL, perp_id INTEGER NOT NULL, trigger_pns INTEGER NOT NULL, condition INTEGER NOT NULL,
        PRIMARY KEY (block, log_index)
      ) WITHOUT ROWID;
      CREATE TABLE native_stop_executions (
        block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL, tx_hash TEXT NOT NULL,
        exec_from TEXT, calldata_match INTEGER,
        account_id INTEGER NOT NULL, perp_id INTEGER NOT NULL,
        close_type INTEGER NOT NULL CHECK (close_type IN (2, 3)), lot_lns INTEGER NOT NULL,
        ioc_limit_pns INTEGER NOT NULL, order_desc_id TEXT NOT NULL,
        filled_lns INTEGER NOT NULL, fill_notional TEXT NOT NULL, fill_vwap_pns INTEGER,
        join_status TEXT NOT NULL DEFAULT 'pending' CHECK (join_status IN ('pending', 'joined', 'ambiguous', 'unjoined')),
        placement_block INTEGER, placement_log_index INTEGER, delay_blocks INTEGER, slippage_vs_mark_bps REAL,
        PRIMARY KEY (block, log_index)
      ) WITHOUT ROWID;
      CREATE INDEX native_executions_account ON native_stop_executions (account_id, block);
      CREATE INDEX native_executions_perp ON native_stop_executions (perp_id, block);
      CREATE TABLE gapless_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_block INTEGER NOT NULL, start_block INTEGER NOT NULL, addresses TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE gapless_logs (
        block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL, tx_hash TEXT NOT NULL,
        address TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('manager', 'vault', 'factory', 'sink')),
        topic0 TEXT, topic1 TEXT, topic2 TEXT, topic3 TEXT, data TEXT NOT NULL,
        PRIMARY KEY (block, log_index)
      ) WITHOUT ROWID;
      CREATE INDEX gapless_logs_t1 ON gapless_logs (source, topic0, topic1);
      CREATE INDEX gapless_logs_t2 ON gapless_logs (source, topic0, topic2);
    `
  }
];
