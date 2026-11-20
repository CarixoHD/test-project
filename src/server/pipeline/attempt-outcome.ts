import { budgetLevel } from '../../shared/budget.ts';
import type { InterruptReason } from '../../shared/domain.ts';
import type { AgentResult } from '../agents/index.ts';
import type { RunHandle } from '../scheduler/index.ts';
import {
  discardAttempt,
  endWithError,
  failAttempt,
  interruptAttempt,
  type AttemptOutcome,
  type AttemptRef,
  type BackendLimitDraft,
  type CountedStatus,
} from './attempt-events.ts';
import { limitOf, LOGIN_RETRY_DELAY_MS } from './backend-limit.ts';
import type { RecordedRunContext } from './run-recorded.ts';

// How an attempt ends (ADR 7): merged, a counted failure, an uncounted error, an interruption
// (pause, budget, shutdown, rate limit, login, owner edit) or discarded (owner cancel), and the
// commit that records it.

/** An errored attempt's issue waits this long before the scheduler starts it again. */
export const ERROR_RETRY_DELAY_MS = 60_000;
export const DISCARDED_FEEDBACK = "the issue was cancelled, so the attempt's work was discarded";
export const ISSUE_CHANGED_FEEDBACK =
  'the issue was edited during the attempt; the next attempt works on the new version';

/** What the outcome helpers need of an attempt: its ids, the store and the run. */
export type OutcomeCtx = AttemptRef & {
  deps: Pick<RecordedRunContext, 'store' | 'clock' | 'redactor'>;
  run: Pick<RunHandle, 'shouldStop'>;
};

/** What the attempt ends with; the outcome fields go into attempt.ended. */
export type Ended = AttemptOutcome &
  (
    | { kind: 'merged' }
    | { kind: 'failed'; status: CountedStatus; feedback: string }
    | { kind: 'error'; reason: string }
    | {
        kind: 'interrupted';
        reason: InterruptReason;
        feedback: string;
        runAfter?: number;
        limit?: BackendLimitDraft;
      }
    | { kind: 'discarded'; feedback: string }
  );

/**
 * A failed step; `counted` marks agent errors (ADR 7), which count against maxAttempts, and
 * `agent` the agent results that interrupt the attempt instead.
 */
export type Failed = {
  ok: false;
  reason: string;
  counted?: boolean;
  agent?: Exclude<AgentResult<unknown>, { kind: 'ok' | 'error' }>;
};

/** Commits how the attempt ended (merged attempts are already recorded by the merge). */
export function recordEnd(ctx: OutcomeCtx, ended: Ended): void {
  const redact = (text: string) => ctx.deps.redactor.redact(text);
  const outcome = outcomeOf(ended);
  switch (ended.kind) {
    case 'merged':
      return;
    case 'failed':
      return failAttempt(ctx, ended.status, redact(ended.feedback), outcome);
    case 'error': {
      const runAfter = ctx.deps.clock.now() + ERROR_RETRY_DELAY_MS;
      return endWithError(ctx, redact(ended.reason), outcome, runAfter);
    }
    case 'interrupted': {
      const { limit, runAfter } = ended;
      return interruptAttempt(ctx, ended.reason, redact(ended.feedback), outcome, {
        ...(runAfter === undefined ? {} : { runAfter }),
        ...(limit === undefined ? {} : { limit: { ...limit, reason: redact(limit.reason) } }),
      });
    }
    case 'discarded':
      return discardAttempt(ctx, redact(ended.feedback), outcome);
    default:
      return assertNever(ended);
  }
}

export const outcomeOf = (p: Partial<AttemptOutcome>): AttemptOutcome => ({
  headSha: p.headSha ?? null,
  review: p.review ?? null,
  checkExit: p.checkExit ?? null,
});

/** An uncounted error: the issue goes back to open after ERROR_RETRY_DELAY_MS. */
export const fail = (reason: string, p: Partial<AttemptOutcome> = {}): Ended => ({
  kind: 'error',
  reason,
  ...outcomeOf(p),
});

/** A counted failure whose feedback goes to the next attempt. */
export const counted = (
  status: CountedStatus,
  feedback: string,
  p: Partial<AttemptOutcome> = {},
): Ended => ({ kind: 'failed', status, feedback, ...outcomeOf(p) });

/** An uncounted interruption (ADR 7); the issue goes back to open. */
export const interrupted = (
  reason: InterruptReason,
  feedback: string,
  p: Partial<AttemptOutcome> = {},
  o: { runAfter?: number; limit?: BackendLimitDraft } = {},
): Ended => ({ kind: 'interrupted', reason, feedback, ...o, ...outcomeOf(p) });

export const discarded = (p: Partial<AttemptOutcome> = {}): Ended => ({
  kind: 'discarded',
  feedback: DISCARDED_FEEDBACK,
  ...outcomeOf(p),
});

export const isCancelled = (ctx: OutcomeCtx) =>
  ctx.deps.store.q.issue(ctx.issueId)?.status === 'cancelled';

/** The run should stop after its current step: the scheduler says so, or the owner cancelled. */
export const stopRequested = (ctx: OutcomeCtx) => isCancelled(ctx) || ctx.run.shouldStop();

/** Why the run was stopped: an owner cancel discards the attempt, the rest interrupt it. */
export function stopped(ctx: OutcomeCtx, feedback: string, p: Partial<AttemptOutcome> = {}): Ended {
  if (isCancelled(ctx)) return discarded(p);
  return interrupted(stopReason(ctx), feedback, p);
}

function stopReason(ctx: OutcomeCtx): InterruptReason {
  const { store } = ctx.deps;
  const product = store.q.product(ctx.productId);
  if (product === null) return 'shutdown';
  const spent = store.q.productUsage(ctx.productId).apiUsd;
  if (budgetLevel(spent, product.settings.budgetUsd) === 'exhausted') return 'budget';
  return product.paused ? 'paused' : 'shutdown';
}

/**
 * A failed agent run: agent errors count; a stop, rate limit or missing login interrupts the
 * attempt without counting it, and the limits are recorded account-wide (backend.limited).
 */
export function agentFailed(ctx: OutcomeCtx, r: Failed, p: Partial<AttemptOutcome> = {}): Ended {
  if (r.counted === true) return counted('error', r.reason, p);
  const agent = r.agent;
  switch (agent?.kind) {
    case undefined:
      return fail(r.reason, p);
    case 'stopped':
      return stopped(ctx, r.reason, p);
    case 'rate_limited': {
      const limit = limitOf(agent, r.reason);
      return interrupted('rate_limited', r.reason, p, { runAfter: agent.until, limit });
    }
    case 'auth_required': {
      const runAfter = ctx.deps.clock.now() + LOGIN_RETRY_DELAY_MS;
      return interrupted('auth_required', r.reason, p, {
        runAfter,
        limit: limitOf(agent, r.reason),
      });
    }
    default:
      return assertNever(agent);
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}
