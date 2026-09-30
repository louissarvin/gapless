import type { Address, Hex } from 'viem';
import type { Database } from '../../lib/db.ts';
import { SPEND_LEDGER_V2_SQL, utcDay } from '../../lib/spendGovernor.ts';

/** Relay migration 2. Rows are never deleted: they are the audit trail for the relay budget. */
export const SPONSOR_LEDGER_SQL = `
CREATE TABLE sponsor_creates (
  owner TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'rejected')),
  tx_hash TEXT,
  block_number TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE activations (
  account TEXT PRIMARY KEY,
  ip_key TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'rejected')),
  perpl_account_id TEXT,
  sweep_tx TEXT,
  operator TEXT,
  drip_tx TEXT,
  drip_wei TEXT,
  drip_block TEXT,
  drip_skipped TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX activations_one_drip_per_operator ON activations (operator) WHERE drip_tx IS NOT NULL;
CREATE TABLE daily_counters (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, key, day)
);
`;

/**
 * Relay migration 3: spend_ledger dedupe keys and the signer lease (shared with the keeper), plus the
 * drip nonce and state so a drip is on record before it is broadcast (M-3).
 */
export const SPONSOR_LEDGER_V3_SQL = `${SPEND_LEDGER_V2_SQL}
ALTER TABLE activations ADD COLUMN drip_nonce INTEGER;
ALTER TABLE activations ADD COLUMN drip_state TEXT;
`;

export interface SponsorCaps {
  createsPerIpPerDay: number;
  dailyCreateCap: number;
  totalCreateCap: number;
  activationsPerIpPerDay: number;
  /** Global /activate claims per UTC day. */
  dailyActivationCap: number;
  /** Lowercased demo owner: bypasses the create caps and holds one reserved slot of the total. */
  demoOwner?: string;
}

/** Drip skips that may change later (operator set, extended, allowlisted, spent down): re-evaluated on the next call. */
export const RETRYABLE_DRIP_SKIPS: ReadonlySet<string> = new Set(['disabled', 'no_operator', 'operator_expired', 'operator_no_budget', 'not_allowlisted', 'already_funded']);

/** drip_state: 'signed' is on record before broadcast and may still land; the rest are final. */
export type DripState = 'signed' | 'confirmed' | 'reverted' | 'dropped' | 'rejected';

/** A pending row older than this is from a crashed request; its onchain state decides what happens. */
export const PENDING_STALE_MS = 5 * 60_000;

export interface CreateRow {
  owner: string;
  account: string;
  status: 'pending' | 'sent' | 'failed' | 'rejected';
  tx_hash: string | null;
  block_number: string | null;
  error_code: string | null;
  updated_at: string;
}

export interface ActivationRow {
  account: string;
  status: 'pending' | 'done' | 'failed' | 'rejected';
  perpl_account_id: string | null;
  sweep_tx: string | null;
  operator: string | null;
  drip_tx: string | null;
  drip_wei: string | null;
  drip_block: string | null;
  drip_skipped: string | null;
  error_code: string | null;
  drip_nonce: number | null;
  drip_state: DripState | null;
  updated_at: string;
}

export type Claim<Row> =
  | { kind: 'claimed'; resumed: boolean }
  | { kind: 'existing'; row: Row }
  | { kind: 'in_progress'; row: Row }
  | { kind: 'failed'; row: Row }
  | { kind: 'cap'; scope: 'ip' | 'daily' | 'total' };

type Bind = Record<string, string | number | null>;

/** Per scope, key and UTC day counters (relay migration 2 table). Call inside the caller's transaction. */
/** The relay created `account` for `owner` (sent, or pending while it lands): the /activate rule, reused by SE3-M3. */
export function isSponsoredAccount(db: Database, owner: Address, account: Address): boolean {
  const row = db
    .query<{ n: number }, Bind>("SELECT COUNT(*) AS n FROM sponsor_creates WHERE owner = $owner AND account = $account AND status IN ('sent', 'pending')")
    .get({ owner: owner.toLowerCase(), account: account.toLowerCase() });
  return (row?.n ?? 0) > 0;
}

