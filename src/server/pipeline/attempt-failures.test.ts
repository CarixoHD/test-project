import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanResult } from '../../shared/agent-results.ts';
import type { IssueId } from '../../shared/ids.ts';
import { pendingTriggers } from '../../shared/triggers.ts';
import type { FakeScript } from '../llm/index.ts';
import type { Store } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import {
  P,
  runHandle,
  setupAttempt,
  type Harness,
  type HarnessOptions,
  type SpawnedAgent,
} from './attempt-testing.ts';
import { createOrchestrator } from './index.ts';
import { editIssue } from '../commands/index.ts';

// Counted attempt failures (ARCHITECTURE §6 flow 4 step 9, ADR 7): check_failed, rejected,
// conflict, empty diff and agent error each count against maxAttempts, store their feedback and
// hand it to the next attempt; exhausted issues fail and trigger an orchestrator rewrite.

let dataDir: string;

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-attempt-fail-')));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const setup = (o: HarnessOptions = {}) => setupAttempt(dataDir, o);

const finish = (input: object): FakeScript[number] => ({
  toolCalls: [{ name: 'finish', input }],
});
const reject = (findings: string[]): FakeScript => [finish({ approve: false, findings })];
const writeAndFinish = (file: string, content: string): FakeScript => [
  { toolCalls: [{ name: 'write_file', input: { path: file, content } }] },
  finish({ summary: 'done' }),
];

const attemptsOf = (store: Store, issueId: IssueId) => store.q.attemptsByIssue(issueId);
const failingCheck = (stdout: string) => () => ({ code: 1, stdout });
const PASSING = { code: 0, stdout: 'ok\n' };
const implementerPrompts = (h: Harness, issueId: IssueId) =>
  h.modelCalls.filter((c) => c.role === 'implementer' && c.issueId === issueId);

// model calls are recorded as JSON, so the newlines appear escaped
const NO_FEEDBACK = JSON.stringify('## Feedback from the previous attempt\n\n(none)').slice(1, -1);

const manyLines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n');

type Kind = {
  name: string;
  status: 'check_failed' | 'rejected' | 'conflict' | 'error';
  feedback: string;
  options: () => HarnessOptions;
};

const KINDS: Kind[] = [
  {
    name: 'check_failed',
    status: 'check_failed',
    feedback: 'expected 3 todos, got 4',
    options: () => ({ check: failingCheck('FAIL todo.test.ts\nexpected 3 todos, got 4\n') }),
  },
  {
    name: 'rejected',
    status: 'rejected',
    feedback: 'Missing a test for deleting a todo',
    options: () => ({
      script: (a) =>
        a.role === 'reviewer' ? reject(['Missing a test for deleting a todo']) : undefined,
    }),
  },
  {
    name: 'conflict',
    status: 'conflict',
    feedback: 'issue-1.txt',
    options: () => ({
      // main moves under the attempt with a conflicting version of the same file
      withMergeLock: async (productId, fn) => {
        await harness.git.commitFilesOnMain(productId, { 'issue-1.txt': 'theirs\n' }, 'other');
        return fn();
      },
    }),
  },
  {
    name: 'empty diff',
    status: 'error',
    feedback: 'no changes',
    options: () => ({
      script: (a) =>
        a.role === 'implementer' ? [finish({ summary: 'nothing to do' })] : undefined,
    }),
  },
  {
    name: 'agent error',
    status: 'error',
    feedback: 'agent error',
    options: () => ({
      script: (a) => (a.role === 'implementer' ? [{ error: { status: 401 } }] : undefined),
    }),
  },
];

// The conflict kind needs the harness inside its merge lock.
let harness: Harness;

