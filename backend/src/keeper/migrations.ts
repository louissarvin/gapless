import type { Migration } from '../lib/db.ts';
import { SPEND_LEDGER_SQL, SPEND_LEDGER_V2_SQL } from '../lib/spendGovernor.ts';
import { KEEPER_TOUCHES_SQL } from './touches.ts';

/** Keeper schema (data/keeper.sqlite), append-only. */
export const KEEPER_MIGRATIONS: readonly Migration[] = [
  { id: 1, name: 'spend_ledger', sql: SPEND_LEDGER_SQL },
  { id: 2, name: 'dedupe_key_and_signer_lease', sql: SPEND_LEDGER_V2_SQL },
  { id: 3, name: 'keeper_touches', sql: KEEPER_TOUCHES_SQL }
];
