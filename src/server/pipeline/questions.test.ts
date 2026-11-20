import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event, EventDraft } from '../../shared/events.ts';
import type { IssueId, QuestionId } from '../../shared/ids.ts';
import { isReady } from '../../shared/issues.ts';
import { answerQuestion } from '../commands/index.ts';
import type { FakeScript } from '../llm/index.ts';
import { createScheduler, type RunHandle, type Timer } from '../scheduler/index.ts';
import type { Store } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { P, setupAttempt, type Harness, type HarnessOptions } from './attempt-testing.ts';
import { orchestratorPrompt } from './orchestrator-prompt.ts';

// Agent questions to the owner (ARCHITECTURE §6 flows 4.3 and 8): an implementer question holds
// its issue and interrupts the attempt without counting it; the owner's answer releases the
// issue and the next attempt's prompt carries the Q&A. An answered orchestrator question wakes
// the orchestrator, whose prompt carries the Q&A.

let dataDir: string;

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-questions-')));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const QUESTION = 'Should users log in with an email address or a username?';
const ANSWER = 'Email address, please.';

const asks: FakeScript = [
  { toolCalls: [{ name: 'finish', input: { summary: 'blocked', question: QUESTION } }] },
];

/** The implementer asks on its first run and works normally afterwards. */
async function setup(o: HarnessOptions = {}): Promise<Harness> {
  let implementers = 0;
  return setupAttempt(dataDir, {
    inbox: true,
    ...o,
    script: (a) => {
      if (a.role !== 'implementer') return undefined;
      implementers += 1;
      return implementers === 1 ? asks : undefined;
    },
  });
}

const draft = (type: string, entityId: string | null, data: object) =>
  ({ type, productId: P, entityId, v: 1, data }) as EventDraft;

/** Hands the product off and consumes the hand-off trigger, so only new triggers wake anything. */
function building(store: Store): void {
  store.commit(() => [
    draft('prd.applied', null, { version: 1, markdown: '# PRD', summary: null }),
    draft('product.handed_off', null, { prdVersion: 1 }),
  ]);
  const cursor = store.snapshot().lastSeq;
  store.commit(() => [draft('orchestrator.cursor_advanced', null, { cursor })]);
}

const eventsOf = <T extends Event['type']>(store: Store, type: T) =>
  store.eventsSince(0).filter((e): e is Extract<Event, { type: T }> => e.type === type);

const idleTimer: Timer = { setInterval: () => 0, clearInterval: () => {} };

/** A scheduler whose attempts really run (through the harness) and whose orchestrator is a spy. */
function scheduler(h: Harness) {
  const attempts: { issueId: IssueId; done: Promise<void> }[] = [];
  const orchestrators: Event[][] = [];
  const s = createScheduler({
    store: h.store,
    clock: h.clock,
    ids: h.ids,
    timer: idleTimer,
    isBackendBlocked: () => false,
    runners: {
      runAttempt: (issueId: IssueId, run: RunHandle) => {
        const done = h.run(issueId, run);
        attempts.push({ issueId, done });
        return done;
      },
      runOrchestrator: (_productId, triggers) => {
        orchestrators.push(triggers);
        return Promise.resolve();
      },
    },
  });
  return { s, attempts, orchestrators };
}

function heldQuestion(h: Harness, id: IssueId): QuestionId {
  const q = h.store.q.issue(id)?.heldQuestionId;
  if (q === null || q === undefined) throw new Error('the issue is not held');
  return q;
}

