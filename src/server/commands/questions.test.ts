import { describe, expect, it } from 'vitest';
import type { EventDraft } from '../../shared/events.ts';
import type { IssueId } from '../../shared/ids.ts';
import { createApp } from '../http/index.ts';
import { productCreated, setupStore, TEST_PRODUCT } from '../http/testing.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { addIssue, answerQuestion } from './index.ts';

// Owner answers to agent questions (ARCHITECTURE §6 flow 8): question.answered, and for an
// issue question that holds its issue also issue.released. A second answer is a conflict.

const draft = (type: string, entityId: string | null, data: object) =>
  ({ type, productId: TEST_PRODUCT, entityId, v: 1, data }) as EventDraft;

function setup() {
  const deps = setupStore();
  deps.store.commit(() => [productCreated()]);
  const r = addIssue({ store: deps.store, ids: deps.ids }, TEST_PRODUCT, {
    title: 'Login',
    body: 'Build login.',
    dependsOn: [],
  });
  if (!r.ok) throw new Error(r.reason);
  return { ...deps, issueId: r.issueId, app: createApp(deps) };
}

function askIssueQuestion(s: ReturnType<typeof setup>, id: string, hold = true) {
  s.store.commit(() => [
    draft('question.asked', id, {
      target: 'issue',
      issueId: s.issueId,
      agentId: null,
      text: 'Email or username?',
    }),
    ...(hold ? [{ ...draft('issue.held', s.issueId, { questionId: id }) }] : []),
  ]);
}

function askOrchestratorQuestion(s: ReturnType<typeof setup>, id: string) {
  s.store.commit(() => [
    draft('question.asked', id, {
      target: 'orchestrator',
      issueId: null,
      agentId: null,
      text: 'Which database?',
    }),
  ]);
}

const issue = (s: ReturnType<typeof setup>, id: IssueId) => s.store.q.issue(id);
const typesSince = (s: ReturnType<typeof setup>, seq: number) =>
  s.store.eventsSince(seq).map((e) => e.type);

const post = (app: ReturnType<typeof setup>['app'], id: string, body: unknown) =>
  app.request(`/api/questions/${id}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('answerQuestion', () => {
  it('answers an issue question and releases the held issue in one commit', () => {
    const s = setup();
    askIssueQuestion(s, 'question-1');
    expect(issue(s, s.issueId)?.heldQuestionId).toBe('question-1');
    const before = s.store.snapshot().lastSeq;

    const r = answerQuestion(s, 'question-1', 'Email, please');

    expect(r.ok).toBe(true);
    expect(typesSince(s, before)).toEqual(['question.answered', 'issue.released']);
    expect(issue(s, s.issueId)?.heldQuestionId).toBeNull();
    expect(s.store.snapshot().state.questions['question-1']).toMatchObject({
      answer: 'Email, please',
      answeredAt: expect.any(Number),
    });
    expectSnapshotMatchesReplay(s.store);
  });

  it('answers an orchestrator question without touching any issue', () => {
    const s = setup();
    askOrchestratorQuestion(s, 'question-1');
    const before = s.store.snapshot().lastSeq;

    expect(answerQuestion(s, 'question-1', 'SQLite').ok).toBe(true);

    expect(typesSince(s, before)).toEqual(['question.answered']);
    expectSnapshotMatchesReplay(s.store);
  });

  it('does not release an issue that is no longer held by this question', () => {
    const s = setup();
    askIssueQuestion(s, 'question-1', false);
    const before = s.store.snapshot().lastSeq;

    expect(answerQuestion(s, 'question-1', 'Email').ok).toBe(true);

    expect(typesSince(s, before)).toEqual(['question.answered']);
  });

  it('a second answer is a conflict and commits nothing', () => {
    const s = setup();
    askIssueQuestion(s, 'question-1');
    expect(answerQuestion(s, 'question-1', 'Email').ok).toBe(true);
    const before = s.store.snapshot().lastSeq;

    expect(answerQuestion(s, 'question-1', 'Username')).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    expect(s.store.snapshot().lastSeq).toBe(before);
    expect(s.store.snapshot().state.questions['question-1']?.answer).toBe('Email');
  });

  it('an unknown question is not_found', () => {
    const s = setup();
    expect(answerQuestion(s, 'question-x', 'Email')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});

describe('POST /api/questions/:id/answer', () => {
  it('200 answers; a second answer → 409', async () => {
    const s = setup();
    askIssueQuestion(s, 'question-1');

    const first = await post(s.app, 'question-1', { text: 'Email' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(issue(s, s.issueId)?.heldQuestionId).toBeNull();

    const second = await post(s.app, 'question-1', { text: 'Username' });
    expect(second.status).toBe(409);
  });

  it('404 for an unknown question; 400 for an empty answer', async () => {
    const s = setup();
    askIssueQuestion(s, 'question-1');
    expect((await post(s.app, 'question-x', { text: 'Email' })).status).toBe(404);
    expect((await post(s.app, 'question-1', { text: '   ' })).status).toBe(400);
    expect((await post(s.app, 'question-1', {})).status).toBe(400);
    expect(s.store.snapshot().state.questions['question-1']?.answer).toBeNull();
  });
});
