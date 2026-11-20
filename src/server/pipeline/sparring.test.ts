import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event, EventDraft, EventOf } from '../../shared/events.ts';
import { ProductIdSchema, type ProductId } from '../../shared/ids.ts';
import { open } from '../db/index.ts';
import type { FakeScript } from '../llm/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { PROMPTS_DIR, sparTurn, type SparringDeps } from './index.ts';

const START = 1_700_000_000_000;
const P = ProductIdSchema.parse('product-1');
const PRD = `# Todo\n\n## Problem\nPeople forget things.\n`;

let logsDir: string;

beforeEach(async () => {
  logsDir = path.join(await mkdtemp(path.join(tmpdir(), 'vibecode-sparring-')), 'logs');
});

afterEach(async () => {
  await rm(path.dirname(logsDir), { recursive: true, force: true });
});

const productCreated = (productId: ProductId, models = {}): EventDraft => ({
  type: 'product.created',
  productId,
  entityId: null,
  v: 1,
  data: {
    name: 'Todo',
    idea: 'A todo app for families',
    budgetUsd: null,
    maxParallel: 3,
    maxAttempts: 3,
    models,
    gitRemote: null,
  },
});

const ownerMessage = (id: string, text: string): EventDraft => ({
  type: 'spar.message',
  productId: P,
  entityId: id,
  v: 1,
  data: { role: 'owner', text },
});

function setup(script: FakeScript, opts: { models?: object; demo?: boolean } = {}) {
  const clock = new FakeClock(START);
  const store = createStore({ db: open(':memory:'), clock, redactor: new Redactor() });
  store.commit(() => [
    productCreated(P, opts.models ?? { sparring: { provider: 'fake', model: 'fake' } }),
    ownerMessage('owner-msg-1', 'I want a todo app'),
  ]);
  const events: Event[] = [];
  store.subscribe((e) => events.push(e));
  const deps: SparringDeps = {
    store,
    ids: new FakeIdGen(),
    clock,
    redactor: new Redactor(),
    logsDir,
    setTimer: () => () => undefined,
    modelDeps: { getSecret: () => undefined, fake: { script } },
    ...(opts.demo === undefined ? {} : { demo: opts.demo }),
  };
  return { store, deps, events };
}

const finish = (input: object) => ({ toolCalls: [{ name: 'finish', input }] });
const ofType = <T extends Event['type']>(events: Event[], type: T) =>
  events.filter((e): e is EventOf<T> => e.type === type);

