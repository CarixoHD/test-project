import type { ReviewResult } from '../../shared/agent-results.ts';
import type { AttemptStep, InterruptReason } from '../../shared/domain.ts';
import type { EventDraft, EventOf } from '../../shared/events.ts';
import type { AgentId, AttemptId, IssueId, ProductId, QuestionId } from '../../shared/ids.ts';
import { transition, type IssueTransitionEvent } from '../../shared/issues.ts';
import type { IssueState } from '../../shared/state.ts';
import type { Store, Tx } from '../store/index.ts';

// Store commits of an attempt (ARCHITECTURE §6 flow 4). Issue moves always go through the
// shared `transition()`; a move that is no longer legal (e.g. the owner cancelled) is skipped.

export type AttemptRef = {
  store: Store;
  productId: ProductId;
  issueId: IssueId;
  attemptId: AttemptId;
};

/** What attempt.ended reports besides status and feedback. */
export type AttemptOutcome = {
  headSha: string | null;
  review: ReviewResult | null;
  checkExit: number | null;
};

/**
 * issue → in_progress and attempt.started{issueRev}; returns the issue as the attempt got it
 * (the content the agents work on), or null when the issue can no longer start.
 */
export function startAttempt(
  ref: AttemptRef,
  wt: { baseSha: string; branch: string },
): IssueState | null {
  let started: IssueState | null = null;
  ref.store.commit((tx) => {
    const issue = tx.q.issue(ref.issueId);
    const moved = issue === null ? null : statusDraft(tx, issue, { type: 'start' });
    if (issue === null || moved === null) return [];
    started = issue;
    const n = tx.q.attemptsByIssue(ref.issueId).length + 1;
    return [
      moved,
      attemptDraft(ref, 'attempt.started', {
        issueId: ref.issueId,
        n,
        issueRev: issue.rev,
        baseSha: wt.baseSha,
        branch: wt.branch,
      }),
    ];
  });
  return started;
}

export function recordStep(ref: AttemptRef, step: AttemptStep): void {
  ref.store.commit(() => [attemptDraft(ref, 'attempt.step', { issueId: ref.issueId, step })]);
}

/** Moves the issue and the attempt to `step` in one commit; false when the move is illegal. */
export function moveIssue(ref: AttemptRef, ev: IssueTransitionEvent, step: AttemptStep): boolean {
  let moved = false;
  ref.store.commit((tx) => {
    const issue = tx.q.issue(ref.issueId);
    const draft = issue === null ? null : statusDraft(tx, issue, ev);
    if (draft === null) return [];
    moved = true;
    return [draft, attemptDraft(ref, 'attempt.step', { issueId: ref.issueId, step })];
  });
  return moved;
}

/** issue.completed{mergedOrder, mergeSha} and attempt.ended{merged} in one commit. */
export function completeAttempt(ref: AttemptRef, mergeSha: string, outcome: AttemptOutcome): void {
  ref.store.commit((tx) => {
    const issue = tx.q.issue(ref.issueId);
    if (issue === null) throw new Error(`issue ${ref.issueId} disappeared during the merge`);
    const mergedOrder =
      Math.max(0, ...tx.q.issuesByProduct(ref.productId).map((i) => i.mergedOrder ?? 0)) + 1;
    const next = transition(issue, { type: 'merged', mergedOrder, mergeSha }, config(tx, issue));
    if (!next.ok) throw new Error(`cannot complete issue: ${next.reason}`);
    return [
      {
        type: 'issue.completed',
        productId: ref.productId,
        entityId: ref.issueId,
        v: 1,
        data: { attemptId: ref.attemptId, mergedOrder, mergeSha },
      },
      endedDraft(ref, 'merged', null, outcome),
    ];
  });
}

/** Attempt statuses of counted failures (ADR 7); an empty diff and agent errors are `error`. */
export type CountedStatus = 'check_failed' | 'rejected' | 'conflict' | 'error';

