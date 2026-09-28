import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type { Database };

/** Append-only. Never edit or reorder a shipped migration; add a new id instead. */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Opens a SQLite file with WAL and strict binding (missing params throw).
 * Use db.query(sql) with bound params for all data access; never interpolate values into SQL.
 */
export function openDb(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA busy_timeout = 5000');
  return db;
}

/** Applies pending migrations in id order, each in its own transaction. Returns ids applied. */
export function migrate(db: Database, migrations: readonly Migration[]): number[] {
  db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`
  );
  const ids = migrations.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate migration id');

  const isApplied = db.query<{ id: number }, { id: number }>(
    'SELECT id FROM schema_migrations WHERE id = $id'
  );
  const record = db.query('INSERT INTO schema_migrations (id, name, applied_at) VALUES ($id, $name, $at)');

  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (isApplied.get({ id: m.id })) continue;
    db.transaction(() => {
      // Migration SQL is a static string from source control, never user input.
      db.run(m.sql);
      record.run({ id: m.id, name: m.name, at: new Date().toISOString() });
    }).immediate();
    applied.push(m.id);
  }
  return applied;
}

/** Cheap liveness probe for /healthz. */
export function pingDb(db: Database): boolean {
  try {
    return db.query<{ ok: number }, []>('SELECT 1 AS ok').get()?.ok === 1;
  } catch {
    return false;
  }
}
