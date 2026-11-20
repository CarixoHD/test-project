import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventDraft } from '../../shared/events.ts';
import {
  AgentIdSchema,
  AttemptIdSchema,
  ProductIdSchema,
  type IssueId,
  type ProductId,
} from '../../shared/ids.ts';
import { addIssue } from '../commands/index.ts';
import { open, type Db } from '../db/index.ts';
import { createGit, type Git } from '../git/index.ts';
import {
  DOCKER_NOT_RUNNING,
  FakeContainerRuntime,
  type ContainerRuntime,
  type SandboxSpec,
} from '../sandbox/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore, type Store } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { exec } from '../util/exec.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { ACTIVITY_RETENTION_MS, recover, type RecoverDeps } from './index.ts';

// recover() against a real git data dir, FakeContainerRuntime and an in-memory store.

const P = ProductIdSchema.parse('01JC0000000000000000000001');
const ORPHAN = '01JC00000000000000000000ZZ';
const AT = AttemptIdSchema.parse('attempt-1');
const AG_LIVE = AgentIdSchema.parse('agent-live');
const AG_DONE = AgentIdSchema.parse('agent-done');
const SHA = 'a'.repeat(40);
const START = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-4-5' } as const;

let dataDir: string;
beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-recover-')));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const on = (type: string, entityId: string | null, data: object, productId: ProductId = P) =>
  ({ type, productId, entityId, v: 1, data }) as EventDraft;

type Setup = {
  db: Db;
  store: Store;
  git: Git;
  clock: FakeClock;
  runtime: FakeContainerRuntime;
  logs: string[];
  deps: RecoverDeps;
  issueIds: IssueId[];
};

async function setup(): Promise<Setup> {
  const db = open(':memory:');
  const clock = new FakeClock(START);
  const ids = new FakeIdGen();
  const store = createStore({ db, clock, redactor: new Redactor() });
  const git = createGit({ dataDir });
  await git.initRepo(P);
  store.commit(() => [
    on('product.created', null, {
      name: 'Todo',
      idea: 'todos',
      budgetUsd: null,
      maxParallel: 3,
      maxAttempts: 3,
      models: {},
      gitRemote: null,
    }),
  ]);
  const issueIds = ['One', 'Two', 'Three'].map((title) => {
    const r = addIssue({ store, ids }, P, { title, body: 'Do it.', dependsOn: [] });
    if (!r.ok) throw new Error(r.reason);
    return r.issueId;
  });
  const runtime = new FakeContainerRuntime({ dataDir });
  const logs: string[] = [];
  const deps: RecoverDeps = { store, db, git, runtime, clock, log: (l) => logs.push(l) };
  return { db, store, git, clock, runtime, logs, deps, issueIds };
}

/** Issue 1 in_progress with a running attempt and a live agent, issue 2 in_review, a preview. */
function crashState(s: Setup): void {
  const [one, two] = s.issueIds as [IssueId, IssueId, IssueId];
  const moved = (id: IssueId, from: string, to: string) =>
    on('issue.status_changed', id, { from, to, attemptCount: 0, runAfter: 0 });
  s.store.commit(() => [
    moved(one, 'open', 'in_progress'),
    on('attempt.started', AT, { issueId: one, n: 1, issueRev: 1, baseSha: SHA, branch: 'b' }),
    on('agent.spawned', AG_DONE, {
      role: 'implementer',
      model: MODEL,
      issueId: one,
      attemptId: AT,
    }),
    on('agent.exited', AG_DONE, { outcome: 'ok' }),
    on('agent.spawned', AG_LIVE, { role: 'reviewer', model: MODEL, issueId: one, attemptId: AT }),
    on('agent.state', AG_LIVE, { state: 'rate_limited', until: START + 1000 }),
    moved(two, 'open', 'in_progress'),
    moved(two, 'in_progress', 'in_review'),
    on('preview.started', null, { url: 'http://127.0.0.1:41000/', container: 'vibecode-pv' }),
  ]);
}

const spec = (runId: string, productId: string = P): SandboxSpec => ({
  runId,
  productId,
  role: 'agent',
  image: 'vibecode/base',
  worktree: path.join(dataDir, 'worktrees', runId),
  readOnly: false,
  network: 'egress',
});

/** `runtime` with some methods replaced (a stand-in for a broken or missing Docker). */
function stubRuntime(
  runtime: ContainerRuntime,
  overrides: Partial<ContainerRuntime>,
): ContainerRuntime {
  return {
    available: () => runtime.available(),
    ensureImage: (p) => runtime.ensureImage(p),
    open: (sp) => runtime.open(sp),
    runOnce: (sp, argv, o) => runtime.runOnce(sp, argv, o),
    runDetached: (sp, argv) => runtime.runDetached(sp, argv),
    publishedPort: (name, port) => runtime.publishedPort(name, port),
    listManaged: () => runtime.listManaged(),
    remove: (name) => runtime.remove(name),
    ...overrides,
  };
}

