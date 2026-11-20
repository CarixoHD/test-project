import { closeSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

const MIGRATIONS_DIR = resolve(import.meta.dirname, 'migrations');

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/**
 * Opens (creating if needed) the SQLite database at `path`, or an in-memory one for
 * ':memory:', sets the ADR 5 pragmas and applies the checked-in migrations.
 * A new database file is created with mode 0600 (it holds secrets).
 */
export function open(path: string): Db {
  if (path !== ':memory:') {
    // 'a' creates the file if missing (mode applies only on creation) and never truncates.
    closeSync(openSync(path, 'a', 0o600));
  }
  const client = new Database(path);
  try {
    client.pragma('journal_mode = WAL');
    client.pragma('synchronous = NORMAL');
    client.pragma('busy_timeout = 5000');
    client.pragma('foreign_keys = ON');
    const db = drizzle({ client, schema });
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    return db;
  } catch (err) {
    client.close();
    throw new Error(`Cannot open the database at ${path}`, { cause: err });
  }
}
