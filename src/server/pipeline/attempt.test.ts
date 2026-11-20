import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventDraft, EventOf } from '../../shared/events.ts';
import { ProductIdSchema, type IssueId } from '../../shared/ids.ts';
import { addIssue } from '../commands/index.ts';
import { open } from '../db/index.ts';
import { createGit, type Git } from '../git/index.ts';
import type { FakeScript } from '../llm/index.ts';
import { FakeContainerRuntime, type SandboxSpec } from '../sandbox/index.ts';
import type { RunHandle } from '../scheduler/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore, type Store } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { exec } from '../util/exec.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { runAttempt, type AttemptDeps } from './index.ts';

const P = ProductIdSchema.parse('product-1');
const START = 1_700_000_000_000;
const PROJECT = { check: ['npm', 'test'], imageInputs: [] };

let dataDir: string;

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-attempt-')));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const draft = (type: string, entityId: string | null, data: object) =>
  ({ type, productId: P, entityId, v: 1, data }) as EventDraft;

async function rawGit(args: string[]): Promise<string> {
  const repo = path.join(dataDir, 'repos', `${P}.git`);
  const r = await exec('git', ['--git-dir', repo, ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

type SpecCall = { kind: 'open' | 'runOnce'; spec: SandboxSpec; argv?: readonly string[] };

type Harness = {
  store: Store;
  git: Git;
  runtime: FakeContainerRuntime;
  specs: SpecCall[];
  deps: AttemptDeps;
  addIssue(title: string): IssueId;
  run(issueId: IssueId): Promise<void>;
  mainLog(): Promise<string[]>;
};

/** Implementer writes `issue-<n>.txt`; reviewer approves. Chosen by the agent just spawned. */
function scriptFor(store: Store): FakeScript {
  const spawned = store
    .eventsSince(0)
    .filter((e): e is EventOf<'agent.spawned'> => e.type === 'agent.spawned')
    .at(-1);
  if (spawned === undefined) throw new Error('no agent spawned');
  if (spawned.data.role === 'reviewer') {
    return [{ toolCalls: [{ name: 'finish', input: { approve: true, findings: [] } }] }];
  }
  const issueId = spawned.data.issueId;
  const n = issueId === null ? 0 : (store.q.issue(issueId)?.number ?? 0);
  return [
    {
      toolCalls: [
        { name: 'write_file', input: { path: `issue-${n}.txt`, content: `work for #${n}\n` } },
      ],
    },
    { toolCalls: [{ name: 'finish', input: { summary: `Implemented #${n}` } }] },
  ];
}

async function setup(
  o: { project?: object | null; withMergeLock?: AttemptDeps['withMergeLock'] } = {},
): Promise<Harness> {
  const clock = new FakeClock(START);
  const ids = new FakeIdGen();
  const store = createStore({ db: open(':memory:'), clock, redactor: new Redactor() });
  const git = createGit({ dataDir });
  await git.initRepo(P);
  const project = o.project === undefined ? PROJECT : o.project;
  store.commit(() => [
    draft('product.created', null, {
      name: 'Todo',
      idea: 'todos',
      budgetUsd: null,
      maxParallel: 3,
      maxAttempts: 3,
      models: {},
      gitRemote: null,
    }),
    ...(project === null ? [] : [draft('product.settings_changed', null, { project })]),
  ]);
  const runtime = new FakeContainerRuntime({
    dataDir,
    script: [{ match: ['npm', 'test'], result: { code: 0, stdout: 'all 3 tests passed\n' } }],
  });
  const specs: SpecCall[] = [];
  const realOpen = runtime.open.bind(runtime);
  const realRunOnce = runtime.runOnce.bind(runtime);
  runtime.open = (spec) => {
    specs.push({ kind: 'open', spec });
    return realOpen(spec);
  };
  runtime.runOnce = (spec, argv, opts) => {
    specs.push({ kind: 'runOnce', spec, argv });
    return realRunOnce(spec, argv, opts);
  };
  const deps: AttemptDeps = {
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
      get fake() {
        return { script: scriptFor(store) };
      },
    },
    withMergeLock: o.withMergeLock ?? ((_p, fn) => fn()),
    demo: true,
  };
  return {
    store,
    git,
    runtime,
    specs,
    deps,
    addIssue(title) {
      const r = addIssue({ store, ids }, P, { title, body: `Build ${title}.`, dependsOn: [] });
      if (!r.ok) throw new Error(r.reason);
      return r.issueId;
    },
    run: (issueId) => runAttempt(deps, issueId, handle(ids)),
    mainLog: async () => (await rawGit(['log', '--format=%s', 'main'])).split('\n'),
  };
}

function handle(ids: FakeIdGen): RunHandle {
  return { runId: ids.next('run'), signal: new AbortController().signal, shouldStop: () => false };
}

const attemptsOf = (store: Store, issueId: IssueId) => store.q.attemptsByIssue(issueId);

async function expectNoLeftovers(): Promise<void> {
  const worktrees = path.join(dataDir, 'worktrees');
  expect(existsSync(worktrees) ? await readdir(worktrees) : []).toEqual([]);
  expect(await rawGit(['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe(
    'refs/heads/main',
  );
}

describe('runAttempt: happy path', () => {
  it('implements, checks, reviews and merges one commit "#1 <title>" to main', async () => {
    const h = await setup();
    const id = h.addIssue('Scaffold');
    const before = await h.mainLog();

    await h.run(id);

    const issue = h.store.q.issue(id);
    const mainSha = await h.git.mainSha(P);
    expect(issue).toMatchObject({ status: 'completed', mergedOrder: 1, mergeSha: mainSha });
    expect(await h.mainLog()).toEqual(['#1 Scaffold', ...before]);
    expect(await h.git.readFileAtMain(P, 'issue-1.txt')).toBe('work for #1\n');

    const [attempt] = attemptsOf(h.store, id);
    expect(attempt).toMatchObject({
      n: 1,
      status: 'merged',
      step: 'merge',
      counted: false,
      checkExit: 0,
      review: { approve: true, findings: [] },
    });
    expect(attempt?.headSha).toMatch(/^[0-9a-f]{40}$/);
    expectSnapshotMatchesReplay(h.store);
  });

  it('emits in_progress → in_review → completed and one step event per step', async () => {
    const h = await setup();
    const id = h.addIssue('Scaffold');
    await h.run(id);

    const events = h.store.eventsSince(0);
    const statuses = events
      .filter((e) => e.type === 'issue.status_changed' && e.entityId === id)
      .map((e) => (e.type === 'issue.status_changed' ? `${e.data.from}>${e.data.to}` : ''));
    expect(statuses).toEqual(['open>in_progress', 'in_progress>in_review']);
    const steps = events.flatMap((e) => (e.type === 'attempt.step' ? [e.data.step] : []));
    expect(steps).toEqual(['implement', 'check', 'review', 'merge']);
    const roles = events.flatMap((e) => (e.type === 'agent.spawned' ? [e.data.role] : []));
    expect(roles).toEqual(['implementer', 'reviewer']);
    const types = events.map((e) => e.type);
    expect(types.indexOf('issue.completed')).toBeLessThan(types.indexOf('attempt.ended'));
    expect(events.at(-1)?.type).toBe('attempt.ended');
  });

  it('runs checks with network none and the reviewer on a read-only mount', async () => {
    const h = await setup();
    await h.run(h.addIssue('Scaffold'));

    const opens = h.specs.filter((c) => c.kind === 'open').map((c) => c.spec);
    expect(opens.map((s) => [s.role, s.network, s.readOnly])).toEqual([
      ['agent', 'egress', false],
      ['agent', 'none', true],
    ]);
    const checks = h.specs.filter((c) => c.kind === 'runOnce');
    expect(checks.map((c) => [c.spec.role, c.spec.network, c.argv])).toEqual([
      ['check', 'none', ['npm', 'test']],
    ]);
    // every container was closed again
    const opened = h.runtime.calls.filter((c) => c.kind === 'open').length;
    const closed = h.runtime.calls.filter((c) => c.kind === 'close').length;
    expect(closed).toBe(opened);
  });

  it('saves the diff and check log as artifacts', async () => {
    const h = await setup();
    const id = h.addIssue('Scaffold');
    await h.run(id);

    const [attempt] = attemptsOf(h.store, id);
    const dir = path.join(dataDir, 'artifacts', attempt?.id ?? 'missing');
    const diff = await readFile(path.join(dir, 'diff.patch'), 'utf8');
    expect(diff).toContain('+++ b/issue-1.txt');
    expect(diff).toContain('+work for #1');
    expect(await readFile(path.join(dir, 'check.log'), 'utf8')).toContain('all 3 tests passed');
  });

  it('removes the worktrees and branches afterwards', async () => {
    const h = await setup();
    await h.run(h.addIssue('Scaffold'));
    await expectNoLeftovers();
  });
});

describe('runAttempt: two attempts from the same base', () => {
  it('both merge; the second via merge-tree with a re-check on the integration worktree', async () => {
    let releaseBarrier: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let lock: Promise<unknown> = Promise.resolve();
    const h = await setup({
      withMergeLock: (_p, fn) => {
        const next = lock.then(async () => {
          await bothStarted;
          return fn();
        });
        lock = next.catch(() => {});
        return next;
      },
    });
    const base = await h.git.mainSha(P);
    const one = h.addIssue('One');
    const two = h.addIssue('Two');
    const unsubscribe = h.store.subscribe(() => {
      const started = h.store.eventsSince(0).filter((e) => e.type === 'attempt.started');
      if (started.length === 2) releaseBarrier();
    });

    await Promise.all([h.run(one), h.run(two)]);
    unsubscribe();

    const started = h.store
      .eventsSince(0)
      .flatMap((e) => (e.type === 'attempt.started' ? [e.data.baseSha] : []));
    expect(started).toEqual([base, base]);
    expect(h.store.q.issue(one)).toMatchObject({ status: 'completed' });
    expect(h.store.q.issue(two)).toMatchObject({ status: 'completed' });
    const orders = [h.store.q.issue(one)?.mergedOrder, h.store.q.issue(two)?.mergedOrder];
    expect(orders.sort()).toEqual([1, 2]);

    const log = await h.mainLog();
    expect(log).toHaveLength(3);
    expect(log.slice(0, 2).sort()).toEqual(['#1 One', '#2 Two']);
    expect(await h.git.readFileAtMain(P, 'issue-1.txt')).toBe('work for #1\n');
    expect(await h.git.readFileAtMain(P, 'issue-2.txt')).toBe('work for #2\n');

    const checks = h.specs.filter((c) => c.kind === 'runOnce');
    expect(checks).toHaveLength(3);
    const recheck = checks[2]?.spec;
    expect(recheck?.network).toBe('none');
    expect(path.basename(recheck?.worktree ?? '')).toMatch(/^integrate-/);
    await expectNoLeftovers();
    expectSnapshotMatchesReplay(h.store);
  });
});

describe('runAttempt: errors', () => {
  it('without a check command ends the attempt as error and reopens the issue', async () => {
    const h = await setup({ project: null });
    const id = h.addIssue('Scaffold');
    const before = await h.mainLog();

    await h.run(id);

    const [attempt] = attemptsOf(h.store, id);
    expect(attempt).toMatchObject({
      status: 'error',
      counted: false,
      feedback: 'No check command configured (.vibecode/project.json)',
    });
    expect(h.store.q.issue(id)?.status).toBe('open');
    expect(await h.mainLog()).toEqual(before);
    await expectNoLeftovers();
    expectSnapshotMatchesReplay(h.store);
  });

  it('a failing check ends the attempt as error without touching main', async () => {
    const h = await setup();
    h.deps.runtime = new FakeContainerRuntime({
      dataDir,
      script: [{ match: ['npm', 'test'], result: { code: 1, stdout: '1 test failed\n' } }],
    });
    const id = h.addIssue('Scaffold');
    const before = await h.mainLog();

    await h.run(id);

    const [attempt] = attemptsOf(h.store, id);
    expect(attempt).toMatchObject({ status: 'error', checkExit: 1 });
    expect(attempt?.feedback).toContain('1 test failed');
    expect(h.store.q.issue(id)?.status).toBe('open');
    expect(await h.mainLog()).toEqual(before);
    await expectNoLeftovers();
    expectSnapshotMatchesReplay(h.store);
  });
});