export class DailyCounters {
  constructor(private readonly db: Database) {}

  count(scope: string, key: string, day: string): number {
    return this.db.query<{ count: number }, Bind>('SELECT count FROM daily_counters WHERE scope = $scope AND key = $key AND day = $day').get({ scope, key, day })?.count ?? 0;
  }

  bump(scope: string, key: string, day: string, delta: number): void {
    this.db
      .query(
        `INSERT INTO daily_counters (scope, key, day, count) VALUES ($scope, $key, $day, MAX(0, $delta))
         ON CONFLICT (scope, key, day) DO UPDATE SET count = MAX(0, count + $delta)`
      )
      .run({ scope, key, day, delta });
  }

  /** Atomic check and increment: false when the count is already at `limit`. */
  take(scope: string, key: string, day: string, limit: number): boolean {
    return this.db
      .transaction((): boolean => {
        if (this.count(scope, key, day) >= limit) return false;
        this.bump(scope, key, day, 1);
        return true;
      })
      .immediate();
  }
}

/**
 * Idempotency and caps for the relay's spend routes. claim* runs in one BEGIN IMMEDIATE: it checks
 * the caps, then inserts or resumes the row and counts it, so two concurrent requests cannot both
 * pass. A request that ends before any tx was sent settles as `rejected`, which frees its count.
 */
export class SponsorLedger {
  private readonly now: () => number;
  private readonly counters: DailyCounters;

  constructor(
    private readonly db: Database,
    private readonly caps: SponsorCaps,
    now?: () => number
  ) {
    this.now = now ?? Date.now;
    this.counters = new DailyCounters(db);
  }

  isDemoOwner(owner: Address): boolean {
    return this.caps.demoOwner !== undefined && owner.toLowerCase() === this.caps.demoOwner;
  }

  getCreate(owner: Address): CreateRow | null {
    return this.db.query<CreateRow, Bind>('SELECT * FROM sponsor_creates WHERE owner = $owner').get({ owner: owner.toLowerCase() });
  }

  claimCreate(owner: Address, account: Address, ipKey: string): Claim<CreateRow> {
    const key = owner.toLowerCase();
    return this.db.transaction((): Claim<CreateRow> => {
      const row = this.getCreate(owner);
      const stale = row?.status === 'pending' && this.now() - Date.parse(row.updated_at) > PENDING_STALE_MS;
      if (row?.status === 'sent') return { kind: 'existing', row };
      if (row?.status === 'failed') return { kind: 'failed', row };
      if (row?.status === 'pending' && !stale) return { kind: 'in_progress', row };
      const at = this.iso();
      if (stale) {
        // Already counted when first claimed.
        this.db.query('UPDATE sponsor_creates SET updated_at = $at WHERE owner = $owner').run({ owner: key, at });
        return { kind: 'claimed', resumed: true };
      }
      const day = this.day();
      const demo = this.isDemoOwner(owner);
      if (!demo) {
        if (this.count('create_ip', ipKey, day) >= this.caps.createsPerIpPerDay) return { kind: 'cap', scope: 'ip' };
        if (this.count('create_day', '*', day) >= this.caps.dailyCreateCap) return { kind: 'cap', scope: 'daily' };
        // The demo owner's slot is reserved: others share totalCap - 1 and the demo row is not counted.
        const reserved = this.caps.demoOwner !== undefined ? 1 : 0;
        const total = this.db
          .query<{ n: number }, Bind>("SELECT COUNT(*) AS n FROM sponsor_creates WHERE status IN ('pending', 'sent', 'failed') AND owner != $demo")
          .get({ demo: this.caps.demoOwner ?? '' })!.n;
        if (total >= this.caps.totalCreateCap - reserved) return { kind: 'cap', scope: 'total' };
      }
      this.db
        .query(
          `INSERT INTO sponsor_creates (owner, account, ip_key, day, status, created_at, updated_at)
           VALUES ($owner, $account, $ip, $day, 'pending', $at, $at)
           ON CONFLICT (owner) DO UPDATE SET account = excluded.account, ip_key = excluded.ip_key, day = excluded.day,
             status = 'pending', tx_hash = NULL, block_number = NULL, error_code = NULL, updated_at = excluded.updated_at`
        )
        .run({ owner: key, account: account.toLowerCase(), ip: ipKey, day, at });
      if (!demo) {
        this.bump('create_ip', ipKey, day, 1);
        this.bump('create_day', '*', day, 1);
      }
      return { kind: 'claimed', resumed: false };
    }).immediate();
  }

