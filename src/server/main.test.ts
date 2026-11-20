import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateProductResponseSchema, StateResponseSchema } from '../shared/dto.ts';
import { parseEvent, type Event } from '../shared/events.ts';
import { AgentIdSchema, InboxIdSchema, ProductIdSchema } from '../shared/ids.ts';
import { parseConfig } from './config.ts';
import { EventEmitter } from 'node:events';
import { closeOnSignals, start, type Running } from './main.ts';

describe('start (composition root)', () => {
  let root: string | undefined;
  let running: Running | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('binds 127.0.0.1 by default, creates the data dir and DB, and serves /api/state', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const dataDir = join(root, 'data');
    const config = { ...parseConfig({ VIBECODE_DATA_DIR: dataDir }), port: 0 };
    expect(config.host).toBe('127.0.0.1');

    running = await start(config, join(root, 'no-web'));
    expect(running.address.host).toBe('127.0.0.1');
    expect(existsSync(join(dataDir, 'vibecode.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'empty'))).toBe(true);

    const res = await fetch(`http://127.0.0.1:${String(running.address.port)}/api/state`);
    expect(res.status).toBe(200);
    expect(StateResponseSchema.parse(await res.json()).lastSeq).toBe(0);
  });

  it('serves /api/settings and keeps a stored key masked across a restart', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const config = { ...parseConfig({ VIBECODE_DATA_DIR: join(root, 'data') }), port: 0 };
    const key = 'sk-ant-api03-boot-test-secret-5678';
    running = await start(config, join(root, 'no-web'));
    const url = () => `http://127.0.0.1:${String(running?.address.port)}/api/settings`;
    const put = await fetch(url(), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: { anthropic: key } }),
    });
    expect(put.status).toBe(200);
    await running.close();

    running = await start(config, join(root, 'no-web'));
    const text = await (await fetch(url())).text();
    expect(text).not.toContain(key);
    expect(JSON.parse(text)).toMatchObject({ keys: [{ provider: 'anthropic', last4: '5678' }] });
  });

  it('refuses remote bind without a password, and allows it once one is set', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const local = { ...parseConfig({ VIBECODE_DATA_DIR: join(root, 'data') }), port: 0 };
    const remote = { ...local, host: '0.0.0.0' };
    await expect(start(remote, join(root, 'no-web'))).rejects.toThrow(
      /VIBECODE_HOST=0\.0\.0\.0.*no password.*set-password/s,
    );

    running = await start(local, join(root, 'no-web'));
    const set = await fetch(
      `http://127.0.0.1:${String(running.address.port)}/api/settings/password`,
      json({ next: 'correct horse battery' }),
    );
    expect(set.status).toBe(200);
    await running.close();

    running = await start(remote, join(root, 'no-web'));
    const base = `http://127.0.0.1:${String(running.address.port)}`;
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect(await (await fetch(`${base}/api/session`)).json()).toEqual({
      passwordSet: true,
      authenticated: false,
    });
  });

  it('runs sparring turns: POST /spar yields the agent reply over SSE', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const config = {
      ...parseConfig({ VIBECODE_DATA_DIR: join(root, 'data'), VIBECODE_DEMO: '1' }),
      port: 0,
    };
    running = await start(config, join(root, 'no-web'), {
      fakeScript: [finish({ reply: 'Who will use it?' })],
    });
    const base = `http://127.0.0.1:${String(running.address.port)}`;
    const productId = await createProduct(base);

    const events = await fetch(`${base}/api/events?since=0`);
    const spar = await fetch(`${base}/api/products/${productId}/spar`, json({ message: 'Hi' }));
    expect(spar.status).toBe(202);

    const isReply = (e: Event) =>
      e.type === 'spar.message' && e.data.role === 'agent' && e.data.text === 'Who will use it?';
    const streamed = await readEvents(events, (es) => es.some(isReply));
    expect(streamed.find(isReply)).toMatchObject({ productId });
  });

  it('close() waits for a running sparring turn before closing the database', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const config = {
      ...parseConfig({ VIBECODE_DATA_DIR: join(root, 'data'), VIBECODE_DEMO: '1' }),
      port: 0,
    };
    let release = () => {};
    const gate = new Promise<void>((done) => (release = done));
    running = await start(config, join(root, 'no-web'), {
      fakeScript: [finish({ reply: 'Who will use it?' })],
      // Holds the real turn until close() has begun.
      wrapSparTurn: (run) => async (productId, message) => {
        await gate;
        await run(productId, message);
      },
    });
    const base = `http://127.0.0.1:${String(running.address.port)}`;
    const productId = await createProduct(base);
    const committed: Event[] = [];
    running.store.subscribe((e) => committed.push(e));

    const spar = await fetch(`${base}/api/products/${productId}/spar`, json({ message: 'Hi' }));
    expect(spar.status).toBe(202);
    const closing = running.close();
    running = undefined;
    await new Promise((done) => setTimeout(done, 50));
    release();
    await closing;

    expect(
      committed.flatMap((e) => (e.type === 'spar.message' ? [[e.data.role, e.data.text]] : [])),
    ).toEqual([
      ['owner', 'Hi'],
      ['agent', 'Who will use it?'],
    ]);
  });

  it('runs the inbox hook: a limiting event yields an inbox item in snapshot, SSE and mark-read', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const config = { ...parseConfig({ VIBECODE_DATA_DIR: join(root, 'data') }), port: 0 };
    running = await start(config, join(root, 'no-web'));
    const base = `http://127.0.0.1:${String(running.address.port)}`;

    const events = await fetch(`${base}/api/events?since=0`);
    const committed = running.store.commit(() => [
      {
        type: 'backend.limited',
        productId: null,
        entityId: null,
        v: 1,
        data: { backend: 'claude-code', until: null, needsLogin: false, reason: 'quota' },
      },
    ]);
    // The hook's inbox.created lands in the same commit as the triggering event.
    expect(committed.map((e) => e.type)).toEqual(['backend.limited', 'inbox.created']);

    const state = StateResponseSchema.parse(await (await fetch(`${base}/api/state`)).json());
    const items = Object.entries(state.state.inbox);
    expect(items).toHaveLength(1);
    const [rawId, item] = items[0] ?? [];
    const inboxId = InboxIdSchema.parse(rawId);
    expect(item).toMatchObject({
      kind: 'rate_limited',
      title: 'Claude Code rate limited',
      read: false,
    });

    const streamed = await readEvents(events, (es) => es.some((e) => e.type === 'inbox.created'));
    expect(streamed.find((e) => e.type === 'inbox.created')).toMatchObject({
      entityId: inboxId,
      data: { kind: 'rate_limited' },
    });

    const read = await fetch(`${base}/api/inbox/${inboxId}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(read.status).toBe(200);
    const after = StateResponseSchema.parse(await (await fetch(`${base}/api/state`)).json());
    expect(after.state.inbox[inboxId]?.read).toBe(true);
  });
  it('runs the orchestrator: a handed-off PRD is planned into issues (demo model, fake runtime)', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const config = {
      ...parseConfig({
        VIBECODE_DATA_DIR: join(root, 'data'),
        VIBECODE_DEMO: '1',
        VIBECODE_FAKE_DOCKER: '1',
      }),
      port: 0,
    };
    running = await start(config, join(root, 'no-web'), { fakeScript: [finish(PLAN)] });
    const base = `http://127.0.0.1:${String(running.address.port)}`;
    const productId = await createProduct(base);
    const events = await fetch(`${base}/api/events?since=0`);

    handOff(running, productId);

    const created = (es: Event[]) => es.filter((e) => e.type === 'issue.created');
    const streamed = await readEvents(events, (es) => created(es).length === 2, 10_000);
    expect(created(streamed).map((e) => [e.productId, e.data.issue.title])).toEqual([
      [productId, 'Scaffold'],
      [productId, 'List todos'],
    ]);
  });

  it('without fake Docker the orchestrator run fails with the actionable reason; the server stays up', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const config = {
      ...parseConfig({ VIBECODE_DATA_DIR: join(root, 'data'), VIBECODE_DEMO: '1' }),
      port: 0,
    };
    // One failure is enough for the orchestrator to tell the owner (and show the reason).
    running = await start(config, join(root, 'no-web'), {
      fakeScript: [finish(PLAN)],
      orchestratorBackoff: { maxFailures: 1 },
      dockerCommand: join(root, 'no-docker'),
    });
    const base = `http://127.0.0.1:${String(running.address.port)}`;
    const productId = await createProduct(base);
    const events = await fetch(`${base}/api/events?since=0`);

    handOff(running, productId);

    const isError = (e: Event) => e.type === 'inbox.created' && e.data.kind === 'error';
    const streamed = await readEvents(events, (es) => es.some(isError), 10_000);
    const error = streamed.find(isError);
    expect(error?.type === 'inbox.created' && error.data.body).toContain(
      'Docker is not running: start Docker Desktop or the docker service',
    );
    expect(streamed.some((e) => e.type === 'issue.created')).toBe(false);
    const state = await fetch(`${base}/api/state`);
    expect(state.status).toBe(200);
  });

  it('recovers at boot: an agent live in the previous process is exited with outcome restart', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const config = { ...parseConfig({ VIBECODE_DATA_DIR: join(root, 'data') }), port: 0 };
    running = await start(config, join(root, 'no-web'));
    const agentId = AgentIdSchema.parse('agent-left-running');
    const productId = ProductIdSchema.parse(
      await createProduct(`http://127.0.0.1:${String(running.address.port)}`),
    );
    running.store.commit(() => [
      {
        type: 'agent.spawned',
        productId,
        entityId: agentId,
        v: 1,
        data: {
          role: 'orchestrator',
          model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
          issueId: null,
          attemptId: null,
        },
      },
    ]);
    await running.close();

    // No fake Docker: container cleanup is skipped with a warning, the rest still runs.
    running = await start(config, join(root, 'no-web'));
    const exited = running.store
      .eventsSince(0)
      .filter((e) => e.type === 'agent.exited' && e.entityId === agentId);
    expect(exited.map((e) => e.data)).toEqual([{ outcome: 'restart' }]);
    expect(running.store.snapshot().state.agents[agentId]?.state).toBe('exited');
  });

  it.each([
    { name: 'is not restarted on the next tick while backing off', delaysMs: [60_000], runs: 1 },
    { name: 'is restarted on the next tick once the backoff has passed', delaysMs: [0], runs: 2 },
  ])('a failing orchestrator run $name', async ({ delaysMs, runs }) => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const config = {
      ...parseConfig({ VIBECODE_DATA_DIR: join(root, 'data'), VIBECODE_DEMO: '1' }),
      port: 0,
    };
    let started = 0;
    let finished = 0;
    running = await start(config, join(root, 'no-web'), {
      fakeScript: [finish(PLAN)],
      orchestratorBackoff: { delaysMs, maxFailures: 10 },
      dockerCommand: join(root, 'no-docker'),
      // Observes the real runs: they fail because Docker is not available.
      wrapRunOrchestrator: (run) => async (productId, triggers, handle) => {
        started += 1;
        try {
          await run(productId, triggers, handle);
        } finally {
          finished += 1;
        }
      },
    });
    const base = `http://127.0.0.1:${String(running.address.port)}`;
    const productId = await createProduct(base);

    handOff(running, productId);
    await waitFor(() => finished >= 1);
    // Any commit makes the scheduler tick.
    nudge(running);
    await new Promise((done) => setTimeout(done, 200));
    nudge(running);
    await new Promise((done) => setTimeout(done, 200));

    expect(Math.min(started, 2)).toBe(runs);
  });
});