describe('runAttempt: counted failures', () => {
  it.each(KINDS)(
    '$name: attempt.ended{$status, counted}, feedback stored, attemptCount 1, issue open',
    async (kind) => {
      harness = await setup(kind.options());
      const h = harness;
      const id = h.addIssue('Scaffold');

      await h.run(id);

      const [attempt] = attemptsOf(h.store, id);
      expect(attempt).toMatchObject({ status: kind.status, counted: true });
      expect(attempt?.feedback).toContain(kind.feedback);
      expect(h.store.q.issue(id)).toMatchObject({ status: 'open', attemptCount: 1 });
      expect(await h.mainLog()).not.toContain('#1 Scaffold');
      await h.expectNoLeftovers();
      expectSnapshotMatchesReplay(h.store);
    },
  );

  it('check_failed keeps only the last 200 lines of the check output as feedback', async () => {
    const h = await setup({ check: failingCheck(`${manyLines}\n`) });
    const id = h.addIssue('Scaffold');

    await h.run(id);

    const [attempt] = attemptsOf(h.store, id);
    expect(attempt).toMatchObject({ status: 'check_failed', checkExit: 1 });
    const feedback = attempt?.feedback ?? '';
    expect(feedback).toContain('line 250');
    expect(feedback).toContain('line 51\n');
    expect(feedback).not.toContain('line 50\n');
  });

  it('rejected stores the review with the findings', async () => {
    const h = await setup({
      script: (a) => (a.role === 'reviewer' ? reject(['No tests', 'Wrong file']) : undefined),
    });
    const id = h.addIssue('Scaffold');

    await h.run(id);

    const [attempt] = attemptsOf(h.store, id);
    expect(attempt?.review).toEqual({ approve: false, findings: ['No tests', 'Wrong file'] });
    expect(attempt?.feedback).toContain('No tests');
    expect(attempt?.feedback).toContain('Wrong file');
  });

  it('a check failing on the merge with main is check_failed too', async () => {
    let merging = false;
    harness = await setup({
      check: () =>
        merging ? { code: 1, stdout: 'broken after merge\n' } : { code: 0, stdout: '' },
      withMergeLock: async (productId, fn) => {
        await harness.git.commitFilesOnMain(productId, { 'other.txt': 'x\n' }, 'other');
        merging = true;
        return fn();
      },
    });
    const id = harness.addIssue('Scaffold');

    await harness.run(id);

    const [attempt] = attemptsOf(harness.store, id);
    expect(attempt).toMatchObject({ status: 'check_failed', counted: true });
    expect(attempt?.feedback).toContain('broken after merge');
    expect(harness.store.q.issue(id)).toMatchObject({ status: 'open', attemptCount: 1 });
    await harness.expectNoLeftovers();
  });

  it.each([
    ['the check', false],
    ['the re-check on the merge with main', true],
  ])('aborting %s (stop, restart) is not counted', async (_name, onMerge) => {
    const abort = new AbortController();
    harness = await setup(
      onMerge
        ? {
            // the first check passes and fires the signal; the re-check then sees it aborted
            check: () => {
              abort.abort();
              return { code: 0, stdout: '' };
            },
            withMergeLock: async (productId, fn) => {
              await harness.git.commitFilesOnMain(productId, { 'other.txt': 'x\n' }, 'other');
              return fn();
            },
          }
        : { check: () => ({ code: 1, stdout: 'never seen\n' }) },
    );
    const h = harness;
    const id = h.addIssue('Scaffold');
    const unsubscribe = h.store.subscribe(() => {
      const step = h.store.eventsSince(0).findLast((e) => e.type === 'attempt.step');
      if (!onMerge && step?.type === 'attempt.step' && step.data.step === 'check') abort.abort();
    });

    await h.run(id, { runId: h.ids.next('run'), signal: abort.signal, shouldStop: () => false });
    unsubscribe();

    const [attempt] = attemptsOf(h.store, id);
    // An interruption (ADR 7), never an error: no error inbox item for a stop or restart.
    expect(attempt).toMatchObject({
      status: 'interrupted',
      interruptReason: 'shutdown',
      counted: false,
      step: onMerge ? 'merge' : 'check',
    });
    expect(attempt?.feedback).toContain('aborted');
    expect(h.store.q.issue(id)).toMatchObject({ status: 'open', attemptCount: 0 });
    await h.expectNoLeftovers();
    expectSnapshotMatchesReplay(h.store);
  });

  it('a missing check command stays an uncounted error', async () => {
    const h = await setup({ project: null });
    const id = h.addIssue('Scaffold');

    await h.run(id);

    expect(attemptsOf(h.store, id)[0]).toMatchObject({ status: 'error', counted: false });
    expect(h.store.q.issue(id)).toMatchObject({ status: 'open', attemptCount: 0 });
  });
});

