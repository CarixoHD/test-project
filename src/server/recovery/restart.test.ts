import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Event, EventDraft } from '../../shared/events.ts';
import type { IssueId, ProductId } from '../../shared/ids.ts';
import { addIssue } from '../commands/index.ts';
import { open, type Db } from '../db/index.ts';
import { createGit } from '../git/index.ts';
import type { FakeScript } from '../llm/index.ts';
import { runAttempt, type AttemptDeps } from '../pipeline/index.ts';
import { FakeContainerRuntime } from '../sandbox/index.ts';
import { createScheduler, type RunHandle } from '../scheduler/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore, type Store } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { exec } from '../util/exec.ts';
import { createIdGen } from '../util/id-gen.ts';
import { recover } from './index.ts';

// Restart flow (ARCHITECTURE §6 flow 10): a process dies mid-attempt; a new process opens the
// same data dir, recovers, and its scheduler finishes the issue. The FakeContainerRuntime
// instance plays the Docker daemon, which outlives the crashed process.

const START = 1_700_000_000_000;
const PROJECT = { check: ['npm', 'test'], imageInputs: [] };
const IMPLEMENT: FakeScript = [
  { toolCalls: [{ name: 'write_file', input: { path: 'feature.txt', content: 'done\n' } }] },
  { toolCalls: [{ name: 'finish', input: { summary: 'Implemented' } }] },
];
const APPROVE: FakeScript = [
  { toolCalls: [{ name: 'finish', input: { approve: true, findings: [] } }] },
];
const HANG: FakeScript = [{ hang: true }];

const draft = (product: ProductId, type: string, data: object) =>
  ({ type, productId: product, entityId: null, v: 1, data }) as EventDraft;

let dataDir: string;
const dbs: Db[] = [];