describe('closeOnSignals (graceful shutdown)', () => {
  function fakeProcess() {
    const emitter = new EventEmitter();
    const exits: number[] = [];
    return {
      emitter,
      exits,
      proc: {
        once: (signal: 'SIGINT' | 'SIGTERM', fn: () => void) => emitter.once(signal, fn),
        exit: (code: number) => {
          exits.push(code);
        },
      },
    };
  }

  it.each(['SIGINT', 'SIGTERM'] as const)('on %s: closes once, then exits 0', async (signal) => {
    const { emitter, exits, proc } = fakeProcess();
    let closes = 0;
    closeOnSignals({ close: () => Promise.resolve(void (closes += 1)) }, proc, () => {});
    emitter.emit(signal);
    emitter.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
    await new Promise((done) => setTimeout(done, 0));
    expect(closes).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('exits 1 and logs when close fails', async () => {
    const { emitter, exits, proc } = fakeProcess();
    const logged: string[] = [];
    closeOnSignals({ close: () => Promise.reject(new Error('db busy')) }, proc, (line) =>
      logged.push(line),
    );
    emitter.emit('SIGTERM');
    await new Promise((done) => setTimeout(done, 0));
    expect(exits).toEqual([1]);
    expect(logged.join('\n')).toContain('db busy');
  });

  it('stops the scheduler: a real server closes on SIGTERM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    try {
      const config = { ...parseConfig({ VIBECODE_DATA_DIR: join(root, 'data') }), port: 0 };
      const running = await start(config, join(root, 'no-web'));
      const { emitter, exits, proc } = fakeProcess();
      closeOnSignals(running, proc, () => {});
      emitter.emit('SIGTERM');
      await waitFor(() => exits.length > 0);
      expect(exits).toEqual([0]);
      await expect(
        fetch(`http://127.0.0.1:${String(running.address.port)}/api/state`),
      ).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const PLAN = {
  issueOps: [
    { op: 'create', key: 'scaffold', title: 'Scaffold', body: 'Set up the app.', dependsOn: [] },
    {
      op: 'create',
      key: 'list',
      title: 'List todos',
      body: 'Show todos.',
      dependsOn: ['scaffold'],
    },
  ],
  questions: [],
  summary: 'Two slices: scaffold, list.',
};

/** Applies a PRD and hands the product off, so the scheduler starts planning it. */
function handOff(running: Running, productId: string): void {
  const product = ProductIdSchema.parse(productId);
  running.store.commit(() => [
    {
      type: 'prd.applied',
      productId: product,
      entityId: null,
      v: 1,
      data: { version: 1, markdown: '# Todo\n\nA todo app.', summary: null },
    },
    {
      type: 'product.handed_off',
      productId: product,
      entityId: null,
      v: 1,
      data: { prdVersion: 1 },
    },
  ]);
}

/** Commits an unrelated event: every commit makes the scheduler tick. */
function nudge(running: Running): void {
  running.store.commit(() => [
    {
      type: 'settings.changed',
      productId: null,
      entityId: null,
      v: 1,
      data: { sections: ['defaultModel'], keys: [] },
    },
  ]);
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((done) => setTimeout(done, 10));
  }
}

const finish = (input: object) => ({ toolCalls: [{ name: 'finish', input }] });
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function createProduct(base: string): Promise<string> {
  const res = await fetch(`${base}/api/products`, json({ name: 'Todo', idea: 'A todo app' }));
  expect(res.status).toBe(201);
  return CreateProductResponseSchema.parse(await res.json()).id;
}

/** Reads SSE `data:` lines from `res` until `done(events)` holds, then cancels the stream. */
async function readEvents(
  res: Response,
  done: (events: Event[]) => boolean,
  timeoutMs = 2000,
): Promise<Event[]> {
  if (res.body === null) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = '';
  const parse = () =>
    text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => parseEvent(JSON.parse(line.slice(5))))
      .filter((e): e is Event => e !== null);
  try {
    while (!done(parse())) {
      if (Date.now() > deadline) throw new Error(`timed out; stream so far:\n${text}`);
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`stream ended; stream so far:\n${text}`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return parse();
  } finally {
    await reader.cancel();
  }
}