describe('runAttempt: feedback reaches the next attempt', () => {
  it("the second implementer's model input contains the first attempt's check output", async () => {
    const h = await setup({
      check: (n) =>
        n === 0
          ? { code: 1, stdout: 'AssertionError: expected 3 todos, got 4\n' }
          : { code: 0, stdout: 'ok\n' },
    });
    const id = h.addIssue('Scaffold');

    await h.run(id);
    await h.run(id);

    const attempts = attemptsOf(h.store, id);
    expect(attempts.map((a) => a.status)).toEqual(['check_failed', 'merged']);
    // the first call is attempt 1's, the last attempt 2's
    const prompts = implementerPrompts(h, id);
    const [first] = prompts;
    const last = prompts.at(-1);
    expect(first?.prompt).not.toContain('expected 3 todos, got 4');
    expect(last?.prompt).toContain('AssertionError: expected 3 todos, got 4');
    expect(h.store.q.issue(id)).toMatchObject({ status: 'completed', attemptCount: 1 });
    expectSnapshotMatchesReplay(h.store);
  });

  it("the reviewer's findings reach the next implementer", async () => {
    let reviews = 0;
    const h = await setup({
      script: (a) => {
        if (a.role !== 'reviewer') return undefined;
        reviews += 1;
        return reviews === 1 ? reject(['Handle the empty list']) : undefined;
      },
    });
    const id = h.addIssue('Scaffold');

    await h.run(id);
    await h.run(id);

    const prompts = implementerPrompts(h, id);
    expect(prompts[0]?.prompt).not.toContain('Handle the empty list');
    expect(prompts.at(-1)?.prompt).toContain('Handle the empty list');
    expect(h.store.q.issue(id)?.status).toBe('completed');
  });
});

describe('runAttempt: feedback is scoped to the issue rev', () => {
  it('a retry at the same rev says (none) only before the first attempt', async () => {
    const h = await setup({ check: (n) => (n === 0 ? failingCheck('red at rev 1\n')() : PASSING) });
    const id = h.addIssue('Scaffold');

    await h.run(id);
    await h.run(id);

    const prompts = implementerPrompts(h, id);
    expect(prompts[0]?.prompt).toContain(NO_FEEDBACK);
    expect(prompts.at(-1)?.prompt).toContain('red at rev 1');
  });

  it('after an owner edit bumps the rev, the old feedback is not included', async () => {
    const h = await setup({ check: (n) => (n === 0 ? failingCheck('red at rev 1\n')() : PASSING) });
    const id = h.addIssue('Scaffold');

    await h.run(id);
    expect(attemptsOf(h.store, id).map((a) => a.issueRev)).toEqual([1]);
    const edited = editIssue({ store: h.store, ids: h.ids }, id, {
      rev: 1,
      body: 'Build Scaffold, edited by the owner.',
    });
    expect(edited).toMatchObject({ ok: true, rev: 2 });

    await h.run(id);

    const last = implementerPrompts(h, id).at(-1)?.prompt;
    expect(last).toContain('Build Scaffold, edited by the owner.');
    expect(last).not.toContain('red at rev 1');
    expect(last).toContain(NO_FEEDBACK);
    expect(attemptsOf(h.store, id).map((a) => a.issueRev)).toEqual([1, 2]);
  });
});

