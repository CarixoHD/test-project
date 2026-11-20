import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IssueId } from '../../shared/ids.ts';
import { FakeContainerRuntime } from '../sandbox/index.ts';
import { type Store } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { P, setupAttempt, type HarnessOptions } from './attempt-testing.ts';

let dataDir: string;

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-attempt-')));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const setup = (o: HarnessOptions = {}) => setupAttempt(dataDir, o);

const attemptsOf = (store: Store, issueId: IssueId) => store.q.attemptsByIssue(issueId);

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
    await h.expectNoLeftovers();
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
    await h.expectNoLeftovers();
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
    await h.expectNoLeftovers();
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
    await h.expectNoLeftovers();
    expectSnapshotMatchesReplay(h.store);
  });
});
