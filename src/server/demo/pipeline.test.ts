import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateProductResponseSchema } from '../../shared/dto.ts';
import type { Event } from '../../shared/events.ts';
import { ProductIdSchema, type ProductId } from '../../shared/ids.ts';
import { parseConfig } from '../config.ts';
import { start, type Running } from '../main.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { exec } from '../util/exec.ts';
import { DEMO_QUESTIONS } from './index.ts';

// The whole product flow in demo mode (ARCHITECTURE §7 server integration): default demo scripts
// for every role, FakeContainerRuntime, real git, driven through the HTTP app of a started server.

let root: string | undefined;
let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function startDemo(): Promise<Running> {
  root = mkdtempSync(path.join(tmpdir(), 'vibecode-demo-'));
  const config = {
    ...parseConfig({
      VIBECODE_DATA_DIR: path.join(root, 'data'),
      VIBECODE_DEMO: '1',
      VIBECODE_FAKE_DOCKER: '1',
    }),
    port: 0,
  };
  running = await start(config, path.join(root, 'no-web'), {
    clock: new FakeClock(),
    schedulerTickMs: 20,
  });
  return running;
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function waitFor(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

const agentReplies = (r: Running, id: ProductId) =>
  r.store.q.sparMessages(id).filter((m) => m.role === 'agent');

async function spar(r: Running, id: ProductId, message: string): Promise<string> {
  const before = agentReplies(r, id).length;
  const res = await r.app.request(`/api/products/${id}/spar`, post({ message }));
  expect(res.status).toBe(202);
  await waitFor(() => agentReplies(r, id).length > before, 'the sparring reply');
  return agentReplies(r, id).at(-1)?.text ?? '';
}

async function mainLog(dataDir: string, id: ProductId): Promise<string[]> {
  const repo = path.join(dataDir, 'repos', `${id}.git`);
  const r = await exec('git', ['--git-dir', repo, 'log', '--format=%s', 'main'], {
    timeoutMs: 30_000,
  });
  if (r.code !== 0) throw new Error(`git log failed: ${r.stderr}`);
  return r.stdout.trim().split('\n').reverse();
}

describe('demo mode: create → spar → handoff → plan → build → merge', () => {
  it('ends with 3 completed issues merged to main in dependency order', async () => {
    const r = await startDemo();

    const created = await r.app.request(
      '/api/products',
      post({ name: 'Todo', idea: 'A todo app for busy people' }),
    );
    expect(created.status).toBe(201);
    const id = ProductIdSchema.parse(CreateProductResponseSchema.parse(await created.json()).id);

    // Sparring with no explicit script: two questions, then a PRD draft.
    expect(await spar(r, id, 'I want a todo app')).toBe(DEMO_QUESTIONS[0]);
    expect(await spar(r, id, 'Busy people')).toBe(DEMO_QUESTIONS[1]);
    const third = await spar(r, id, 'Adding todos fast');
    expect(third).not.toContain('crashed');
    const draft = r.store.q.prdDraft(id)?.markdown ?? '';
    expect(draft).toContain('# Todo');
    expect(draft).toContain('A todo app for busy people');

    const handoff = await r.app.request(`/api/products/${id}/handoff`, post());
    expect(handoff.status).toBe(200);

    const issues = () => Object.values(r.store.snapshot().state.issues);
    await waitFor(
      () => issues().length === 3 && issues().every((i) => i.status === 'completed'),
      '3 completed issues',
    );

    const byNumber = issues().sort((a, b) => a.number - b.number);
    expect(byNumber.map((i) => [i.number, i.title])).toEqual([
      [1, 'Scaffold'],
      [2, 'Core feature'],
      [3, 'Polish'],
    ]);
    expect(r.store.q.product(id)?.project?.check).toEqual(['test', '-f', 'docs/PRD.md']);

    // Dependency order: every attempt starts only after the issue it depends on was completed.
    const events = r.store.eventsSince(0);
    const seqOf = (pred: (e: Event) => boolean) => events.find(pred)?.seq ?? Infinity;
    for (const issue of byNumber) {
      const started = seqOf((e) => e.type === 'attempt.started' && e.data.issueId === issue.id);
      expect(started).toBeLessThan(Infinity);
      for (const dep of issue.dependsOn) {
        const depCompleted = seqOf((e) => e.type === 'issue.completed' && e.entityId === dep);
        expect(depCompleted).toBeLessThan(started);
      }
    }
    expect(byNumber[1]?.dependsOn).toEqual([byNumber[0]?.id]);
    expect(byNumber[2]?.dependsOn).toEqual([byNumber[1]?.id]);
    const merged = events.flatMap((e) => (e.type === 'issue.completed' ? [e.entityId] : []));
    expect(merged).toEqual(byNumber.map((i) => i.id));

    // main: one commit per issue, in merge order, after the PRD and the plan.
    const log = await mainLog(path.join(root ?? '', 'data'), id);
    expect(log.filter((s) => /^#\d+ /.test(s))).toEqual([
      '#1 Scaffold',
      '#2 Core feature',
      '#3 Polish',
    ]);

    expectSnapshotMatchesReplay(r.store);
  }, 60_000);

  it('an owner issue added before handoff waits for the check command, then merges without an error', async () => {
    const r = await startDemo();
    const created = await r.app.request('/api/products', post({ name: 'Todo', idea: 'todos' }));
    const id = ProductIdSchema.parse(CreateProductResponseSchema.parse(await created.json()).id);
    await spar(r, id, 'a');
    await spar(r, id, 'b');
    await spar(r, id, 'c');
    const added = await r.app.request(
      `/api/products/${id}/issues`,
      post({ title: 'x', body: 'y' }),
    );
    expect(added.status).toBe(200);
    expect((await r.app.request(`/api/products/${id}/handoff`, post())).status).toBe(200);

    // The clock is frozen: an error retry (runAfter = now + 60 s) would never come due.
    const issues = () => Object.values(r.store.snapshot().state.issues);
    await waitFor(
      () => issues().length === 4 && issues().every((i) => i.status === 'completed'),
      '4 completed issues',
    );
    const events = r.store.eventsSince(0);
    const projectSet = events.findIndex(
      (e) => e.type === 'product.settings_changed' && e.data.project !== undefined,
    );
    const firstStart = events.findIndex((e) => e.type === 'attempt.started');
    expect(projectSet).toBeGreaterThanOrEqual(0);
    expect(firstStart).toBeGreaterThan(projectSet);
    expect(events.filter((e) => e.type === 'attempt.ended' && e.data.status === 'error')).toEqual(
      [],
    );
    expect(events.filter((e) => e.type === 'inbox.created' && e.data.kind === 'error')).toEqual([]);
  }, 60_000);

  it('attempts use the settings saved after start (keys and provider config, no restart)', async () => {
    // A local OpenAI-compatible endpoint that records requests and refuses them.
    const seen: IncomingHttpHeaders[] = [];
    const provider = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stub provider' } }));
    });
    await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
    try {
      const address = provider.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      const r = await startDemo();
      const key = 'sk-local-implementer-0042';
      const put = await r.app.request('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerConfig: {
            openaiCompatible: { baseURL: `http://127.0.0.1:${String(address.port)}/v1` },
          },
          keys: { 'openai-compatible': key },
          roleDefaults: { implementer: { provider: 'openai-compatible', model: 'local' } },
        }),
      });
      expect(put.status).toBe(200);

      const created = await r.app.request('/api/products', post({ name: 'Todo', idea: 'todos' }));
      const id = ProductIdSchema.parse(CreateProductResponseSchema.parse(await created.json()).id);
      await spar(r, id, 'a');
      await spar(r, id, 'b');
      await spar(r, id, 'c');
      expect((await r.app.request(`/api/products/${id}/handoff`, post())).status).toBe(200);

      await waitFor(() => seen.length > 0, 'the implementer calling the local provider');
      expect(seen[0]?.authorization).toBe(`Bearer ${key}`);
    } finally {
      await running?.close();
      running = undefined;
      await new Promise((done) => provider.close(done));
    }
  }, 60_000);
});
