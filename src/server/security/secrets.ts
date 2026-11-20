import { asc, eq } from 'drizzle-orm';
import type { Clock } from '../../shared/ids.ts';
import { type Db, schema } from '../db/index.ts';
import { LAST4_MIN_LENGTH } from './redact.ts';

/** A secret as the client may see it: never the value, at most its last 4 characters. */
export interface SecretInfo {
  key: string;
  /** null when the value is shorter than LAST4_MIN_LENGTH (4 chars would reveal too much). */
  last4: string | null;
}

/** The `secrets` table (API keys, git tokens, session key). Never in events or sent in full. */
export interface Secrets {
  get(key: string): string | undefined;
  /** Stores the value and registers it with the redactor. */
  set(key: string, value: string): void;
  /** Removes the value; it stays registered with the redactor (old output may contain it). */
  delete(key: string): void;
  list(): SecretInfo[];
}

export interface SecretsDeps {
  /** The store's connection: calls inside a `store.commit` builder join its transaction. */
  db: Db;
  clock: Clock;
  redactor: { register(value: string): void };
}

/** Opens the secret store and registers every stored value with the redactor (boot). */
export function createSecrets({ db, clock, redactor }: SecretsDeps): Secrets {
  const t = schema.secrets;
  for (const { value } of db.select({ value: t.value }).from(t).all()) redactor.register(value);

  return {
    get: (key) => db.select({ value: t.value }).from(t).where(eq(t.key, key)).get()?.value,
    set(key, value) {
      redactor.register(value);
      const updatedAt = clock.now();
      db.insert(t)
        .values({ key, value, updatedAt })
        .onConflictDoUpdate({ target: t.key, set: { value, updatedAt } })
        .run();
    },
    delete(key) {
      db.delete(t).where(eq(t.key, key)).run();
    },
    list: () =>
      db
        .select({ key: t.key, value: t.value })
        .from(t)
        .orderBy(asc(t.key))
        .all()
        .map(({ key, value }) => ({
          key,
          last4: value.length >= LAST4_MIN_LENGTH ? value.slice(-4) : null,
        })),
  };
}