describe('runAttempt: max attempts', () => {
  it.each([1, 2, 4])('maxAttempts %i: fails after that many counted failures', async (max) => {
    const h = await setup({ maxAttempts: max, check: failingCheck('still red\n') });
    const id = h.addIssue('Scaffold');

    for (let i = 1; i < max; i += 1) {
      await h.run(id);
      expect(h.store.q.issue(id)).toMatchObject({ status: 'open', attemptCount: i });
    }
    await h.run(id);

    expect(h.store.q.issue(id)).toMatchObject({ status: 'failed', attemptCount: max });
    expect(h.store.q.issue(id)?.failureReason).toContain('still red');
    const failed = h.store.eventsSince(0).filter((e) => e.type === 'issue.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data).toMatchObject({ from: 'in_progress', attemptCount: max });
    expect(attemptsOf(h.store, id).every((a) => a.counted)).toBe(true);
    expectSnapshotMatchesReplay(h.store);
  });

  it('a failed issue is an orchestrator trigger', async () => {
    const h = await setup({ maxAttempts: 1, check: failingCheck('red\n') });
    const id = h.addIssue('Scaffold');

    await h.run(id);

    const cursor = h.store.q.product(P)?.orchestratorCursor ?? 0;
    const triggers = pendingTriggers(h.store.eventsSince(0), cursor, { productId: P });
    expect(triggers.map((e) => [e.type, e.entityId])).toEqual([['issue.failed', id]]);
  });

  it('a failed issue is not started again', async () => {
    const h = await setup({ maxAttempts: 1, check: failingCheck('red\n') });
    const id = h.addIssue('Scaffold');

    await h.run(id);
    await h.run(id);

    expect(attemptsOf(h.store, id)).toHaveLength(1);
    expect(h.store.q.issue(id)?.status).toBe('failed');
  });
});

describe('runAttempt: other issues keep running while one fails', () => {
  it('a rejected issue goes back to open while a parallel one merges', async () => {
    const h = await setup({
      script: (a: SpawnedAgent) =>
        a.role === 'reviewer' && a.issueNumber === 1 ? reject(['Not good']) : undefined,
    });
    const one = h.addIssue('One');
    const two = h.addIssue('Two');

    await Promise.all([h.run(one), h.run(two)]);

    expect(h.store.q.issue(one)).toMatchObject({ status: 'open', attemptCount: 1 });
    expect(h.store.q.issue(two)).toMatchObject({ status: 'completed', attemptCount: 0 });
    expect(await h.git.readFileAtMain(P, 'issue-2.txt')).toBe('work for #2\n');
    expect(await h.git.readFileAtMain(P, 'issue-1.txt')).toBeNull();
    await h.expectNoLeftovers();
    expectSnapshotMatchesReplay(h.store);
  });
});

describe('failed → orchestrator rewrite → completed', () => {
  it('the orchestrator rewrites the failed issue, attempts reset, the next attempt merges', async () => {
    let rewritten = false;
    const h = await setup({
      maxAttempts: 2,
      script: (a) => {
        if (a.role === 'implementer' && !rewritten) return writeAndFinish('wrong.txt', 'x\n');
        if (a.role === 'reviewer' && !rewritten) return reject(['Wrong file']);
        return undefined;
      },
    });
    const id = h.addIssue('Scaffold');

    await h.run(id);
    await h.run(id);
    expect(h.store.q.issue(id)).toMatchObject({ status: 'failed', attemptCount: 2 });

    const rewrite: PlanResult = {
      issueOps: [{ op: 'rewrite', id, body: 'Build Scaffold; keep it small.' }],
      questions: [],
      summary: 'Rewrote #1 after it failed.',
    };

    const { limits: _limits, artifactsDir: _artifacts, modelDeps: _model, ...deps } = h.deps;
    // The orchestrator reads its model deps before it spawns its agent, so it gets its own script.
    const orchestrator = createOrchestrator({
      ...deps,
      modelDeps: { getSecret: () => undefined, fake: { script: [finish(rewrite)] } },
    });
    const cursor = h.store.q.product(P)?.orchestratorCursor ?? 0;
    const triggers = pendingTriggers(h.store.eventsSince(0), cursor, { productId: P });
    expect(triggers.map((e) => e.type)).toEqual(['issue.failed']);
    await orchestrator.runOrchestrator(P, triggers, runHandle(h.ids));
    rewritten = true;
    const errors = Object.values(h.store.snapshot().state.inbox).filter((i) => i.kind === 'error');
    expect(errors).toEqual([]);

    expect(h.store.q.issue(id)).toMatchObject({
      status: 'open',
      attemptCount: 0,
      failureReason: null,
      body: 'Build Scaffold; keep it small.',
    });
    const after = h.store.q.product(P)?.orchestratorCursor ?? 0;
    expect(pendingTriggers(h.store.eventsSince(0), after, { productId: P })).toEqual([]);

    await h.run(id);

    const afterRewrite = implementerPrompts(h, id).at(-1)?.prompt;
    expect(afterRewrite).toContain('Build Scaffold; keep it small.');
    // feedback written against the old body (rev 1) is not handed to the rewritten issue (rev 2)
    expect(afterRewrite).not.toContain('Wrong file');
    expect(afterRewrite).toContain(NO_FEEDBACK);
    expect(h.store.q.issue(id)).toMatchObject({ status: 'completed', attemptCount: 0 });
    expect(attemptsOf(h.store, id).map((a) => a.status)).toEqual([
      'rejected',
      'rejected',
      'merged',
    ]);
    expect((await h.mainLog())[0]).toBe('#1 Scaffold');
    expect(await h.git.readFileAtMain(P, 'issue-1.txt')).toBe('work for #1\n');
    await h.expectNoLeftovers();
    expectSnapshotMatchesReplay(h.store);
  });
});
