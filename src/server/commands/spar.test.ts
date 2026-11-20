import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event, EventDraft, EventOf } from '../../shared/events.ts';
import { ProductIdSchema, type ProductId } from '../../shared/ids.ts';
import { open } from '../db/index.ts';
import { createGit } from '../git/index.ts';
import { createApp } from '../http/index.ts';
import type { FakeScript } from '../llm/index.ts';
import { sparTurn, type SparringDeps } from '../pipeline/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { createSparring, nextSparMessageId, savePrdDraft, type SparTurnRunner } from './index.ts';

const P = ProductIdSchema.parse('product-1');
const MISSING = ProductIdSchema.parse('product-404');
const PRD = '# Todo\n\n## Problem\nPeople forget things.\n';

let logsDir: string;

beforeEach(async () => {
  logsDir = path.join(await mkdtemp(path.join(tmpdir(), 'vibecode-spar-cmd-')), 'logs');
});

afterEach(async () => {
  await rm(path.dirname(logsDir), { recursive: true, force: true });
});

const productDraft = (type: string, data: object) =>
  ({ type, productId: P, entityId: null, v: 1, data }) as EventDraft;

/** A promise the test resolves by hand. */
function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function setup(
  script: FakeScript,
  opts: { before?: Promise<void>; runTurn?: SparTurnRunner } = {},
) {
  const clock = new FakeClock(1_700_000_000_000);
  const redactor = new Redactor();
  const store = createStore({ db: open(':memory:'), clock, redactor });
  const ids = new FakeIdGen();
  store.commit(() => [
    productDraft('product.created', {
      name: 'Todo',
      idea: 'A todo app',
      budgetUsd: null,
      maxParallel: 3,
      maxAttempts: 3,
      models: { sparring: { provider: 'fake', model: 'fake' } },
      gitRemote: null,
    }),
  ]);
  const sparringDeps: SparringDeps = {
    store,
    ids,
    clock,
    redactor,
    logsDir,
    setTimer: () => () => undefined,
    modelDeps: { getSecret: () => undefined, fake: { script } },
  };
  const errors: unknown[] = [];
  const runTurn: SparTurnRunner = async (productId, message) => {
    await opts.before;
    await sparTurn(sparringDeps, productId, message);
  };
  const sparring = createSparring({
    store,
    ids,
    sparTurn: opts.runTurn ?? runTurn,
    onError: (e) => errors.push(e),
  });
  const app = createApp({
    store,
    ids,
    redactor,
    // These routes never touch git.
    git: createGit({ dataDir: '/nonexistent/vibecode-spar-tests' }),
    sparring,
  });
  const events: Event[] = [];
  store.subscribe((e) => events.push(e));
  return { store, ids, sparring, app, events, errors };
}

const finish = (input: object) => ({ toolCalls: [{ name: 'finish', input }] });
const ofType = <T extends Event['type']>(events: Event[], type: T) =>
  events.filter((e): e is EventOf<T> => e.type === type);
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const transcript = (store: ReturnType<typeof setup>['store'], id: ProductId = P) =>
  store.q.sparMessages(id).map((m) => [m.role, m.text]);