// The "given" of every test: a migrated DB with a product in building (one open issue) and its
// initialised repo. Built once and copied per test, so no test pays for the migrations, the
// first-use warm-up of the store, or the git spawns of initRepo (measured: ~0.5 s of a ~1.2 s run).
let templateDir: string;
let productId: ProductId;
let issueId: IssueId;
beforeAll(async () => {
  templateDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-restart-template-')));
  const clock = new FakeClock(START);
  const db = open(path.join(templateDir, 'vibecode.db'));
  try {
    const store = createStore({ db, clock, redactor: new Redactor() });
    const ids = createIdGen(clock);
    productId = ids.next('product');
    await createGit({ dataDir: templateDir }).initRepo(productId);
    store.commit(() => [
      draft(productId, 'product.created', {
        name: 'Todo',
        idea: 'todos',
        budgetUsd: null,
        maxParallel: 1,
        maxAttempts: 2,
        models: {},
        gitRemote: null,
      }),
      draft(productId, 'product.settings_changed', { project: PROJECT }),
      draft(productId, 'prd.applied', { version: 1, markdown: '# v1', summary: null }),
      draft(productId, 'product.handed_off', { prdVersion: 1 }),
    ]);
    const added = addIssue({ store, ids }, productId, {
      title: 'Feature',
      body: 'Build it.',
      dependsOn: [],
    });
    if (!added.ok) throw new Error(added.reason);
    issueId = added.issueId;
  } finally {
    // Closing checkpoints the WAL, so the copied DB file is complete on its own.
    db.$client.close();
  }
});
afterAll(async () => {
  await rm(templateDir, { recursive: true, force: true });
});
beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-restart-')));
  await cp(templateDir, dataDir, { recursive: true });
});
afterEach(async () => {
  for (const db of dbs.splice(0)) db.$client.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** One server process: its own DB connection, store, ids and git on the shared data dir. */
function boot(runtime: FakeContainerRuntime, clock: FakeClock) {
  const db = open(path.join(dataDir, 'vibecode.db'));
  dbs.push(db);
  const store = createStore({ db, clock, redactor: new Redactor() });
  const ids = createIdGen(clock);
  const git = createGit({ dataDir });
  // Role of the latest agent this process spawned, tracked from the bus (no event-log re-reads).
  let lastSpawnedRole = 'none';
  store.subscribe((e) => {
    if (e.type === 'agent.spawned') lastSpawnedRole = e.data.role;
  });
  const deps = (script: (role: string) => FakeScript): AttemptDeps => ({
    store,
    ids,
    clock,
    redactor: new Redactor(),
    logsDir: path.join(dataDir, 'logs'),
    artifactsDir: path.join(dataDir, 'artifacts'),
    setTimer: () => () => {},
    git,
    runtime,
    modelDeps: {
      getSecret: () => undefined,
      // Read when an agent's model is created, right after its agent.spawned.
      get fake() {
        return { script: script(lastSpawnedRole) };
      },
    },
    withMergeLock: (_p, fn) => fn(),
    demo: true,
  });
  return { db, store, ids, git, deps };
}

/** Resolves with the first committed event that matches. */
function waitFor(store: Store, match: (e: Event) => boolean): Promise<Event> {
  return new Promise((resolve) => {
    const off = store.subscribe((e) => {
      if (!match(e)) return;
      off();
      resolve(e);
    });
  });
}

describe('restart recovery (integration)', () => {
  it('a crash mid-attempt is recovered and the issue then completes on the new process', async () => {
    // Later than the template's events, so time and ULIDs keep increasing across the boots.
    const clock = new FakeClock(START + 1_000);
    const runtime = new FakeContainerRuntime({
      dataDir,
      script: [{ match: ['npm', 'test'], result: { code: 0, stdout: 'ok\n' } }],
    });

    // ---- process 1: the template's product and issue, an attempt that never finishes ----
    const p1 = boot(runtime, clock);
    expect(p1.store.q.issue(issueId)?.status).toBe('open');
    const implementing = waitFor(p1.store, (e) => e.type === 'agent.spawned');
    const handle: RunHandle = {
      runId: p1.ids.next('run'),
      signal: new AbortController().signal,
      shouldStop: () => false,
    };
    // Abandoned: the implementer's model call hangs forever, as if the process had died.
    void runAttempt(
      p1.deps(() => HANG),
      issueId,
      handle,
    );
    await implementing;
    expect(p1.store.q.issue(issueId)?.status).toBe('in_progress');
    expect(await runtime.listManaged()).toHaveLength(1);
    expect(await readdir(path.join(dataDir, 'worktrees'))).toHaveLength(1);

    // ---- process 2: same data dir, recover before the scheduler starts ----
    clock.advance(60_000);
    const p2 = boot(runtime, clock);
    await recover({ store: p2.store, db: p2.db, git: p2.git, runtime, clock, log: () => {} });

    expect(await runtime.listManaged()).toEqual([]);
    expect(await readdir(path.join(dataDir, 'worktrees'))).toEqual([]);
    const afterRecover = p2.store.snapshot().state;
    expect(afterRecover.issues[issueId]).toMatchObject({ status: 'open', attemptCount: 0 });
    expect(Object.values(afterRecover.attempts).map((a) => [a.status, a.counted])).toEqual([
      ['interrupted', false],
    ]);
    expect(Object.values(afterRecover.agents).map((a) => a.state)).toEqual(['exited']);

    const completed = waitFor(
      p2.store,
      (e) => e.type === 'attempt.ended' && e.data.status === 'merged',
    );
    const scheduler = createScheduler({
      store: p2.store,
      clock,
      ids: p2.ids,
      timer: { setInterval: () => 0, clearInterval: () => {} },
      // The product has no per-role models, so the default check (a full snapshot per call) is
      // always false; skipping it keeps the per-event ticks cheap.
      isBackendBlocked: () => false,
      orchestratorNotBefore: () => Number.POSITIVE_INFINITY,
      runners: {
        runOrchestrator: () => Promise.resolve(),
        runAttempt: (id, run) =>
          runAttempt(
            p2.deps((role) => (role === 'reviewer' ? APPROVE : IMPLEMENT)),
            id,
            run,
          ),
      },
    });
    scheduler.start();
    await completed;
    await scheduler.stop();

    const issue = p2.store.q.issue(issueId);
    expect(issue).toMatchObject({ status: 'completed', attemptCount: 0 });
    const attempts = p2.store.q.attemptsByIssue(issueId);
    expect(attempts.map((a) => [a.n, a.status, a.counted])).toEqual([
      [1, 'interrupted', false],
      [2, 'merged', false],
    ]);
    expect(await p2.git.readFileAtMain(productId, 'feature.txt')).toBe('done\n');
    // No orphan containers, worktrees or branches are left behind.
    expect(await runtime.listManaged()).toEqual([]);
    const worktrees = path.join(dataDir, 'worktrees');
    expect(existsSync(worktrees) ? await readdir(worktrees) : []).toEqual([]);
    const repo = path.join(dataDir, 'repos', `${productId}.git`);
    const branches = await exec(
      'git',
      ['--git-dir', repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/'],
      { timeoutMs: 30_000 },
    );
    expect(branches.stdout.trim()).toBe('refs/heads/main');
    expectSnapshotMatchesReplay(p2.store);
  });
});