/**
 * A counted failure in one commit: attempt.ended{status, counted, feedback} and the shared
 * `attempt_failed` transition, i.e. issue.status_changed{→open, attemptCount} while attempts
 * remain, else issue.failed{attemptCount, reason = feedback} (an orchestrator trigger). The
 * issue is left alone when it is no longer in progress or in review (e.g. cancelled).
 */
export function failAttempt(
  ref: AttemptRef,
  status: CountedStatus,
  feedback: string,
  outcome: AttemptOutcome,
): void {
  ref.store.commit((tx) => {
    const issue = tx.q.issue(ref.issueId);
    const ended = endedDraft(ref, status, feedback, outcome, true);
    if (issue === null) return [ended];
    return [ended, ...failureDrafts(tx, issue, feedback)];
  });
}

function failureDrafts(tx: Tx, issue: IssueState, reason: string): EventDraft[] {
  const from = issue.status;
  if (from !== 'in_progress' && from !== 'in_review') return [];
  const r = transition(issue, { type: 'attempt_failed', reason }, config(tx, issue));
  if (!r.ok) throw new Error(`cannot count the failed attempt: ${r.reason}`);
  const { next } = r;
  if (next.status === 'failed') {
    return [
      {
        type: 'issue.failed',
        productId: issue.productId,
        entityId: issue.id,
        v: 1,
        data: { from, attemptCount: next.attemptCount, reason },
      },
    ];
  }
  return [
    {
      type: 'issue.status_changed',
      productId: issue.productId,
      entityId: issue.id,
      v: 1,
      data: { from, to: next.status, attemptCount: next.attemptCount, runAfter: next.runAfter },
    },
  ];
}

/**
 * attempt.ended{error}, uncounted, and the issue back to open (not before `runAfter`) when it is
 * still in progress or in review: an infrastructure fault or missing setup, not an interruption.
 */
export function endWithError(
  ref: AttemptRef,
  feedback: string,
  outcome: AttemptOutcome,
  runAfter: number,
): void {
  ref.store.commit((tx) => [
    endedDraft(ref, 'error', feedback, outcome),
    ...reopenDrafts(tx, ref, { type: 'interrupted', runAfter }),
  ]);
}

/** An account-wide backend limit recorded with an interruption (backend.limited). */
export type BackendLimitDraft = {
  backend: string;
  until: number | null;
  needsLogin: boolean;
  reason: string;
};

/** An implementer's question to the owner (flow 4.3); it holds the issue until answered. */
export type QuestionDraft = { id: QuestionId; agentId: AgentId; text: string };

/**
 * attempt.ended{interrupted, interruptReason}, uncounted (ADR 7), and the issue back to open
 * (not before `runAfter`) when it is still in progress or in review. `limit` also commits
 * backend.limited, but only when it changes the backend's projected limit, so parallel attempts
 * hitting the same limit record it (and its inbox item) once. `question` also commits
 * question.asked{target:'issue'} and issue.held, so the scheduler skips the issue until the
 * owner answers; when the issue was cancelled meanwhile (re-read inside the commit), the
 * question is dropped and the attempt is discarded instead.
 */
export function interruptAttempt(
  ref: AttemptRef,
  reason: InterruptReason,
  feedback: string,
  outcome: AttemptOutcome,
  o: { runAfter?: number; limit?: BackendLimitDraft; question?: QuestionDraft } = {},
): void {
  ref.store.commit((tx) => {
    const { limit, runAfter, question } = o;
    if (question !== undefined && tx.q.issue(ref.issueId)?.status === 'cancelled') {
      return [endedDraft(ref, 'discarded', feedback, outcome)];
    }
    const limited = limit !== undefined && limitChanged(tx, limit) ? [limitedDraft(limit)] : [];
    const asked = question === undefined ? [] : questionDrafts(ref, question);
    return [
      endedDraft(ref, 'interrupted', feedback, outcome, false, reason),
      ...reopenDrafts(tx, ref, {
        type: 'interrupted',
        reason,
        ...(runAfter === undefined ? {} : { runAfter }),
      }),
      ...limited,
      ...asked,
    ];
  });
}

