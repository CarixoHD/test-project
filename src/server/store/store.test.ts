import { describe, expect, it } from 'vitest';
import type { Event, EventDraft } from '../../shared/events.ts';
import { AgentIdSchema, ProductIdSchema } from '../../shared/ids.ts';
import { open, schema } from '../db/index.ts';
import { Redactor } from '../security/index.ts';
import { FakeClock } from '../util/clock.ts';
import { createStore, type CommitHook } from './index.ts';
import { expectSnapshotMatchesReplay } from './testing.ts';

const P = ProductIdSchema.parse('product-1');
const SECRET = 'sk-ant-api03-abcdefghijklmnop1234';

function setup() {
  const db = open(':memory:');
  const clock = new FakeClock(1_700_000_000_000);
  const redactor = new Redactor();
  const store = createStore({ db, clock, redactor });
  return { db, clock, redactor, store };
}

const productCreated = (name = 'Todo'): EventDraft => ({
  type: 'product.created',
  productId: P,
  entityId: null,
  v: 1,
  data: {
    name,
    idea: 'A todo app',
    budgetUsd: 10,
    maxParallel: 3,
    maxAttempts: 3,
    models: {},
    gitRemote: null,
  },
});

const sparMessage = (id: string, text: string): EventDraft => ({
  type: 'spar.message',
  productId: P,
  entityId: id,
  v: 1,
  data: { role: 'owner', text },
});

function rowCount(db: ReturnType<typeof open>, table: string): number {
  return db.$client.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
}

