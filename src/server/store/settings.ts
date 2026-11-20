import { eq } from 'drizzle-orm';
import { type Db, schema } from '../db/index.ts';

// The account-wide `settings` table has no events of its own: commands write it with the
// connection they are given (inside a `store.commit` builder: `tx.db`). Values are JSON;
// callers validate what they read.

const t = schema.settings;

/** Raw JSON value of a settings row, undefined when unset. */
export function readSetting(db: Db, key: string): unknown {
  return db.select({ value: t.value }).from(t).where(eq(t.key, key)).get()?.value;
}

export function writeSetting(db: Db, key: string, value: unknown): void {
  db.insert(t).values({ key, value }).onConflictDoUpdate({ target: t.key, set: { value } }).run();
}

export function deleteSetting(db: Db, key: string): void {
  db.delete(t).where(eq(t.key, key)).run();
}
