import type { ReviewResult } from '../../shared/agent-results.ts';
import type { AttemptStep } from '../../shared/domain.ts';
import type { EventDraft, EventOf } from '../../shared/events.ts';
import type { AttemptId, IssueId, ProductId } from '../../shared/ids.ts';
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

/** issue → in_progress and attempt.started; false when the issue can no longer start. */
export function startAttempt(ref: AttemptRef, wt: { baseSha: string; branch: string }): boolean {
  let started = false;
  ref.store.commit((tx) => {
    const issue = tx.q.issue(ref.issueId);
    const moved = issue === null ? null : statusDraft(tx, issue, { type: 'start' });
    if (issue === null || moved === null) return [];
    started = true;
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

/**
 * attempt.ended{error}, uncounted, and the issue back to open (not before `runAfter`) when it is
 * still in progress or in review. Counted failures with feedback are a follow-up; until then the
 * uncounted `interrupted` transition is the legal way back to open.
 */
export function endWithError(
  ref: AttemptRef,
  feedback: string,
  outcome: AttemptOutcome,
  runAfter: number,
): void {
  ref.store.commit((tx) => {
    const issue = tx.q.issue(ref.issueId);
    const reopened =
      issue === null
        ? null
        : statusDraft(tx, issue, { type: 'interrupted', reason: 'shutdown', runAfter });
    return [endedDraft(ref, 'error', feedback, outcome), ...(reopened === null ? [] : [reopened])];
  });
}

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
  status: 'merged' | 'error',
  feedback: string | null,
  outcome: AttemptOutcome,
): EventDraft {
  return attemptDraft(ref, 'attempt.ended', {
    issueId: ref.issueId,
    status,
    counted: false,
    ...outcome,
    feedback,
    interruptReason: null,
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