describe('store.commit', () => {
  it('appends events with increasing seq and clock ts, and projects them', () => {
    const { store, clock } = setup();
    const [created] = store.commit(() => [productCreated()]);
    clock.advance(5);
    const msgs = store.commit(() => [sparMessage('m1', 'hi'), sparMessage('m2', 'there')]);

    expect(created).toMatchObject({ seq: 1, ts: 1_700_000_000_000, type: 'product.created' });
    expect(msgs.map((e) => [e.seq, e.ts])).toEqual([
      [2, 1_700_000_000_005],
      [3, 1_700_000_000_005],
    ]);
    expect(store.q.product(P)?.name).toBe('Todo');
    expect(store.snapshot().state.sparMessages[P]?.map((m) => m.text)).toEqual(['hi', 'there']);
    expectSnapshotMatchesReplay(store);
  });

  it('rolls back everything and notifies nobody when the builder throws', () => {
    const { store, db } = setup();
    const seen: Event[] = [];
    store.subscribe((e) => seen.push(e));

    expect(() =>
      store.commit((tx) => {
        tx.db.insert(schema.settings).values({ key: 'k', value: 1 }).run();
        throw new Error('builder failed');
      }),
    ).toThrow('builder failed');

    for (const table of ['events', 'products', 'settings']) expect(rowCount(db, table)).toBe(0);
    expect(seen).toEqual([]);
    expect(store.snapshot().lastSeq).toBe(0);
  });

  it('rolls back earlier drafts of the same commit when a later draft is invalid', () => {
    const { store, db } = setup();
    const seen: Event[] = [];
    store.subscribe((e) => seen.push(e));
    const invalid = { ...sparMessage('m1', ''), data: { role: 'owner', text: '' } } as EventDraft;

    expect(() => store.commit(() => [productCreated(), invalid])).toThrow();

    expect(rowCount(db, 'events')).toBe(0);
    expect(rowCount(db, 'products')).toBe(0);
    expect(seen).toEqual([]);
  });

  it('rejects an event the projections cannot hold, writing nothing', () => {
    const { store, db } = setup();
    // No such product: the foreign key fails, so the event is not stored either.
    expect(() => store.commit(() => [sparMessage('m1', 'orphan')])).toThrow();
    expect(rowCount(db, 'events')).toBe(0);
  });

  it('redacts registered secrets in event data before insert', () => {
    const { store, db, redactor } = setup();
    redactor.register(SECRET);
    store.commit(() => [productCreated()]);
    const [stored] = store.commit(() => [sparMessage('m1', `my key is ${SECRET}!`)]);

    const expected = `my key is ***${SECRET.slice(-4)}!`;
    expect(stored).toMatchObject({ data: { text: expected } });
    const raw = db.$client.prepare('SELECT data FROM events').pluck().all() as string[];
    expect(raw.join('\n')).not.toContain(SECRET);
    expect(store.eventsSince(0)[1]).toMatchObject({ data: { text: expected } });
    expect(store.snapshot().state.sparMessages[P]?.[0]?.text).toBe(expected);
    const projected = db.$client.prepare('SELECT text FROM spar_messages').pluck().get();
    expect(projected).toBe(expected);
  });

  it('notifies subscribers after the commit, in seq order, until they unsubscribe', () => {
    const { store } = setup();
    const seen: Array<[number, number]> = [];
    const off = store.subscribe((e) => seen.push([e.seq, store.snapshot().lastSeq]));
    store.commit(() => [productCreated(), sparMessage('m1', 'a')]);
    off();
    store.commit(() => [sparMessage('m2', 'b')]);
    // Each callback already sees the whole transaction committed.
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('refuses a nested commit from inside a builder', () => {
    const { store, db } = setup();
    expect(() => store.commit(() => store.commit(() => [productCreated()]))).toThrow(/inside/);
    expect(rowCount(db, 'events')).toBe(0);
  });
});

describe('store.eventsSince', () => {
  it('returns events after seq in ascending order, honouring the limit', () => {
    const { store } = setup();
    store.commit(() => [productCreated()]);
    for (let i = 1; i <= 4; i++) store.commit(() => [sparMessage(`m${i}`, `msg ${i}`)]);

    expect(store.eventsSince(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(store.eventsSince(2).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(store.eventsSince(1, 2).map((e) => e.seq)).toEqual([2, 3]);
    expect(store.eventsSince(5)).toEqual([]);
  });

  it('returns the events exactly as commit returned them', () => {
    const { store } = setup();
    const committed = store.commit(() => [productCreated(), sparMessage('m1', 'hello')]);
    expect(store.eventsSince(0)).toStrictEqual(committed);
  });
});

describe('commit hooks', () => {
  function setupWithHook(hook: CommitHook) {
    const db = open(':memory:');
    const store = createStore({
      db,
      clock: new FakeClock(1_700_000_000_000),
      redactor: new Redactor(),
      hooks: [hook],
    });
    return { db, store };
  }

  it('appends the drafts a hook derives from the builder events in the same commit', () => {
    const seen: string[] = [];
    const { store } = setupWithHook((events, tx) => {
      seen.push(...events.map((e) => e.type));
      // The hook reads the projections as of the builder's events.
      const name = tx.q.product(P)?.name ?? 'missing';
      return events
        .filter((e) => e.type === 'product.created')
        .map(() => sparMessage('hooked', `welcome ${name}`));
    });
    const committed = store.commit(() => [productCreated()]);

    expect(committed.map((e) => [e.seq, e.type])).toEqual([
      [1, 'product.created'],
      [2, 'spar.message'],
    ]);
    expect(committed[1]?.data).toMatchObject({ text: 'welcome Todo' });
    // Hook output is not fed back into hooks.
    expect(seen).toEqual(['product.created']);
    expectSnapshotMatchesReplay(store);
  });

  it('rolls back the builder events when a hook throws', () => {
    const { store, db } = setupWithHook(() => {
      throw new Error('hook failed');
    });
    expect(() => store.commit(() => [productCreated()])).toThrow('hook failed');
    expect(rowCount(db, 'events')).toBe(0);
    expect(rowCount(db, 'products')).toBe(0);
  });
});

describe('store.q.setting', () => {
  it('returns the stored JSON value, or undefined when the key is unset', () => {
    const { store } = setup();
    expect(store.q.setting('defaultModel')).toBeUndefined();

    store.commit((tx) => {
      tx.db
        .insert(schema.settings)
        .values({ key: 'defaultModel', value: { provider: 'fake', model: 'm' } })
        .run();
      return [];
    });

    expect(store.q.setting('defaultModel')).toEqual({ provider: 'fake', model: 'm' });
  });
});

describe('store.q.sparMessages / prdDraft', () => {
  it('returns the transcript in arrival order and the current draft', () => {
    const { store } = setup();
    store.commit(() => [productCreated()]);
    expect(store.q.sparMessages(P)).toEqual([]);
    expect(store.q.prdDraft(P)).toBeNull();

    store.commit(() => [sparMessage('m-2', 'first'), sparMessage('m-1', 'second')]);
    store.commit(() => [
      {
        type: 'prd.draft_saved',
        productId: P,
        entityId: null,
        v: 1,
        data: { markdown: '# D', baseVersion: 0 },
      },
    ]);

    expect(store.q.sparMessages(P).map((m) => [m.id, m.text])).toEqual([
      ['m-2', 'first'],
      ['m-1', 'second'],
    ]);
    expect(store.q.prdDraft(P)).toMatchObject({ markdown: '# D', baseVersion: 0 });
  });
});

describe('store.q.agent', () => {
  it('returns the projected agent, or null when unknown', () => {
    const { store } = setup();
    store.commit(() => [productCreated()]);
    expect(store.q.agent(AgentIdSchema.parse('a-1'))).toBeNull();

    store.commit(() => [
      {
        type: 'agent.spawned',
        productId: P,
        entityId: AgentIdSchema.parse('a-1'),
        v: 1,
        data: {
          role: 'implementer',
          model: { provider: 'fake', model: 'fake' },
          issueId: null,
          attemptId: null,
        },
      },
    ]);

    expect(store.q.agent(AgentIdSchema.parse('a-1'))).toMatchObject({
      id: 'a-1',
      role: 'implementer',
      state: 'working',
      endedAt: null,
    });
  });
});
