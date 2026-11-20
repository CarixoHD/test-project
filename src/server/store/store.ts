import { asc, gt } from 'drizzle-orm';
import { EventSchema, parseEvent, type Event, type EventDraft } from '../../shared/events.ts';
import type { Clock } from '../../shared/ids.ts';
import type { ClientState } from '../../shared/state.ts';
import { type Db, schema } from '../db/index.ts';
import { projectEvent } from './project.ts';
import { createQueries, readSnapshot, type Queries } from './read.ts';

/** What a commit builder gets: reads, plus raw access for tables without events (settings, secrets). */
export interface Tx {
  q: Queries;
  /**
   * The connection, inside the commit transaction. Projection tables are written by the store
   * from the returned events; builders only write tables that have no events.
   */
  db: Db;
}

/**
 * Runs inside the commit transaction after the builder's drafts were appended and projected
 * (so `tx.q` sees them). Returns extra drafts to append in the same commit, e.g. inbox items
 * derived from domain events. Hooks see only the builder's events, never other hooks' output.
 */
export type CommitHook = (committed: readonly Event[], tx: Tx) => EventDraft[];

export interface Store {
  /**
   * One synchronous transaction: runs `build`, then validates, redacts, numbers, appends and
   * projects every returned draft. Throws (and writes nothing) when `build` or any draft
   * fails. Subscribers are notified only after the transaction has committed.
   */
  commit(build: (tx: Tx) => EventDraft[]): Event[];
  /** ClientState built from the projection tables. */
  snapshot(): { state: ClientState; lastSeq: number };
  /** Events with seq > `seq`, ascending, at most `limit`. */
  eventsSince(seq: number, limit?: number): Event[];
  /** Called for every committed event, in seq order. Returns an unsubscribe function. */
  subscribe(fn: (e: Event) => void): () => void;
  q: Queries;
}

export interface StoreDeps {
  db: Db;
  clock: Clock;
  redactor: { redact(text: string): string };
  /** Derived-event hooks, run in order in every commit (see `CommitHook`). */
  hooks?: readonly CommitHook[];
}

/** Applies `redact` to every string in a JSON-like value. */
function redactDeep(value: unknown, redact: (t: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)]));
  }
  return value;
}

export function createStore({ db, clock, redactor, hooks = [] }: StoreDeps): Store {
  const listeners = new Set<(e: Event) => void>();
  const q = createQueries(db);
  let committing = false;

  /** Validates, redacts, appends and projects one draft; returns the stored event. */
  function append(draft: EventDraft, ts: number): Event {
    // Placeholder seq: the real one is assigned by the insert below.
    const checked = EventSchema.parse({ ...draft, seq: 1, ts });
    const redacted = EventSchema.parse({
      ...checked,
      data: redactDeep(checked.data, (t) => redactor.redact(t)),
    });
    const { seq } = db
      .insert(schema.events)
      .values({
        ts,
        type: redacted.type,
        productId: redacted.productId,
        entityId: redacted.entityId,
        v: redacted.v,
        data: JSON.stringify(redacted.data),
      })
      .returning({ seq: schema.events.seq })
      .get();
    const event = { ...redacted, seq };
    projectEvent(db, event);
    return event;
  }

  function notify(committed: Event[]): void {
    const errors: unknown[] = [];
    for (const e of committed) {
      for (const fn of [...listeners]) {
        try {
          fn(e);
        } catch (err) {
          errors.push(err);
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'store subscribers threw (the commit itself is durable)');
    }
  }

  return {
    commit(build) {
      if (committing) throw new Error('store.commit() called inside a commit builder');
      committing = true;
      let committed: Event[];
      try {
        committed = db.$client
          .transaction(() => {
            const tx: Tx = { q, db };
            const drafts = build(tx);
            const ts = clock.now();
            const built = drafts.map((d) => append(d, ts));
            const derived = hooks.flatMap((hook) => hook(built, tx).map((d) => append(d, ts)));
            return [...built, ...derived];
          })
          .immediate();
      } finally {
        committing = false;
      }
      notify(committed);
      return committed;
    },
    snapshot: () => readSnapshot(db),
    eventsSince(seq, limit) {
      const rows = db
        .select()
        .from(schema.events)
        .where(gt(schema.events.seq, seq))
        .orderBy(asc(schema.events.seq))
        .limit(limit ?? -1)
        .all();
      const out: Event[] = [];
      for (const { data, ...envelope } of rows) {
        const e = parseEvent({ ...envelope, data: JSON.parse(data) as unknown });
        if (e !== null) out.push(e); // null: a type this build does not know (forward compat)
      }
      return out;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    q,
  };
}