function questionDrafts(ref: AttemptRef, q: QuestionDraft): EventDraft[] {
  return [
    {
      type: 'question.asked',
      productId: ref.productId,
      entityId: q.id,
      v: 1,
      data: { target: 'issue', issueId: ref.issueId, agentId: q.agentId, text: q.text },
    },
    {
      type: 'issue.held',
      productId: ref.productId,
      entityId: ref.issueId,
      v: 1,
      data: { questionId: q.id },
    },
  ];
}

/** attempt.ended{discarded}, uncounted: the issue was cancelled, so its work is thrown away. */
export function discardAttempt(ref: AttemptRef, feedback: string, outcome: AttemptOutcome): void {
  ref.store.commit(() => [endedDraft(ref, 'discarded', feedback, outcome)]);
}

function reopenDrafts(
  tx: Tx,
  ref: AttemptRef,
  ev: Extract<IssueTransitionEvent, { type: 'interrupted' }>,
): EventDraft[] {
  const issue = tx.q.issue(ref.issueId);
  const reopened = issue === null ? null : statusDraft(tx, issue, ev);
  return reopened === null ? [] : [reopened];
}

function limitChanged(tx: Tx, limit: BackendLimitDraft): boolean {
  const current = tx.q.backendLimit(limit.backend);
  return (
    current === null || current.until !== limit.until || current.needsLogin !== limit.needsLogin
  );
}

const limitedDraft = (data: BackendLimitDraft): EventDraft => ({
  type: 'backend.limited',
  productId: null,
  entityId: null,
  v: 1,
  data,
});

const config = (tx: Tx, issue: IssueState) => ({
  maxAttempts: tx.q.product(issue.productId)?.settings.maxAttempts ?? 1,
});

/** issue.status_changed for a legal transition, else null. */
function statusDraft(tx: Tx, issue: IssueState, ev: IssueTransitionEvent): EventDraft | null {
  const r = transition(issue, ev, config(tx, issue));
  if (!r.ok || r.next.status === issue.status) return null;
  return {
    type: 'issue.status_changed',
    productId: issue.productId,
    entityId: issue.id,
    v: 1,
    data: {
      from: issue.status,
      to: r.next.status,
      attemptCount: r.next.attemptCount,
      runAfter: r.next.runAfter,
    },
  };
}

function endedDraft(
  ref: AttemptRef,
  status: 'merged' | 'discarded' | CountedStatus,
  feedback: string | null,
  outcome: AttemptOutcome,
  counted?: boolean,
): EventDraft;
function endedDraft(
  ref: AttemptRef,
  status: 'interrupted',
  feedback: string,
  outcome: AttemptOutcome,
  counted: false,
  interruptReason: InterruptReason,
): EventDraft;
function endedDraft(
  ref: AttemptRef,
  status: 'merged' | 'discarded' | 'interrupted' | CountedStatus,
  feedback: string | null,
  outcome: AttemptOutcome,
  counted = false,
  interruptReason: InterruptReason | null = null,
): EventDraft {
  return attemptDraft(ref, 'attempt.ended', {
    issueId: ref.issueId,
    status,
    counted,
    ...outcome,
    feedback,
    interruptReason,
  });
}

type AttemptEventType = 'attempt.started' | 'attempt.step' | 'attempt.ended';

function attemptDraft<T extends AttemptEventType>(
  ref: AttemptRef,
  type: T,
  data: EventOf<T>['data'],
): EventDraft {
  // `data` is checked against T's payload type above; TS cannot narrow the union draft from T.
  return { type, productId: ref.productId, entityId: ref.attemptId, v: 1, data } as EventDraft;
}
