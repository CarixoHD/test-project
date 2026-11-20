import type { AttemptStatus, AttemptStep } from '../../../shared/domain.ts';
import type { AttemptState } from '../../../shared/state.ts';
import type { BadgeTone } from '../../ui/index.ts';

// Words for attempts on the issue detail page; colour is never the only signal.

export const ATTEMPT_STATUS_BADGE: Record<AttemptStatus, { label: string; tone: BadgeTone }> = {
  running: { label: 'Running', tone: 'progress' },
  merged: { label: 'Merged', tone: 'success' },
  check_failed: { label: 'Check failed', tone: 'danger' },
  rejected: { label: 'Rejected by review', tone: 'danger' },
  conflict: { label: 'Merge conflict', tone: 'danger' },
  error: { label: 'Error', tone: 'warning' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};

export const ATTEMPT_STEP_LABEL: Record<AttemptStep, string> = {
  implement: 'Implement',
  check: 'Check',
  review: 'Review',
  merge: 'Merge',
};

/** Whether the attempt used up one of the issue's attempts (ADR 7). */
export const countedText = (a: AttemptState): string =>
  a.counted ? 'Counted toward the attempt limit' : 'Not counted';

/** Attempts of an issue, newest first. */
export function attemptsOf(
  attempts: Record<string, AttemptState | undefined>,
  issueId: string,
): AttemptState[] {
  return Object.values(attempts)
    .filter((a): a is AttemptState => a !== undefined && a.issueId === issueId)
    .sort((a, b) => b.n - a.n);
}

export const formatDateTime = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