describe('sendSparMessage', () => {
  it('commits the owner message, then the agent question', async () => {
    const { store, sparring, errors } = setup([finish({ reply: 'Who will use it?' })]);

    const r = sparring.sendSparMessage(P, { message: '  I want a todo app ' });
    if (!r.ok) throw new Error(r.reason);
    expect(transcript(store)).toEqual([['owner', 'I want a todo app']]);
    expect(sparring.isTurnRunning(P)).toBe(true);

    await r.done;
    expect(transcript(store)).toEqual([
      ['owner', 'I want a todo app'],
      ['agent', 'Who will use it?'],
    ]);
    expect(store.q.prdDraft(P)).toBeNull();
    expect(sparring.isTurnRunning(P)).toBe(false);
    expect(errors).toEqual([]);
    expectSnapshotMatchesReplay(store);
  });

  it('saves the PRD draft the agent writes along with its reply', async () => {
    const { store, sparring, events } = setup([
      finish({ reply: 'Here is a first draft.', prdMarkdown: PRD }),
    ]);

    const r = sparring.sendSparMessage(P, { message: 'Families share one list' });
    if (!r.ok) throw new Error(r.reason);
    await r.done;

    expect(transcript(store).at(-1)).toEqual(['agent', 'Here is a first draft.']);
    expect(ofType(events, 'prd.draft_saved').map((e) => e.data)).toEqual([
      { markdown: PRD, baseVersion: 0 },
    ]);
    expectSnapshotMatchesReplay(store);
  });

  it('refuses a second turn while one is running (409) and accepts one afterwards', async () => {
    const g = gate();
    const { store, sparring, app } = setup(
      // Every agent run replays the script from the start.
      [finish({ reply: 'Who will use it?' })],
      { before: g.promise },
    );

    const first = await app.request(`/api/products/${P}/spar`, json('POST', { message: 'One' }));
    expect(first.status).toBe(202);
    const second = await app.request(`/api/products/${P}/spar`, json('POST', { message: 'Two' }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('conflict');
    expect(transcript(store)).toEqual([['owner', 'One']]);

    g.open();
    await sparring.idle();
    const third = sparring.sendSparMessage(P, { message: 'Three' });
    if (!third.ok) throw new Error(third.reason);
    await third.done;
    expect(transcript(store)).toEqual([
      ['owner', 'One'],
      ['agent', 'Who will use it?'],
      ['owner', 'Three'],
      ['agent', 'Who will use it?'],
    ]);
    expectSnapshotMatchesReplay(store);
  });

  it('keeps sparring in the building phase without touching the build', async () => {
    const { store, sparring } = setup([finish({ reply: 'Noted.', prdMarkdown: PRD })]);
    store.commit(() => [
      productDraft('prd.applied', { version: 1, markdown: '# v1', summary: null }),
      productDraft('product.handed_off', { prdVersion: 1 }),
    ]);

    const r = sparring.sendSparMessage(P, { message: 'Add due dates' });
    if (!r.ok) throw new Error(r.reason);
    await r.done;

    expect(store.q.product(P)?.phase).toBe('building');
    expect(store.q.product(P)?.prdVersion).toBe(1);
    expect(store.q.prdDraft(P)).toMatchObject({ markdown: PRD, baseVersion: 1 });
    expectSnapshotMatchesReplay(store);
  });

  it('reports an agent error as an agent message and an error inbox item', async () => {
    const { store, sparring, events, errors } = setup([{ error: { status: 401 } }]);

    const r = sparring.sendSparMessage(P, { message: 'Hello' });
    if (!r.ok) throw new Error(r.reason);
    await r.done;

    expect(transcript(store).at(-1)?.[0]).toBe('agent');
    expect(transcript(store).at(-1)?.[1]).toMatch(/Settings/);
    expect(ofType(events, 'inbox.created')[0]?.data.kind).toBe('error');
    expect(sparring.isTurnRunning(P)).toBe(false);
    expect(errors).toEqual([]);
    expectSnapshotMatchesReplay(store);
  });

  it('frees the product and reports when the turn runner throws', async () => {
    const { sparring, errors } = setup([], {
      runTurn: () => Promise.reject(new Error('disk full')),
    });

    const r = sparring.sendSparMessage(P, { message: 'Hello' });
    if (!r.ok) throw new Error(r.reason);
    await r.done;

    expect(sparring.isTurnRunning(P)).toBe(false);
    expect(errors).toEqual([new Error('disk full')]);
  });

  it('rejects an empty message (400) and an unknown product (404)', async () => {
    const { app, events } = setup([]);

    const empty = await app.request(`/api/products/${P}/spar`, json('POST', { message: '  ' }));
    expect(empty.status).toBe(400);
    const missing = await app.request(
      `/api/products/${MISSING}/spar`,
      json('POST', { message: 'Hi' }),
    );
    expect(missing.status).toBe(404);
    expect(events).toEqual([]);
  });
});

describe('nextSparMessageId', () => {
  it("draws spar message ids from IdGen's 'spar' kind", () => {
    expect(nextSparMessageId({ store: setup([]).store, ids: new FakeIdGen() })).toMatch(/^spar-/);
  });
});

describe('savePrdDraft', () => {
  it('stores the owner markdown via PUT /prd-draft', async () => {
    const { store, app, events } = setup([]);

    const res = await app.request(`/api/products/${P}/prd-draft`, json('PUT', { markdown: PRD }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ofType(events, 'prd.draft_saved').map((e) => e.data)).toEqual([
      { markdown: PRD, baseVersion: 0 },
    ]);
    expect(store.q.prdDraft(P)?.markdown).toBe(PRD);
    expectSnapshotMatchesReplay(store);
  });

  it('bases the owner draft on the applied version', () => {
    const { store, ids } = setup([]);
    store.commit(() => [
      productDraft('prd.applied', { version: 2, markdown: '# v2', summary: null }),
    ]);

    const r = savePrdDraft({ store, ids }, P, { markdown: '# v3 draft' });

    expect(r.ok).toBe(true);
    expect(store.q.prdDraft(P)).toMatchObject({ markdown: '# v3 draft', baseVersion: 2 });
    expectSnapshotMatchesReplay(store);
  });

  it('rejects a missing markdown field (400) and an unknown product (404)', async () => {
    const { app, events } = setup([]);

    const bad = await app.request(`/api/products/${P}/prd-draft`, json('PUT', {}));
    expect(bad.status).toBe(400);
    const missing = await app.request(
      `/api/products/${MISSING}/prd-draft`,
      json('PUT', { markdown: PRD }),
    );
    expect(missing.status).toBe(404);
    expect(events).toEqual([]);
  });
});