  settleCreate(
    owner: Address,
    s: { status: 'sent'; txHash: Hex | null; block: bigint | null } | { status: 'pending'; txHash: Hex } | { status: 'failed' | 'rejected'; code: string; txHash?: Hex }
  ): void {
    const key = owner.toLowerCase();
    this.db.transaction(() => {
      const row = this.db.query<{ ip_key: string; day: string; status: string }, Bind>('SELECT ip_key, day, status FROM sponsor_creates WHERE owner = $owner').get({ owner: key });
      if (!row) return;
      this.db
        .query('UPDATE sponsor_creates SET status = $status, tx_hash = $hash, block_number = $block, error_code = $code, updated_at = $at WHERE owner = $owner')
        .run({
          owner: key,
          status: s.status,
          hash: 'txHash' in s ? (s.txHash ?? null) : null,
          block: s.status === 'sent' && s.block !== null ? s.block.toString() : null,
          code: s.status === 'failed' || s.status === 'rejected' ? s.code : null,
          at: this.iso()
        });
      if (s.status === 'rejected' && row.status === 'pending' && !this.isDemoOwner(owner)) {
        this.bump('create_ip', row.ip_key, row.day, -1);
        this.bump('create_day', '*', row.day, -1);
      }
    }).immediate();
  }

  getActivation(account: Address): ActivationRow | null {
    return this.db.query<ActivationRow, Bind>('SELECT * FROM activations WHERE account = $account').get({ account: account.toLowerCase() });
  }

  /**
   * A finished activation whose drip was skipped for a reason that can change is reopened (I-4: a third
   * party calling first cannot lock it). Retries of an activation that already spent (sweep sent) or was
   * reopened are not counted again.
   */
  claimActivation(account: Address, ipKey: string): Claim<ActivationRow> {
    const key = account.toLowerCase();
    return this.db.transaction((): Claim<ActivationRow> => {
      const row = this.getActivation(account);
      const stale = row?.status === 'pending' && this.now() - Date.parse(row.updated_at) > PENDING_STALE_MS;
      const reopen = row?.status === 'done' && row.drip_tx === null && row.drip_skipped !== null && RETRYABLE_DRIP_SKIPS.has(row.drip_skipped);
      if (row?.status === 'done' && !reopen) return { kind: 'existing', row };
      if (row?.status === 'failed') return { kind: 'failed', row };
      if (row?.status === 'pending' && !stale) return { kind: 'in_progress', row };
      const at = this.iso();
      if (stale) {
        this.db.query('UPDATE activations SET updated_at = $at WHERE account = $account').run({ account: key, at });
        return { kind: 'claimed', resumed: true };
      }
      if (reopen || (row !== null && row.sweep_tx !== null)) {
        this.db.query("UPDATE activations SET status = 'pending', error_code = NULL, updated_at = $at WHERE account = $account").run({ account: key, at });
        return { kind: 'claimed', resumed: true };
      }
      const day = this.day();
      if (this.count('activate_ip', ipKey, day) >= this.caps.activationsPerIpPerDay) return { kind: 'cap', scope: 'ip' };
      if (this.count('activate_day', '*', day) >= this.caps.dailyActivationCap) return { kind: 'cap', scope: 'daily' };
      this.db
        .query(
          `INSERT INTO activations (account, ip_key, day, status, created_at, updated_at)
           VALUES ($account, $ip, $day, 'pending', $at, $at)
           ON CONFLICT (account) DO UPDATE SET ip_key = excluded.ip_key, day = excluded.day, status = 'pending',
             error_code = NULL, updated_at = excluded.updated_at`
        )
        .run({ account: key, ip: ipKey, day, at });
      this.bump('activate_ip', ipKey, day, 1);
      this.bump('activate_day', '*', day, 1);
      return { kind: 'claimed', resumed: false };
    }).immediate();
  }

