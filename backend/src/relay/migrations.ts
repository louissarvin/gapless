import type { Migration } from '../lib/db.ts';
import { SPEND_LEDGER_SQL } from '../lib/spendGovernor.ts';
import { SPONSOR_LEDGER_SQL, SPONSOR_LEDGER_V3_SQL } from './sponsor/ledger.ts';

/**
 * Relay schema, append-only. Never edit or reorder a shipped migration.
 * Store wei and token amounts as decimal TEXT: SQLite INTEGER tops out near 9.2 MON in wei.
 */
export const RELAY_MIGRATIONS: readonly Migration[] = [
  { id: 1, name: 'spend_ledger', sql: SPEND_LEDGER_SQL },
  { id: 2, name: 'sponsor_ledgers', sql: SPONSOR_LEDGER_SQL },
  { id: 3, name: 'dedupe_lease_drip_state', sql: SPONSOR_LEDGER_V3_SQL }
];