describe('sparTurn', () => {
  it('records the agent question as a spar.message and saves no draft', async () => {
    const { store, deps, events } = setup([finish({ reply: 'Who will use it?' })]);

    await sparTurn(deps, P, 'I want a todo app');

    expect(ofType(events, 'agent.spawned')[0]?.data.role).toBe('sparring');
    expect(ofType(events, 'spar.message').map((e) => e.data)).toEqual([
      { role: 'agent', text: 'Who will use it?' },
    ]);
    expect(ofType(events, 'prd.draft_saved')).toEqual([]);
    expect(store.q.sparMessages(P).map((m) => m.role)).toEqual(['owner', 'agent']);
    expect(store.q.prdDraft(P)).toBeNull();
    expectSnapshotMatchesReplay(store);
  });

  it('saves the PRD draft when the agent returns prdMarkdown', async () => {
    const { store, deps, events } = setup([
      finish({ reply: 'Here is a first draft.', prdMarkdown: PRD }),
    ]);

    await sparTurn(deps, P, 'I want a todo app');

    const reply = ofType(events, 'spar.message')[0];
    const saved = ofType(events, 'prd.draft_saved')[0];
    expect(reply?.data).toEqual({ role: 'agent', text: 'Here is a first draft.' });
    expect(saved?.data).toEqual({ markdown: PRD, baseVersion: 0 });
    expect(reply?.seq).toBeLessThan(saved?.seq ?? 0);
    expect(store.q.prdDraft(P)?.markdown).toBe(PRD);
    expectSnapshotMatchesReplay(store);
  });

  it('bases the draft on the applied PRD version in the building phase', async () => {
    const { store, deps, events } = setup([finish({ reply: 'Updated.', prdMarkdown: PRD })]);
    store.commit(() => [
      {
        type: 'prd.applied',
        productId: P,
        entityId: null,
        v: 1,
        data: { version: 1, markdown: '# v1', summary: null },
      },
      { type: 'product.handed_off', productId: P, entityId: null, v: 1, data: { prdVersion: 1 } },
    ]);

    await sparTurn(deps, P, 'Add due dates');

    expect(ofType(events, 'prd.draft_saved')[0]?.data).toEqual({ markdown: PRD, baseVersion: 1 });
    expect(store.q.product(P)?.phase).toBe('building');
    expectSnapshotMatchesReplay(store);
  });

  it('turns an agent error into an actionable agent message and an error inbox item', async () => {
    const { store, deps, events } = setup([{ error: { status: 401 } }]);

    await sparTurn(deps, P, 'I want a todo app');

    const [message] = ofType(events, 'spar.message');
    expect(message?.data.role).toBe('agent');
    expect(message?.data.text).toMatch(/Settings/);
    expect(message?.data.text).toMatch(/send your message again/i);
    const [inbox] = ofType(events, 'inbox.created');
    expect(inbox?.data).toMatchObject({ kind: 'error', link: `/products/${P}` });
    expect(inbox?.data.body).toBe(message?.data.text);
    expect(ofType(events, 'prd.draft_saved')).toEqual([]);
    expectSnapshotMatchesReplay(store);
  });

  it('reports a rate limit with the time to wait', async () => {
    const { store, deps, events } = setup([{ error: { status: 429, retryAfterSeconds: 120 } }]);

    await sparTurn(deps, P, 'I want a todo app');

    expect(ofType(events, 'spar.message')[0]?.data.text).toMatch(/rate limited.*2 minutes/i);
    expect(ofType(events, 'inbox.created')[0]?.data.kind).toBe('error');
    expectSnapshotMatchesReplay(store);
  });

  it('asks the owner to choose a model when none is configured, without running an agent', async () => {
    const { store, deps, events } = setup([], { models: {}, demo: false });

    await sparTurn(deps, P, 'I want a todo app');

    expect(ofType(events, 'agent.spawned')).toEqual([]);
    expect(ofType(events, 'spar.message')[0]?.data.text).toMatch(/Choose a model in Settings/);
    expect(ofType(events, 'inbox.created')[0]?.data.kind).toBe('error');
    expectSnapshotMatchesReplay(store);
  });

  it('writes the agent log under logsDir', async () => {
    const { deps, events } = setup([{ text: 'Thinking.' }, finish({ reply: 'Who will use it?' })]);

    await sparTurn(deps, P, 'I want a todo app');

    const agentId = ofType(events, 'agent.spawned')[0]?.entityId ?? '';
    const log = await readFile(path.join(logsDir, `${agentId}.ndjson`), 'utf8');
    expect(log).toContain('exited ok');
  });
});

describe('prompts/sparring.md', () => {
  it('asks one question at a time and names every PRD section', async () => {
    const template = await readFile(path.join(PROMPTS_DIR, 'sparring.md'), 'utf8');
    expect(template).toMatch(/one question at a time/i);
    for (const section of [
      'Problem',
      'Solution',
      'Users',
      'User Stories',
      'Implementation Decisions',
      'Testing Decisions',
      'Non-functional Requirements',
      'Out of Scope',
      'Open Questions',
    ]) {
      expect(template).toContain(`## ${section}`);
    }
    for (const v of ['idea', 'transcript', 'draft']) expect(template).toContain(`{{${v}}}`);
  });
});
