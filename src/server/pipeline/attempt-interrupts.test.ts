import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event, EventDraft } from '../../shared/events.ts';
import type { IssueId } from '../../shared/ids.ts';
import { cancelIssue, editIssue, pauseProduct, resumeProduct } from '../commands/index.ts';
import type { FakeScript } from '../llm/index.ts';
import { createScheduler, type RunHandle } from '../scheduler/index.ts';
import type { Store } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import {
  P,
  runHandle,
  setupAttempt,
  START,
  type Harness,
  type HarnessOptions,
} from './attempt-testing.ts';
import {
  backendLimitDrafts,
  LIMIT_DEDUPE_TOLERANCE_MS,
  type BackendLimitDraft,
} from './attempt-events.ts';

// Attempt interruptions (ARCHITECTURE §6 flows 4.7, 5 and 7; ADR 7): pause, stop, rate limits,
// logins and owner edits interrupt an attempt without counting it; an owner cancel discards it.
// In every case main is unchanged, attempt_count is unchanged and the worktree is removed.

let dataDir: string;

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-attempt-int-')));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const setup = (o: HarnessOptions = {}) => setupAttempt(dataDir, o);

const rateLimited = (retryAfterSeconds: number): FakeScript => [
  { error: { status: 429, retryAfterSeconds } },
];

const eventsOf = <T extends Event['type']>(store: Store, type: T) =>
  store.eventsSince(0).filter((e): e is Extract<Event, { type: T }> => e.type === type);

const inboxItems = (store: Store) => Object.values(store.snapshot().state.inbox);

const implementerCalls = (h: Harness, issueId: IssueId) =>
  h.modelCalls.filter((c) => c.role === 'implementer' && c.issueId === issueId);

/** Runs `fn` once, right after the first committed event that matches. */
function onFirst(store: Store, match: (e: Event) => boolean, fn: () => void): () => void {
  let done = false;
  const unsubscribe = store.subscribe((e) => {
    if (done || !match(e)) return;
    done = true;
    fn();
  });
  return unsubscribe;
}

const isImplementerUsage = (e: Event) =>
  e.type === 'usage.recorded' && e.data.role === 'implementer';

/** Pause, rate limit, … end the attempt like this: uncounted, main unchanged, nothing left over. */
async function expectUncounted(h: Harness, id: IssueId, mainBefore: string) {
  expect(h.store.q.issue(id)).toMatchObject({ attemptCount: 0, failureReason: null });
  expect(await h.rawGit(['rev-parse', 'main'])).toBe(mainBefore);
  await h.expectNoLeftovers();
  expectSnapshotMatchesReplay(h.store);
}

