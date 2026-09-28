import type { Address } from 'viem';
import type { Database } from './db.ts';
import type { Logger } from './log.ts';

/**
 * Ledger tables for the daily MON governor, shared by the keeper and relay migrations.
 * Wei is decimal TEXT (SQLite INTEGER overflows near 9.2 MON). Rows are never deleted.
 */
export const SPEND_LEDGER_SQL = `
CREATE TABLE spend_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signer TEXT NOT NULL,
  day TEXT NOT NULL,
  action TEXT NOT NULL,
  ref TEXT,
  exempt INTEGER NOT NULL DEFAULT 0,
  reserved_wei TEXT NOT NULL,
  actual_wei TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'unknown', 'settled', 'released')),
  tx_hash TEXT,
  nonce INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX spend_ledger_signer_day ON spend_ledger (signer, day);
CREATE INDEX spend_ledger_open ON spend_ledger (status) WHERE status IN ('reserved', 'unknown');
CREATE TABLE spend_days (
  signer TEXT NOT NULL,
  day TEXT NOT NULL,
  committed_wei TEXT NOT NULL,
  PRIMARY KEY (signer, day)
);
`;

/** Second migration for both processes: dedupe keys (restart seeding) and the per-signer lease. */
export const SPEND_LEDGER_V2_SQL = `
ALTER TABLE spend_ledger ADD COLUMN dedupe_key TEXT;
CREATE INDEX spend_ledger_signer_action_day ON spend_ledger (signer, day, action);
CREATE TABLE signer_lease (
  signer TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export interface GovernorConfig {
  /** Hard daily cap per signer, UTC day. Counts reserved, unknown and settled spend. */
  capWei: bigint;
  /** Headroom only exempt (hot path) actions may use: non-exempt spend is held to cap minus this (SE2-M2). */
  hotReserveWei: bigint;
  /** Error log once per day when committed spend reaches this. */
  alertWei: bigint;
  /** Daily sub-caps per action label, on top of the cap (e.g. zero-paid triggers). */
  actionCapsWei?: Readonly<Record<string, bigint>>;
  /** SE3-L1: a non-exempt send must leave this much of the cap (one fill call at max fee), whatever exempt spent. */
  fillHeadroomWei?: bigint;
}

export type ReserveResult =
  | { ok: true; id: number }
  | { ok: false; reason: 'cap' | 'action_cap'; committedWei: bigint; limitWei: bigint };

/** A ledger row whose tx may be on chain: reserved or unknown, or settled recently. */
export interface SentRow {
  id: number;
  action: string;
  ref: string | null;
  dedupeKey: string | null;
  txHash: string | null;
  nonce: number | null;
  reservedWei: bigint;
  status: 'reserved' | 'unknown' | 'settled';
  createdAt: string;
}

export interface SpendUsage {
  day: string;
  committedWei: bigint;
  capWei: bigint;
  hotReserveWei: bigint;
  alertWei: bigint;
}

interface LedgerRow {
  id: number;
  day: string;
  reserved_wei: string;
  status: string;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Reserve-then-settle daily spend cap. reserve() books gasLimit x maxFee (+ value) before a send,
 * settle() swaps it for the billed amount after the receipt, release() frees a send that never
 * reached the chain. A crash between reserve and settle leaves the row counted (status unknown).
 * Every send stays under the cap; non-exempt spend alone stays under cap minus the hot reserve, so exempt
 * spend never starves non-exempt sends and the hot reserve is always left for exempt ones. A non-exempt send also
 * leaves `fillHeadroomWei` of the cap untouched, so one fill call always fits (SE3-L1).
 */
export class SpendGovernor {
  private readonly now: () => number;
  private alertedDay: string | null = null;

  constructor(
    private readonly db: Database,
    readonly signer: Address,
    private readonly cfg: GovernorConfig,
    private readonly log: Logger,
    now?: () => number
  ) {
    if (cfg.hotReserveWei > cfg.capWei || cfg.alertWei > cfg.capWei || (cfg.fillHeadroomWei ?? 0n) > cfg.capWei) {
      throw new Error('governor: reserve, headroom and alert must not exceed the cap');
    }
    this.now = now ?? Date.now;
  }

  /** Marks reservations left by a previous process as unknown; they stay counted. Returns how many. */
  recover(): number {
    const at = new Date(this.now()).toISOString();
    const res = this.db
      .query("UPDATE spend_ledger SET status = 'unknown', updated_at = $at WHERE signer = $signer AND status = 'reserved'")
      .run({ at, signer: this.signer });
    if (res.changes > 0) this.log.warn({ rows: res.changes }, 'spend.recovered_unknown');
    return res.changes;
  }

  reserve(input: { action: string; ref?: string; amountWei: bigint; exempt: boolean; dedupeKey?: string }): ReserveResult {
    const at = new Date(this.now()).toISOString();
    const day = utcDay(this.now());
    const result = this.db.transaction((): ReserveResult => {
      const committed = this.committed(day);
      if (committed + input.amountWei > this.cfg.capWei) return { ok: false, reason: 'cap', committedWei: committed, limitWei: this.cfg.capWei };
      if (!input.exempt) {
        const own = this.nonExemptCommitted(day);
        const limit = this.cfg.capWei - this.cfg.hotReserveWei;
        if (own + input.amountWei > limit) return { ok: false, reason: 'cap', committedWei: own, limitWei: limit };
        const total = this.cfg.capWei - (this.cfg.fillHeadroomWei ?? 0n);
        if (committed + input.amountWei > total) return { ok: false, reason: 'cap', committedWei: committed, limitWei: total };
      }
      const actionCap = this.cfg.actionCapsWei?.[input.action];
      if (actionCap !== undefined) {
        const used = this.actionCommitted(day, input.action);
        if (used + input.amountWei > actionCap) return { ok: false, reason: 'action_cap', committedWei: used, limitWei: actionCap };
      }
      const row = this.db
        .query<{ id: number }, Record<string, string | number | null>>(
          `INSERT INTO spend_ledger (signer, day, action, ref, exempt, reserved_wei, status, dedupe_key, created_at, updated_at)
           VALUES ($signer, $day, $action, $ref, $exempt, $wei, 'reserved', $dedupe, $at, $at) RETURNING id`
        )
        .get({
          signer: this.signer,
          day,
          action: input.action,
          ref: input.ref ?? null,
          exempt: input.exempt ? 1 : 0,
          wei: input.amountWei.toString(),
          dedupe: input.dedupeKey ?? null,
          at
        });
      this.addCommitted(day, input.amountWei);
      return { ok: true, id: row!.id };
    }).immediate();

    if (!result.ok) {
      this.log.warn(
        { action: input.action, reason: result.reason, committedWei: result.committedWei.toString(), limitWei: result.limitWei.toString() },
        'spend.cap_reached'
      );
    } else {
      this.maybeAlert(day);
    }
    return result;
  }

  /** Records the tx a reservation paid for, before the send. */
  attach(id: number, txHash: string, nonce: number): void {
    this.db
      .query('UPDATE spend_ledger SET tx_hash = $hash, nonce = $nonce, updated_at = $at WHERE id = $id')
      .run({ id, hash: txHash, nonce, at: new Date(this.now()).toISOString() });
  }

  /** Billed amount after the receipt (gasLimit x effectiveGasPrice + value). */
  settle(id: number, actualWei: bigint): void {
    this.finish(id, 'settled', actualWei);
  }

  /** The tx never reached the chain (pre-send failure or excluded). Frees the reservation. */
  release(id: number): void {
    this.finish(id, 'released', 0n);
  }

  /** Sent but the outcome is not known yet; stays counted at the reserved amount. */
  markUnknown(id: number): void {
    this.db
      .query("UPDATE spend_ledger SET status = 'unknown', updated_at = $at WHERE id = $id AND status = 'reserved'")
      .run({ id, at: new Date(this.now()).toISOString() });
  }

  /** Sends of `action` (optionally for one ref) booked today that were not released. */
  countToday(action: string, ref?: string): number {
    const row = this.db
      .query<{ n: number }, Record<string, string | null>>(
        `SELECT COUNT(*) AS n FROM spend_ledger
         WHERE signer = $signer AND day = $day AND action = $action AND status != 'released' AND ($ref IS NULL OR ref = $ref)`
      )
      .get({ signer: this.signer, day: utcDay(this.now()), action, ref: ref ?? null });
    return row?.n ?? 0;
  }

  /** Rows whose tx may still land (reserved, unknown), plus settled rows created at or after `settledSince` (ISO) when given. */
  sentRows(settledSince: string | null): SentRow[] {
    const rows = this.db
      .query<
        { id: number; action: string; ref: string | null; dedupe_key: string | null; tx_hash: string | null; nonce: number | null; reserved_wei: string; status: SentRow['status']; created_at: string },
        Record<string, string | null>
      >(
        `SELECT id, action, ref, dedupe_key, tx_hash, nonce, reserved_wei, status, created_at FROM spend_ledger
         WHERE signer = $signer AND (status IN ('reserved', 'unknown') OR ($since IS NOT NULL AND status = 'settled' AND created_at >= $since))
         ORDER BY id`
      )
      .all({ signer: this.signer, since: settledSince });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      ref: r.ref,
      dedupeKey: r.dedupe_key,
      txHash: r.tx_hash,
      nonce: r.nonce,
      reservedWei: BigInt(r.reserved_wei),
      status: r.status,
      createdAt: r.created_at
    }));
  }

  /** Wei one more reservation could take today under the cap, the non-exempt limit and the action sub-cap. */
  room(exempt: boolean, action?: string): bigint {
    const day = utcDay(this.now());
    let room = this.cfg.capWei - this.committed(day);
    if (!exempt) {
      room = min(room, this.cfg.capWei - this.cfg.hotReserveWei - this.nonExemptCommitted(day));
      room = min(room, this.cfg.capWei - (this.cfg.fillHeadroomWei ?? 0n) - this.committed(day));
    }
    const actionCap = action === undefined ? undefined : this.cfg.actionCapsWei?.[action];
    if (actionCap !== undefined) room = min(room, actionCap - this.actionCommitted(day, action!));
    return room > 0n ? room : 0n;
  }

  usage(): SpendUsage {
    const day = utcDay(this.now());
    return { day, committedWei: this.committed(day), capWei: this.cfg.capWei, hotReserveWei: this.cfg.hotReserveWei, alertWei: this.cfg.alertWei };
  }

  private finish(id: number, status: 'settled' | 'released', actualWei: bigint): void {
    const at = new Date(this.now()).toISOString();
    this.db.transaction(() => {
      const row = this.db
        .query<LedgerRow, { id: number }>('SELECT id, day, reserved_wei, status FROM spend_ledger WHERE id = $id')
        .get({ id });
      if (!row || (row.status !== 'reserved' && row.status !== 'unknown')) return;
      this.db
        .query('UPDATE spend_ledger SET status = $status, actual_wei = $actual, updated_at = $at WHERE id = $id')
        .run({ id, status, actual: actualWei.toString(), at });
      this.addCommitted(row.day, actualWei - BigInt(row.reserved_wei));
    }).immediate();
  }

  private actionCommitted(day: string, action: string): bigint {
    const rows = this.db
      .query<{ reserved_wei: string; actual_wei: string | null; status: string }, Record<string, string>>(
        `SELECT reserved_wei, actual_wei, status FROM spend_ledger
         WHERE signer = $signer AND day = $day AND action = $action AND status != 'released'`
      )
      .all({ signer: this.signer, day, action });
    return sumRows(rows);
  }

  private nonExemptCommitted(day: string): bigint {
    const rows = this.db
      .query<{ reserved_wei: string; actual_wei: string | null; status: string }, Record<string, string>>(
        `SELECT reserved_wei, actual_wei, status FROM spend_ledger
         WHERE signer = $signer AND day = $day AND exempt = 0 AND status != 'released'`
      )
      .all({ signer: this.signer, day });
    return sumRows(rows);
  }

  private committed(day: string): bigint {
    const row = this.db
      .query<{ committed_wei: string }, { signer: string; day: string }>(
        'SELECT committed_wei FROM spend_days WHERE signer = $signer AND day = $day'
      )
      .get({ signer: this.signer, day });
    return row ? BigInt(row.committed_wei) : 0n;
  }

  private addCommitted(day: string, delta: bigint): void {
    const next = this.committed(day) + delta;
    this.db
      .query(
        `INSERT INTO spend_days (signer, day, committed_wei) VALUES ($signer, $day, $wei)
         ON CONFLICT (signer, day) DO UPDATE SET committed_wei = excluded.committed_wei`
      )
      .run({ signer: this.signer, day, wei: (next < 0n ? 0n : next).toString() });
  }

  private maybeAlert(day: string): void {
    if (this.alertedDay === day) return;
    const committed = this.committed(day);
    if (committed < this.cfg.alertWei) return;
    this.alertedDay = day;
    this.log.error({ day, committedWei: committed.toString(), capWei: this.cfg.capWei.toString() }, 'spend.alert_threshold');
  }
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

function sumRows(rows: readonly { reserved_wei: string; actual_wei: string | null; status: string }[]): bigint {
  return rows.reduce((s, r) => s + BigInt(r.status === 'settled' ? (r.actual_wei ?? r.reserved_wei) : r.reserved_wei), 0n);
}