  /** Records progress (tx hashes) as each step lands, so a crash leaves a trail. */
  updateActivation(account: Address, fields: Partial<Omit<ActivationRow, 'account' | 'status' | 'updated_at'>>): void {
    const cols = Object.keys(fields).filter((k) => ACTIVATION_COLUMNS.has(k));
    if (cols.length === 0) return;
    // Column names come from the fixed allowlist above, never from input.
    const set = cols.map((c) => `${c} = $${c}`).join(', ');
    const bind: Bind = { account: account.toLowerCase(), at: this.iso() };
    for (const c of cols) bind[c] = (fields as Record<string, string | null>)[c] ?? null;
    this.db.query(`UPDATE activations SET ${set}, updated_at = $at WHERE account = $account`).run(bind);
  }

  finishActivation(account: Address, status: 'done' | 'failed' | 'rejected', code: string | null = null): void {
    const key = account.toLowerCase();
    this.db.transaction(() => {
      const row = this.db.query<{ ip_key: string; day: string; status: string; sweep_tx: string | null }, Bind>(
        'SELECT ip_key, day, status, sweep_tx FROM activations WHERE account = $account'
      ).get({ account: key });
      if (!row) return;
      this.db
        .query('UPDATE activations SET status = $status, error_code = $code, updated_at = $at WHERE account = $account')
        .run({ account: key, status, code, at: this.iso() });
      // Free the count only when nothing was sent for this attempt.
      if (status === 'rejected' && row.status === 'pending' && row.sweep_tx === null) {
        this.bump('activate_ip', row.ip_key, row.day, -1);
        this.bump('activate_day', '*', row.day, -1);
      }
    }).immediate();
  }

  /** M-3: written after signing and before broadcast. The unique operator index makes a second drip impossible. */
  recordDripSigned(account: Address, operator: Address, hash: Hex, nonce: number, wei: bigint): void {
    this.db
      .query(
        `UPDATE activations SET operator = $op, drip_tx = $hash, drip_nonce = $nonce, drip_wei = $wei, drip_state = 'signed',
           drip_block = NULL, updated_at = $at WHERE account = $account`
      )
      .run({ account: account.toLowerCase(), op: operator.toLowerCase(), hash, nonce, wei: wei.toString(), at: this.iso() });
  }

  /** Confirmed keeps the hash; reverted, dropped and rejected clear it (no MON moved, the operator may be dripped later). */
  settleDrip(account: Address, s: { state: 'confirmed'; block: bigint } | { state: 'reverted' | 'dropped' | 'rejected' }): void {
    const confirmed = s.state === 'confirmed';
    this.db
      .query(
        `UPDATE activations SET drip_state = $state, drip_block = $block,
           drip_tx = CASE WHEN $keep = 1 THEN drip_tx ELSE NULL END,
           drip_skipped = CASE WHEN $state = 'reverted' THEN 'drip_reverted' ELSE drip_skipped END,
           updated_at = $at WHERE account = $account`
      )
      .run({ account: account.toLowerCase(), state: s.state, block: confirmed ? s.block.toString() : null, keep: confirmed ? 1 : 0, at: this.iso() });
  }

  operatorDripped(operator: Address): boolean {
    return (
      this.db.query<{ n: number }, Bind>('SELECT COUNT(*) AS n FROM activations WHERE operator = $op AND drip_tx IS NOT NULL').get({ op: operator.toLowerCase() })!.n > 0
    );
  }

  private count(scope: string, key: string, day: string): number {
    return this.counters.count(scope, key, day);
  }

  private bump(scope: string, key: string, day: string, delta: number): void {
    this.counters.bump(scope, key, day, delta);
  }

  private day(): string {
    return utcDay(this.now());
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

const ACTIVATION_COLUMNS = new Set(['perpl_account_id', 'sweep_tx', 'operator', 'drip_tx', 'drip_wei', 'drip_block', 'drip_skipped', 'error_code']);
