import { existsSync } from 'node:fs';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

let dataDir: string;
const dbs: Db[] = [];
beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-restart-')));
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
        return { script: script(lastSpawnedRole(store)) };
      },
    },
    withMergeLock: (_p, fn) => fn(),
    demo: true,
  });
  return { db, store, ids, git, deps };
}

function lastSpawnedRole(store: Store): string {
  const spawned = store.eventsSince(0).filter((e) => e.type === 'agent.spawned');
  const last = spawned.at(-1);
  return last?.type === 'agent.spawned' ? last.data.role : 'none';
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

const draft = (productId: ProductId, type: string, data: object) =>
  ({ type, productId, entityId: null, v: 1, data }) as EventDraft;

describe('restart recovery (integration)', () => {
  it('a crash mid-attempt is recovered and the issue then completes on the new process', async () => {
    const clock = new FakeClock(START);
    const runtime = new FakeContainerRuntime({
      dataDir,
      script: [{ match: ['npm', 'test'], result: { code: 0, stdout: 'ok\n' } }],
    });

    // ---- process 1: a product in building, one issue, an attempt that never finishes ----
    const p1 = boot(runtime, clock);
    const productId = p1.ids.next('product');
    await p1.git.initRepo(productId);
    p1.store.commit(() => [
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
    const added = addIssue({ store: p1.store, ids: p1.ids }, productId, {
      title: 'Feature',
      body: 'Build it.',
      dependsOn: [],
    });
    if (!added.ok) throw new Error(added.reason);
    const issueId: IssueId = added.issueId;
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