async function rawGit(productId: string, args: string[]): Promise<string> {
  const repo = path.join(dataDir, 'repos', `${productId}.git`);
  const r = await exec('git', ['--git-dir', repo, ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe('recover: store reconciliation', () => {
  it('leaves no running attempt, no in_progress/in_review issue and no live agent', async () => {
    const s = await setup();
    crashState(s);

    await recover(s.deps);

    const { state } = s.store.snapshot();
    expect(Object.values(state.attempts).filter((a) => a.status === 'running')).toEqual([]);
    expect(Object.values(state.issues).map((i) => i.status)).toEqual(['open', 'open', 'open']);
    expect(Object.values(state.agents).map((a) => a.state)).toEqual(['exited', 'exited']);
    expect(state.previews).toEqual({});
    expectSnapshotMatchesReplay(s.store);
  });

  it('records attempt.ended{interrupted, restart}, uncounted, and agent.exited{restart}', async () => {
    const s = await setup();
    crashState(s);
    const before = s.store.snapshot().lastSeq;

    await recover(s.deps);

    const events = s.store.eventsSince(before);
    const ended = events.filter((e) => e.type === 'attempt.ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      entityId: AT,
      data: { status: 'interrupted', interruptReason: 'restart', counted: false },
    });
    const exited = events.filter((e) => e.type === 'agent.exited');
    expect(exited.map((e) => [e.entityId, e.data])).toEqual([[AG_LIVE, { outcome: 'restart' }]]);
    expect(events.filter((e) => e.type === 'preview.stopped').map((e) => e.productId)).toEqual([P]);
    expect(s.store.q.attempt(AT)).toMatchObject({ status: 'interrupted', counted: false });
  });

  it('does not count interrupted attempts: attemptCount stays unchanged', async () => {
    const s = await setup();
    crashState(s);
    const counts = () => s.issueIds.map((id) => s.store.q.issue(id)?.attemptCount);
    const before = counts();

    await recover(s.deps);

    expect(counts()).toEqual(before);
    expect(s.store.q.attemptsByIssue(s.issueIds[0] as IssueId)).toHaveLength(1);
  });

  it('commits nothing when there is nothing to reconcile', async () => {
    const s = await setup();
    const before = s.store.snapshot().lastSeq;
    await recover(s.deps);
    expect(s.store.eventsSince(before)).toEqual([]);
  });
});

describe('recover: containers', () => {
  it('removes every managed container', async () => {
    const s = await setup();
    await s.runtime.open(spec('run-a'));
    await s.runtime.open(spec('run-b'));

    await recover(s.deps);

    expect(await s.runtime.listManaged()).toEqual([]);
    const removed = s.runtime.calls.flatMap((c) => (c.kind === 'remove' ? [c.name] : []));
    expect(removed.sort()).toEqual(['vibecode-run-a', 'vibecode-run-b']);
  });

  it('skips container cleanup with a warning when Docker is unavailable, and reconciles the rest', async () => {
    const s = await setup();
    crashState(s);
    await s.git.addWorktree(P, 'run-x');
    const unavailable = stubRuntime(s.runtime, {
      listManaged: () => Promise.reject(new Error(DOCKER_NOT_RUNNING)),
      remove: () => Promise.reject(new Error('remove must not be called')),
    });

    await recover({ ...s.deps, runtime: unavailable });

    expect(s.logs.some((l) => l.includes(DOCKER_NOT_RUNNING))).toBe(true);
    expect(await readdir(path.join(dataDir, 'worktrees'))).toEqual([]);
    const { state } = s.store.snapshot();
    expect(Object.values(state.issues).map((i) => i.status)).toEqual(['open', 'open', 'open']);
    expect(Object.values(state.agents).every((a) => a.state === 'exited')).toBe(true);
  });

  it('surfaces any other listManaged() failure', async () => {
    const s = await setup();
    const broken = stubRuntime(s.runtime, {
      listManaged: () => Promise.reject(new Error('docker: permission denied')),
    });
    await expect(recover({ ...s.deps, runtime: broken })).rejects.toThrow('permission denied');
  });
});

describe('recover: worktrees and repos (real git)', () => {
  it('removes every worktree, its vibecode/* branch and stale admin entries', async () => {
    const s = await setup();
    await s.git.addWorktree(P, 'run-a');
    const gone = await s.git.addWorktree(P, 'run-b');
    // A worktree whose directory vanished: only a stale admin entry is left in the repo.
    await rm(gone.dir, { recursive: true, force: true });
    // A half-created directory that git never registered.
    await mkdir(path.join(dataDir, 'worktrees', 'run-c'), { recursive: true });
    await writeFile(path.join(dataDir, 'worktrees', 'run-c', 'junk.txt'), 'x');

    await recover(s.deps);

    expect(await readdir(path.join(dataDir, 'worktrees'))).toEqual([]);
    const list = await rawGit(P, ['worktree', 'list', '--porcelain']);
    expect(list.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
    expect(await rawGit(P, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe(
      'refs/heads/main',
    );
  });

  it('removes a leftover detached integrate-<sha> worktree', async () => {
    const s = await setup();
    const base = await s.git.mainSha(P);
    // Two branches from the same base: integrating the second after the first gives `merged`.
    const a = await s.git.addWorktree(P, 'run-a');
    await writeFile(path.join(a.dir, 'a.txt'), 'a\n');
    await s.git.commitAll(a.dir, 'a');
    const b = await s.git.addWorktree(P, 'run-b');
    await writeFile(path.join(b.dir, 'b.txt'), 'b\n');
    await s.git.commitAll(b.dir, 'b');
    const first = await s.git.integrate(P, 'vibecode/run-a', base, '#1 a');
    if (first.kind !== 'fast') throw new Error(`expected fast, got ${first.kind}`);
    await s.git.advanceMain(P, first.commitSha, base);
    const second = await s.git.integrate(P, 'vibecode/run-b', base, '#2 b');
    if (second.kind !== 'merged') throw new Error(`expected merged, got ${second.kind}`);
    expect(path.basename(second.dir)).toBe(`integrate-${second.commitSha}`);
    // Crash here: the caller never removes the integration worktree.

    await recover(s.deps);

    expect(existsSync(second.dir)).toBe(false);
    const list = await rawGit(P, ['worktree', 'list']);
    expect(list.split('\n')).toHaveLength(1);
    expect(list).toContain(path.join(dataDir, 'repos', `${P}.git`));
  });

  it('removes orphan product repos only: ULID-shaped, `.git`, and no such product', async () => {
    const s = await setup();
    await s.git.initRepo(ProductIdSchema.parse(ORPHAN));
    const repos = path.join(dataDir, 'repos');
    // Not product-id shaped, or not a `.git` dir: never touched.
    await s.git.initRepo(ProductIdSchema.parse('my-repo'));
    await mkdir(path.join(repos, '01JC0000000000000000000002'));
    await writeFile(path.join(repos, '01JC0000000000000000000003.git'), 'a file, not a repo');
    await writeFile(path.join(repos, 'notes.txt'), 'owner notes');

    await recover(s.deps);

    expect((await readdir(repos)).sort()).toEqual(
      [
        `${P}.git`,
        'my-repo.git',
        '01JC0000000000000000000002',
        '01JC0000000000000000000003.git',
        'notes.txt',
      ].sort(),
    );
    expect(await s.git.mainSha(P)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('copes with a data dir that has no worktrees or repos yet', async () => {
    const s = await setup();
    await rm(path.join(dataDir, 'repos'), { recursive: true, force: true });
    await expect(recover(s.deps)).resolves.toBeDefined();
  });
});

describe('recover: activity pruning', () => {
  const activity = (agent: string, line: string) => on('agent.activity', agent, { lines: [line] });

  it('prunes agent.activity older than 7 days but keeps each agent’s latest, so snapshot ≡ replay', async () => {
    const s = await setup();
    s.store.commit(() => [
      on('agent.spawned', AG_DONE, {
        role: 'implementer',
        model: MODEL,
        issueId: null,
        attemptId: null,
      }),
      on('agent.spawned', AG_LIVE, {
        role: 'reviewer',
        model: MODEL,
        issueId: null,
        attemptId: null,
      }),
    ]);
    s.store.commit(() => [activity(AG_DONE, 'old 1'), activity(AG_LIVE, 'old only')]);
    s.store.commit(() => [activity(AG_DONE, 'old 2')]);
    s.store.commit(() => [on('agent.exited', AG_DONE, { outcome: 'ok' })]);
    s.clock.advance(ACTIVITY_RETENTION_MS - DAY);
    s.store.commit(() => [activity(AG_DONE, 'recent')]);
    s.clock.advance(2 * DAY);
    s.store.commit(() => [activity(AG_DONE, 'newest')]);

    await recover(s.deps);

    const lines = s.store
      .eventsSince(0)
      .flatMap((e) => (e.type === 'agent.activity' ? e.data.lines : []));
    // 'old 1' and 'old 2' are pruned; 'old only' stays: it is AG_LIVE's last line.
    expect(lines).toEqual(['old only', 'recent', 'newest']);
    expect(s.store.snapshot().state.agents[AG_LIVE]?.lastActivity).toBe('old only');
    expect(s.store.snapshot().state.agents[AG_DONE]?.lastActivity).toBe('newest');
    expectSnapshotMatchesReplay(s.store);
  });
});
