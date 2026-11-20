import type { InterruptReason, IssueStatus, IssueView } from './domain.ts';
import type { IssueId } from './ids.ts';

// Issue state machine (ARCHITECTURE §4.1 "Legal issue transitions", ADR 7).
// Pure: callers turn a successful transition into store writes and issue.* events.

/** What happened to an issue; the machine decides the resulting status. */
export type IssueTransitionEvent =
  /** open → in_progress: the scheduler starts an attempt. */
  | { type: 'start' }
  /** in_progress → in_review: checks passed. */
  | { type: 'checks_passed' }
  /**
   * Counted failure (check_failed, rejected, conflict, empty diff, agent error).
   * in_progress|in_review → open while attempts remain, else → failed.
   */
  | { type: 'attempt_failed'; reason: string; runAfter?: number }
  /**
   * Uncounted interruption: in_progress|in_review → open, attemptCount unchanged. No `reason`
   * for an uncounted infrastructure error, which is no interruption but goes back to open too.
   */
  | { type: 'interrupted'; reason?: InterruptReason; runAfter?: number }
  /** in_review → completed: merged to main. */
  | { type: 'merged'; mergedOrder: number; mergeSha: string }
  /** open|failed|in_progress|in_review → cancelled, by the owner or orchestrator. */
  | { type: 'cancel' }
  /** failed → open: the orchestrator rewrites the issue; attemptCount resets. */
  | { type: 'rewrite'; body: string };

export type TransitionResult = { ok: true; next: IssueView } | { ok: false; reason: string };

export type IssueTransitionConfig = { maxAttempts: number };

/** Lookup for dependency status; a Map or a plain record keyed by issue id. */
export type IssuesById =
  | ReadonlyMap<IssueId, Pick<IssueView, 'status'>>
  | Readonly<Partial<Record<IssueId, Pick<IssueView, 'status'>>>>;

/** Statuses each event may leave from. */
const FROM: Record<IssueTransitionEvent['type'], readonly IssueStatus[]> = {
  start: ['open'],
  checks_passed: ['in_progress'],
  attempt_failed: ['in_progress', 'in_review'],
  interrupted: ['in_progress', 'in_review'],
  merged: ['in_review'],
  cancel: ['open', 'failed', 'in_progress', 'in_review'],
  rewrite: ['failed'],
};

function assertNever(x: never): never {
  throw new Error(`unhandled issue transition event: ${JSON.stringify(x)}`);
}

export function transition(
  issue: IssueView,
  ev: IssueTransitionEvent,
  cfg: IssueTransitionConfig,
): TransitionResult {
  if (!FROM[ev.type].includes(issue.status)) {
    return { ok: false, reason: `cannot ${ev.type} an issue that is ${issue.status}` };
  }
  switch (ev.type) {
    case 'start':
      return ok(issue, { status: 'in_progress' });
    case 'checks_passed':
      return ok(issue, { status: 'in_review' });
    case 'attempt_failed':
      return countFailure(issue, ev, cfg);
    case 'interrupted':
      return ok(issue, { status: 'open', runAfter: ev.runAfter ?? issue.runAfter });
    case 'merged':
      return ok(issue, {
        status: 'completed',
        mergedOrder: ev.mergedOrder,
        mergeSha: ev.mergeSha,
      });
    case 'cancel':
      return ok(issue, { status: 'cancelled' });
    case 'rewrite':
      return ok(issue, {
        status: 'open',
        body: ev.body,
        rev: issue.rev + 1,
        attemptCount: 0,
        failureReason: null,
      });
    default:
      return assertNever(ev);
  }
}

function countFailure(
  issue: IssueView,
  ev: Extract<IssueTransitionEvent, { type: 'attempt_failed' }>,
  cfg: IssueTransitionConfig,
): TransitionResult {
  if (!Number.isInteger(cfg.maxAttempts) || cfg.maxAttempts < 1) {
    return { ok: false, reason: `maxAttempts must be a positive integer, got ${cfg.maxAttempts}` };
  }
  const attemptCount = issue.attemptCount + 1;
  const exhausted = attemptCount >= cfg.maxAttempts;
  return ok(issue, {
    status: exhausted ? 'failed' : 'open',
    attemptCount,
    failureReason: ev.reason,
    runAfter: ev.runAfter ?? issue.runAfter,
  });
}

function ok(issue: IssueView, patch: Partial<IssueView>): TransitionResult {
  return { ok: true, next: { ...issue, ...patch } };
}

function isMap<K, V>(x: ReadonlyMap<K, V> | object): x is ReadonlyMap<K, V> {
  return x instanceof Map;
}

function lookup(issuesById: IssuesById, id: IssueId): Pick<IssueView, 'status'> | undefined {
  return isMap(issuesById) ? issuesById.get(id) : issuesById[id];
}

/** Open, not held by a question, every dependency completed, and runAfter has passed. */
export function isReady(issue: IssueView, issuesById: IssuesById, now: number): boolean {
  return (
    issue.status === 'open' &&
    issue.heldQuestionId === null &&
    issue.runAfter <= now &&
    issue.dependsOn.every((id) => lookup(issuesById, id)?.status === 'completed')
  );
}

/** How many more agents may start; never negative. */
export function slotsFree(running: number, maxParallel: number): number {
  return Math.max(0, maxParallel - running);
}