describe('implementer questions', () => {
  it('a question holds the issue and interrupts the attempt without counting it', async () => {
    const h = await setup({ maxAttempts: 1 });
    const id = h.addIssue('Login');
    const main = await h.rawGit(['rev-parse', 'main']);

    await h.run(id);

    const [attempt] = h.store.q.attemptsByIssue(id);
    expect(attempt).toMatchObject({
      status: 'interrupted',
      interruptReason: 'question',
      counted: false,
    });
    // maxAttempts 1: a counted attempt would have failed the issue.
    expect(h.store.q.issue(id)).toMatchObject({
      status: 'open',
      attemptCount: 0,
      failureReason: null,
    });
    const qid = heldQuestion(h, id);
    const [implementer] = eventsOf(h.store, 'agent.spawned').filter(
      (e) => e.data.role === 'implementer',
    );
    expect(eventsOf(h.store, 'question.asked')).toEqual([
      expect.objectContaining({
        entityId: qid,
        data: { target: 'issue', issueId: id, agentId: implementer?.entityId, text: QUESTION },
      }),
    ]);
    expect(eventsOf(h.store, 'issue.held').map((e) => [e.entityId, e.data])).toEqual([
      [id, { questionId: qid }],
    ]);
    expect(
      eventsOf(h.store, 'agent.state').map((e) => [e.entityId, e.data.state]),
    ).toEqual([[implementer?.entityId, 'waiting_owner']]);
    expect(Object.values(h.store.snapshot().state.inbox).map((i) => i.kind)).toEqual(['question']);
    expect(await h.rawGit(['rev-parse', 'main'])).toBe(main);
    await h.expectNoLeftovers();
    expectSnapshotMatchesReplay(h.store);
  });

  it('a held issue is not scheduled; the answer releases it and the next attempt gets the Q&A and merges', async () => {
    const h = await setup();
    building(h.store);
    const id = h.addIssue('Login');
    await h.run(id);
    const qid = heldQuestion(h, id);

    const { s, attempts } = scheduler(h);
    s.start();
    try {
      const issue = h.store.q.issue(id);
      if (issue === null) throw new Error('issue missing');
      expect(isReady(issue, h.store.snapshot().state.issues, h.clock.now())).toBe(false);
      expect(attempts).toHaveLength(0);

      expect(answerQuestion(h.deps, qid, ANSWER).ok).toBe(true);

      expect(h.store.q.issue(id)?.heldQuestionId).toBeNull();
      expect(attempts.map((a) => a.issueId)).toEqual([id]);
      await attempts[0]?.done;
    } finally {
      await s.stop();
    }

    // One model call per step: the asking run made one, the second attempt's run the rest.
    const [first, ...second] = h.modelCalls
      .filter((c) => c.role === 'implementer')
      .map((c) => c.prompt);
    expect(first).not.toContain(ANSWER);
    expect(second.length).toBeGreaterThan(0);
    expect(second[0]).toContain(QUESTION);
    expect(second[0]).toContain(ANSWER);
    expect(h.store.q.attemptsByIssue(id).map((a) => [a.status, a.counted])).toEqual([
      ['interrupted', false],
      ['merged', false],
    ]);
    expect(h.store.q.issue(id)).toMatchObject({ status: 'completed', attemptCount: 0 });
    expect(await h.mainLog()).toContain('#1 Login');
    expectSnapshotMatchesReplay(h.store);
  });
});

describe('orchestrator questions', () => {
  it('answering an orchestrator question triggers an orchestrator run whose prompt has the Q&A', async () => {
    const h = await setup();
    building(h.store);
    h.store.commit(() => [
      draft('question.asked', 'question-orch', {
        target: 'orchestrator',
        issueId: null,
        agentId: null,
        text: 'Which database should the product use?',
      }),
    ]);
    const { s, orchestrators } = scheduler(h);
    s.start();
    try {
      expect(orchestrators).toHaveLength(0);

      expect(answerQuestion(h.deps, 'question-orch', 'SQLite').ok).toBe(true);

      expect(orchestrators).toHaveLength(1);
      const triggers = orchestrators[0] ?? [];
      expect(triggers.map((e) => [e.type, e.entityId])).toEqual([
        ['question.answered', 'question-orch'],
      ]);
      const { instructions } = orchestratorPrompt({
        store: h.store,
        productId: P,
        triggers,
        prd: '# PRD',
        webSearch: false,
      });
      expect(instructions).toContain('Which database should the product use?');
      expect(instructions).toContain('SQLite');
    } finally {
      await s.stop();
    }
    expectSnapshotMatchesReplay(h.store);
  });
});