describe('runAttempt: rate limits and logins', () => {
  it('a rate limit interrupts the attempt (not counted) and records backend.limited{until}', async () => {
    const h = await setup({
      inbox: true,
      script: (a) => (a.role === 'implementer' ? rateLimited(120) : undefined),
    });
    const id = h.addIssue('Scaffold');
    const main = await h.rawGit(['rev-parse', 'main']);

    await h.run(id);

    const until = START + 120_000;
    const [attempt] = h.store.q.attemptsByIssue(id);
    expect(attempt).toMatchObject({
      status: 'interrupted',
      interruptReason: 'rate_limited',
      counted: false,
    });
    expect(h.store.q.issue(id)).toMatchObject({ status: 'open', runAfter: until });
    expect(eventsOf(h.store, 'backend.limited').map((e) => e.data)).toEqual([
      expect.objectContaining({ backend: 'fake', until, needsLogin: false }),
    ]);
    expect(h.store.q.backendLimit('fake')).toMatchObject({ until, needsLogin: false });
    expect(eventsOf(h.store, 'agent.state').map((e) => e.data)).toEqual([
      { state: 'rate_limited', until },
    ]);
    // Through the real inbox hook: exactly one item, the backend.limited one, and no error.
    expect(inboxItems(h.store).map((i) => i.kind)).toEqual(['rate_limited']);
    await expectUncounted(h, id, main);
  });

  it('two parallel attempts hitting the same limit commit one backend.limited and one inbox item', async () => {
    const h = await setup({
      inbox: true,
      script: (a) => (a.role === 'implementer' ? rateLimited(60) : undefined),
    });
    const one = h.addIssue('One');
    const two = h.addIssue('Two');

    await Promise.all([h.run(one), h.run(two)]);

    for (const id of [one, two]) {
      expect(h.store.q.attemptsByIssue(id)[0]).toMatchObject({
        status: 'interrupted',
        interruptReason: 'rate_limited',
        counted: false,
      });
      expect(h.store.q.issue(id)).toMatchObject({ status: 'open', attemptCount: 0 });
    }
    expect(eventsOf(h.store, 'backend.limited')).toHaveLength(1);
    expect(inboxItems(h.store).map((i) => i.kind)).toEqual(['rate_limited']);
    expectSnapshotMatchesReplay(h.store);
  });

  it('a changed limit (later until) is committed again', async () => {
    let retry = 60;
    const h = await setup({
      script: (a) => (a.role === 'implementer' ? rateLimited(retry) : undefined),
    });
    const id = h.addIssue('Scaffold');

    await h.run(id);
    retry = 300;
    await h.run(id);

    expect(eventsOf(h.store, 'backend.limited').map((e) => e.data.until)).toEqual([
      START + 60_000,
      START + 300_000,
    ]);
  });

  it('the same 429 hit a few ms apart (until differs by ms) commits one event and one inbox item', async () => {
    const h = await setup({
      inbox: true,
      script: (a) => (a.role === 'implementer' ? rateLimited(60) : undefined),
    });
    const one = h.addIssue('One');
    const two = h.addIssue('Two');

    await h.run(one);
    h.clock.advance(7);
    await h.run(two);

    expect(eventsOf(h.store, 'backend.limited').map((e) => e.data.until)).toEqual([START + 60_000]);
    expect(inboxItems(h.store).map((i) => i.kind)).toEqual(['rate_limited']);
    expect(h.store.q.backendLimit('fake')).toMatchObject({ until: START + 60_000 });
    expectSnapshotMatchesReplay(h.store);
  });

  it('a later hit with an earlier until does not shorten the active limit', async () => {
    let retry = 300;
    const h = await setup({
      script: (a) => (a.role === 'implementer' ? rateLimited(retry) : undefined),
    });
    const id = h.addIssue('Scaffold');

    await h.run(id);
    h.clock.advance(1_000);
    retry = 30;
    await h.run(id);

    expect(eventsOf(h.store, 'backend.limited')).toHaveLength(1);
    expect(h.store.q.backendLimit('fake')).toMatchObject({ until: START + 300_000 });
  });

  it('a hit whose until is beyond the tolerance extends the limit with one new event', async () => {
    const h = await setup({
      script: (a) => (a.role === 'implementer' ? rateLimited(60) : undefined),
    });
    const id = h.addIssue('Scaffold');

    await h.run(id);
    h.clock.advance(LIMIT_DEDUPE_TOLERANCE_MS + 1);
    await h.run(id);

    const extended = START + LIMIT_DEDUPE_TOLERANCE_MS + 1 + 60_000;
    expect(eventsOf(h.store, 'backend.limited').map((e) => e.data.until)).toEqual([
      START + 60_000,
      extended,
    ]);
    expect(h.store.q.backendLimit('fake')).toMatchObject({ until: extended });
  });

  it('after the limit has cleared, a new hit records backend.limited again', async () => {
    const h = await setup({
      inbox: true,
      script: (a) => (a.role === 'implementer' ? rateLimited(60) : undefined),
    });
    const id = h.addIssue('Scaffold');

    await h.run(id);
    h.clock.advance(1_000);
    h.store.commit(() => [
      { type: 'backend.cleared', productId: null, entityId: null, v: 1, data: { backend: 'fake' } },
    ]);
    await h.run(id);

    expect(eventsOf(h.store, 'backend.limited').map((e) => e.data.until)).toEqual([
      START + 60_000,
      START + 61_000,
    ]);
    expect(h.store.q.backendLimit('fake')).toMatchObject({ until: START + 61_000 });
    expectSnapshotMatchesReplay(h.store);
  });

  it('needs-login transitions are always recorded; a repeated needs-login is not', async () => {
    const h = await setup();
    const record = (limit: BackendLimitDraft) =>
      h.store.commit((tx) => backendLimitDrafts(tx, limit));
    const rate = { backend: 'fake', until: START + 600_000, needsLogin: false, reason: 'r' };
    const login = { backend: 'fake', until: null, needsLogin: true, reason: 'l' };

    record(rate);
    record(login);
    record(login);
    record(rate);

    expect(eventsOf(h.store, 'backend.limited').map((e) => e.data.needsLogin)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('auth_required interrupts (not counted) and records backend.limited{needsLogin}', async () => {
    const claude = { provider: 'claude-code', model: 'sonnet' } as const;
    const h = await setup({
      inbox: true,
      models: { implementer: claude, reviewer: claude },
      runtimeScript: () => [
        {
          match: (argv) => argv[0] === 'env' && argv.includes('claude'),
          result: { code: 1, stdout: '', stderr: 'Login expired. Please run /login.' },
        },
      ],
    });
    const id = h.addIssue('Scaffold');
    const main = await h.rawGit(['rev-parse', 'main']);

    await h.run(id);

    expect(h.store.q.attemptsByIssue(id)[0]).toMatchObject({
      status: 'interrupted',
      interruptReason: 'auth_required',
      counted: false,
    });
    expect(h.store.q.issue(id)?.status).toBe('open');
    expect(eventsOf(h.store, 'backend.limited').map((e) => e.data)).toEqual([
      expect.objectContaining({ backend: 'claude-code', until: null, needsLogin: true }),
    ]);
    expect(inboxItems(h.store).map((i) => i.kind)).toEqual(['auth_required']);
    await expectUncounted(h, id, main);
  });
});

describe('runAttempt: pause and stop', () => {
  it('shouldStop mid-attempt interrupts after the current step, not counted', async () => {
    const h = await setup({ inbox: true });
    const id = h.addIssue('Scaffold');
    const main = await h.rawGit(['rev-parse', 'main']);
    let stop = false;
    const off = onFirst(h.store, isImplementerUsage, () => {
      stop = true;
    });
    const handle: RunHandle = { ...runHandle(h.ids), shouldStop: () => stop };

    await h.run(id, handle);
    off();

    // The implementer's first step ran; no second model call, no check, no reviewer.
    expect(h.modelCalls.map((c) => c.role)).toEqual(['implementer']);
    expect(h.specs.filter((s) => s.kind === 'runOnce')).toEqual([]);
    expect(h.store.q.attemptsByIssue(id)[0]).toMatchObject({
      status: 'interrupted',
      interruptReason: 'shutdown',
      counted: false,
    });
    expect(h.store.q.issue(id)?.status).toBe('open');
    expect(inboxItems(h.store)).toEqual([]);
    await expectUncounted(h, id, main);
  });

  it('pausing the product through the scheduler interrupts the attempt; resume picks it up again', async () => {
    const h = await setup({ inbox: true });
    const id = h.addIssue('Scaffold');
    const main = await h.rawGit(['rev-parse', 'main']);
    h.store.commit(
      () =>
        [
          {
            type: 'product.phase_changed',
            productId: P,
            entityId: null,
            v: 1,
            data: { phase: 'building' },
          },
        ] as EventDraft[],
    );
    const runs: Promise<void>[] = [];
    const scheduler = createScheduler({
      store: h.store,
      clock: h.clock,
      ids: h.ids,
      timer: { setInterval: () => null, clearInterval: () => {} },
      runners: {
        runOrchestrator: async () => {},
        runAttempt: (issueId, run) => {
          const p = h.run(issueId, run);
          runs.push(p);
          return p;
        },
      },
    });
    const commands = { store: h.store, ids: h.ids };
    const off = onFirst(h.store, isImplementerUsage, () => {
      expect(pauseProduct(commands, P).ok).toBe(true);
    });

    scheduler.start();
    await Promise.all(runs);
    off();

    expect(runs).toHaveLength(1);
    expect(implementerCalls(h, id)).toHaveLength(1);
    expect(h.store.q.attemptsByIssue(id)[0]).toMatchObject({
      status: 'interrupted',
      interruptReason: 'paused',
      counted: false,
    });
    expect(h.store.q.issue(id)?.status).toBe('open');
    // No 'hit an error' inbox item for a pause.
    expect(inboxItems(h.store).filter((i) => i.kind === 'error')).toEqual([]);
    await expectUncounted(h, id, main);

    expect(resumeProduct(commands, P).ok).toBe(true);
    await Promise.all(runs);
    await scheduler.stop();

    expect(runs).toHaveLength(2);
    expect(h.store.q.issue(id)).toMatchObject({ status: 'completed', attemptCount: 0 });
    expect(h.store.q.attemptsByIssue(id).map((a) => a.status)).toEqual(['interrupted', 'merged']);
    await h.expectNoLeftovers();
  });

  it('scheduler.stop() (shutdown) interrupts the attempt as shutdown, not counted', async () => {
    const h = await setup();
    const id = h.addIssue('Scaffold');
    const main = await h.rawGit(['rev-parse', 'main']);
    h.store.commit(
      () =>
        [
          {
            type: 'product.phase_changed',
            productId: P,
            entityId: null,
            v: 1,
            data: { phase: 'building' },
          },
        ] as EventDraft[],
    );
    let stopped: Promise<void> | undefined;
    const scheduler = createScheduler({
      store: h.store,
      clock: h.clock,
      ids: h.ids,
      timer: { setInterval: () => null, clearInterval: () => {} },
      runners: {
        runOrchestrator: async () => {},
        runAttempt: (issueId, run) => h.run(issueId, run),
      },
    });
    const off = onFirst(h.store, isImplementerUsage, () => {
      stopped = scheduler.stop();
    });

    scheduler.start();
    await new Promise<void>((resolve) => {
      const wait = h.store.subscribe((e) => {
        if (e.type === 'attempt.ended') {
          wait();
          resolve();
        }
      });
    });
    await stopped;
    off();

    expect(h.store.q.attemptsByIssue(id)[0]).toMatchObject({
      status: 'interrupted',
      interruptReason: 'shutdown',
      counted: false,
    });
    expect(h.store.q.issue(id)?.status).toBe('open');
    await expectUncounted(h, id, main);
  });
});

describe('runAttempt: owner cancel', () => {
  it('cancelling mid-attempt stops after the current agent step and discards the attempt', async () => {
    const h = await setup({ inbox: true });
    const id = h.addIssue('Scaffold');
    const main = await h.rawGit(['rev-parse', 'main']);
    const off = onFirst(h.store, isImplementerUsage, () => {
      expect(cancelIssue({ store: h.store, ids: h.ids }, id).ok).toBe(true);
    });

    await h.run(id);
    off();

    // shouldStop sees the cancel: no further model calls after the step in progress.
    expect(h.modelCalls).toHaveLength(1);
    expect(h.store.q.attemptsByIssue(id)[0]).toMatchObject({
      status: 'discarded',
      counted: false,
      interruptReason: null,
    });
    expect(h.store.q.issue(id)).toMatchObject({ status: 'cancelled', attemptCount: 0 });
    expect(await h.rawGit(['rev-parse', 'main'])).toBe(main);
    expect(inboxItems(h.store)).toEqual([]);
    await h.expectNoLeftovers();
    expectSnapshotMatchesReplay(h.store);
  });

  it('an issue cancelled before the merge is discarded under the merge lock; main unchanged', async () => {
    harness = await setup({
      withMergeLock: (_p, fn) => {
        expect(cancelIssue({ store: harness.store, ids: harness.ids }, issueId).ok).toBe(true);
        return fn();
      },
    });
    const h = harness;
    const issueId = h.addIssue('Scaffold');
    const main = await h.rawGit(['rev-parse', 'main']);

    await h.run(issueId);

    expect(h.store.q.attemptsByIssue(issueId)[0]).toMatchObject({
      status: 'discarded',
      counted: false,
    });
    expect(h.store.q.issue(issueId)).toMatchObject({ status: 'cancelled', attemptCount: 0 });
    expect(await h.rawGit(['rev-parse', 'main'])).toBe(main);
    expect(await h.git.readFileAtMain(P, 'issue-1.txt')).toBeNull();
    await h.expectNoLeftovers();
    expectSnapshotMatchesReplay(h.store);
  });
});

// Tests whose merge lock needs the harness.
let harness: Harness;

describe('runAttempt: owner edit during the attempt', () => {
  const editDuringMerge = (edit: { title?: string; body?: string; priority?: number }) =>
    setup({
      withMergeLock: (_p, fn) => {
        const issue = harness.store.q.issue(harness.store.q.issuesByProduct(P)[0]?.id as IssueId);
        if (issue === null) throw new Error('no issue');
        const r = editIssue({ store: harness.store, ids: harness.ids }, issue.id, {
          ...edit,
          rev: issue.rev,
        });
        expect(r.ok).toBe(true);
        return fn();
      },
    });

  it('an edited issue is interrupted{issue_changed}, not merged, and stays open with the new content', async () => {
    harness = await editDuringMerge({ body: 'Build Scaffold, but smaller.' });
    const h = harness;
    const id = h.addIssue('Scaffold');
    const main = await h.rawGit(['rev-parse', 'main']);

    await h.run(id);

    expect(h.store.q.attemptsByIssue(id)[0]).toMatchObject({
      status: 'interrupted',
      interruptReason: 'issue_changed',
      counted: false,
    });
    expect(h.store.q.issue(id)).toMatchObject({
      status: 'open',
      attemptCount: 0,
      body: 'Build Scaffold, but smaller.',
      rev: 2,
    });
    await expectUncounted(h, id, main);

    // The next attempt works on the new content and merges.
    await h.run(id);
    expect(implementerCalls(h, id).at(-1)?.prompt).toContain('Build Scaffold, but smaller.');
    expect(h.store.q.issue(id)?.status).toBe('completed');
  });

  it('a priority-only edit does not interrupt the attempt', async () => {
    harness = await editDuringMerge({ priority: 2 });
    const h = harness;
    const id = h.addIssue('Scaffold');

    await h.run(id);

    expect(h.store.q.issue(id)).toMatchObject({ status: 'completed', priority: 2 });
    expect(await h.git.readFileAtMain(P, 'issue-1.txt')).toBe('work for #1\n');
  });

  it('an edit that lands while the worktree is added is what the agent works on; it merges', async () => {
    const h = await setup();
    const id = h.addIssue('Scaffold');
    const realAdd = h.git.addWorktree.bind(h.git);
    h.git.addWorktree = async (...args) => {
      const issue = h.store.q.issue(id);
      if (issue === null) throw new Error('no issue');
      const r = editIssue({ store: h.store, ids: h.ids }, id, {
        body: 'Build Scaffold v2.',
        rev: issue.rev,
      });
      expect(r.ok).toBe(true);
      return realAdd(...args);
    };

    await h.run(id);

    expect(implementerCalls(h, id)[0]?.prompt).toContain('Build Scaffold v2.');
    expect(h.store.q.attemptsByIssue(id)[0]).toMatchObject({ status: 'merged', issueRev: 2 });
    expect(h.store.q.issue(id)?.status).toBe('completed');
  });
});

describe('runAttempt: aborted checks are interruptions, not errors', () => {
  it('a stopped run whose check is aborted ends interrupted (shutdown) with no error inbox item', async () => {
    const abort = new AbortController();
    const h = await setup({ inbox: true, check: () => ({ code: 1, stdout: 'never seen\n' }) });
    const id = h.addIssue('Scaffold');
    const off = onFirst(
      h.store,
      (e) => e.type === 'attempt.step' && e.data.step === 'check',
      () => {
        abort.abort();
      },
    );

    await h.run(id, { runId: h.ids.next('run'), signal: abort.signal, shouldStop: () => false });
    off();

    expect(h.store.q.attemptsByIssue(id)[0]).toMatchObject({
      status: 'interrupted',
      interruptReason: 'shutdown',
      counted: false,
    });
    expect(h.store.q.issue(id)).toMatchObject({ status: 'open', attemptCount: 0 });
    expect(inboxItems(h.store)).toEqual([]);
  });
});
