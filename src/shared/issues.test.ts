import { describe, expect, it } from 'vitest';
import { ISSUE_STATUSES, type IssueStatus, type IssueView } from './domain.ts';
import type { IssueId, QuestionId } from './ids.ts';
import { isReady, slotsFree, transition, type IssueTransitionEvent } from './issues.ts';

const SHA = 'a'.repeat(40);
const CFG = { maxAttempts: 3 };

function issue(over: Partial<IssueView> = {}): IssueView {
  return {
    id: 'I1' as IssueId,
    number: 1,
    title: 'Do the thing',
    body: 'body',
    status: 'open',
    rev: 1,
    priority: 0,
    origin: 'orchestrator',
    prdVersion: 1,
    attemptCount: 0,
    heldQuestionId: null,
    runAfter: 0,
    mergedOrder: null,
    mergeSha: null,
    failureReason: null,
    dependsOn: [],
    ...over,
  };
}

const EVENTS: readonly IssueTransitionEvent[] = [
  { type: 'start' },
  { type: 'checks_passed' },
  { type: 'attempt_failed', reason: 'check failed' },
  { type: 'interrupted', reason: 'paused' },
  { type: 'merged', mergedOrder: 1, mergeSha: SHA },
  { type: 'cancel' },
  { type: 'rewrite', body: 'new body' },
];

/** ARCHITECTURE §4.1 "Legal issue transitions", written out as from → allowed to. */
const LEGAL: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['in_review', 'open', 'failed', 'cancelled'],
  in_review: ['completed', 'open', 'failed', 'cancelled'],
  completed: [],
  failed: ['open', 'cancelled'],
  cancelled: [],
};

/** The statuses each event can lead to; used to find the events that "attempt" a pair. */
const TARGETS: Record<IssueTransitionEvent['type'], readonly IssueStatus[]> = {
  start: ['in_progress'],
  checks_passed: ['in_review'],
  attempt_failed: ['open', 'failed'],
  interrupted: ['open'],
  merged: ['completed'],
  cancel: ['cancelled'],
  rewrite: ['open'],
};

/** Every outcome from `from`, trying both "attempts left" and "last attempt" counts. */
function outcomes(from: IssueStatus) {
  return [0, CFG.maxAttempts - 1].flatMap((attemptCount) =>
    EVENTS.map((ev) => ({ ev, res: transition(issue({ status: from, attemptCount }), ev, CFG) })),
  );
}

describe('transition: every from × to pair', () => {
  const pairs = ISSUE_STATUSES.flatMap((from) => ISSUE_STATUSES.map((to) => ({ from, to })));

  it('covers all 36 pairs', () => {
    expect(pairs).toHaveLength(36);
  });

  it.each(pairs)('$from → $to', ({ from, to }) => {
    const results = outcomes(from);
    const reached = results.some((r) => r.res.ok && r.res.next.status === to);
    const legal = LEGAL[from].includes(to);
    expect(reached).toBe(legal);
    if (!legal) {
      const attempts = results.filter((r) => TARGETS[r.ev.type].includes(to));
      expect(attempts.length).toBeGreaterThan(0);
      for (const { ev, res } of attempts) {
        if (res.ok) {
          // The event is legal from here but leads elsewhere (e.g. failed vs open by count).
          expect(res.next.status, `${ev.type}`).not.toBe(to);
        } else {
          expect(res.reason, `${ev.type}`).toMatch(/\S/);
        }
      }
    }
  });
});

describe('transition: from × event table', () => {
  type Row = { from: IssueStatus; ev: IssueTransitionEvent['type']; to: IssueStatus | null };
  const T = (
    from: IssueStatus,
    row: Partial<Record<IssueTransitionEvent['type'], IssueStatus>>,
  ): Row[] => EVENTS.map((e) => ({ from, ev: e.type, to: row[e.type] ?? null }));
  const rows: Row[] = [
    ...T('open', { start: 'in_progress', cancel: 'cancelled' }),
    ...T('in_progress', {
      checks_passed: 'in_review',
      attempt_failed: 'open',
      interrupted: 'open',
      cancel: 'cancelled',
    }),
    ...T('in_review', {
      merged: 'completed',
      attempt_failed: 'open',
      interrupted: 'open',
      cancel: 'cancelled',
    }),
    ...T('completed', {}),
    ...T('failed', { rewrite: 'open', cancel: 'cancelled' }),
    ...T('cancelled', {}),
  ];

  it.each(rows)('$from + $ev → $to', ({ from, ev, to }) => {
    const event = EVENTS.find((e) => e.type === ev);
    if (!event) throw new Error(`no fixture for ${ev}`);
    const res = transition(issue({ status: from }), event, CFG);
    if (to === null) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain(from);
    } else {
      expect(res).toMatchObject({ ok: true, next: { status: to } });
    }
  });
});

describe('transition: attempt counting (ADR 7)', () => {
  it('a counted failure with attempts left returns to open and increments attemptCount', () => {
    const res = transition(
      issue({ status: 'in_progress', attemptCount: 0 }),
      { type: 'attempt_failed', reason: 'tests failed' },
      CFG,
    );
    expect(res).toMatchObject({
      ok: true,
      next: { status: 'open', attemptCount: 1, failureReason: 'tests failed' },
    });
  });

  it('the second-to-last counted failure still returns to open', () => {
    const res = transition(
      issue({ status: 'in_review', attemptCount: 1 }),
      { type: 'attempt_failed', reason: 'rejected' },
      CFG,
    );
    expect(res).toMatchObject({ ok: true, next: { status: 'open', attemptCount: 2 } });
  });

  it.each(['in_progress', 'in_review'] as const)(
    'the last counted failure from %s goes to failed',
    (from) => {
      const res = transition(
        issue({ status: from, attemptCount: 2 }),
        { type: 'attempt_failed', reason: 'conflict in src/a.ts' },
        CFG,
      );
      expect(res).toMatchObject({
        ok: true,
        next: { status: 'failed', attemptCount: 3, failureReason: 'conflict in src/a.ts' },
      });
    },
  );

  it('maxAttempts 1 fails on the first counted failure', () => {
    const res = transition(
      issue({ status: 'in_progress' }),
      { type: 'attempt_failed', reason: 'x' },
      { maxAttempts: 1 },
    );
    expect(res).toMatchObject({ ok: true, next: { status: 'failed', attemptCount: 1 } });
  });

  it('an attemptCount already past a lowered maxAttempts still goes to failed', () => {
    const res = transition(
      issue({ status: 'in_progress', attemptCount: 4 }),
      { type: 'attempt_failed', reason: 'x' },
      CFG,
    );
    expect(res).toMatchObject({ ok: true, next: { status: 'failed', attemptCount: 5 } });
  });

  it.each(['in_progress', 'in_review'] as const)(
    'an interruption from %s returns to open without counting, even on the last attempt',
    (from) => {
      const res = transition(
        issue({ status: from, attemptCount: 2 }),
        { type: 'interrupted', reason: 'rate_limited' },
        CFG,
      );
      expect(res).toMatchObject({ ok: true, next: { status: 'open', attemptCount: 2 } });
    },
  );

  it('an interruption may defer the next start via runAfter', () => {
    const res = transition(
      issue({ status: 'in_progress', runAfter: 0 }),
      { type: 'interrupted', reason: 'rate_limited', runAfter: 5_000 },
      CFG,
    );
    expect(res).toMatchObject({ ok: true, next: { status: 'open', runAfter: 5_000 } });
  });

  it('a counted failure may defer the next start via runAfter', () => {
    const res = transition(
      issue({ status: 'in_progress' }),
      { type: 'attempt_failed', reason: 'x', runAfter: 7 },
      CFG,
    );
    expect(res).toMatchObject({ ok: true, next: { status: 'open', runAfter: 7 } });
  });

  it('rewrite resets attemptCount, clears failureReason, replaces the body and bumps rev', () => {
    const res = transition(
      issue({ status: 'failed', attemptCount: 3, rev: 2, failureReason: 'boom' }),
      { type: 'rewrite', body: 'smaller scope' },
      CFG,
    );
    expect(res).toMatchObject({
      ok: true,
      next: {
        status: 'open',
        attemptCount: 0,
        failureReason: null,
        body: 'smaller scope',
        rev: 3,
      },
    });
  });

  it('start and checks_passed keep attemptCount', () => {
    const started = transition(issue({ attemptCount: 1 }), { type: 'start' }, CFG);
    expect(started).toMatchObject({ ok: true, next: { status: 'in_progress', attemptCount: 1 } });
    const reviewed = transition(
      issue({ status: 'in_progress', attemptCount: 1 }),
      { type: 'checks_passed' },
      CFG,
    );
    expect(reviewed).toMatchObject({ ok: true, next: { status: 'in_review', attemptCount: 1 } });
  });

  it('merged records mergedOrder and mergeSha', () => {
    const res = transition(
      issue({ status: 'in_review' }),
      { type: 'merged', mergedOrder: 4, mergeSha: SHA },
      CFG,
    );
    expect(res).toMatchObject({
      ok: true,
      next: { status: 'completed', mergedOrder: 4, mergeSha: SHA },
    });
  });

  it('does not mutate the input issue', () => {
    const before = issue({ status: 'in_progress', attemptCount: 1 });
    const copy = structuredClone(before);
    transition(before, { type: 'attempt_failed', reason: 'x' }, CFG);
    expect(before).toEqual(copy);
  });

  it('rejects a non-positive maxAttempts as an illegal config', () => {
    const res = transition(
      issue({ status: 'in_progress' }),
      { type: 'attempt_failed', reason: 'x' },
      { maxAttempts: 0 },
    );
    expect(res.ok).toBe(false);
  });
});

describe('isReady', () => {
  const NOW = 1_000;
  const dep = (id: string, status: IssueStatus) => issue({ id: id as IssueId, number: 2, status });
  const byId = (...issues: IssueView[]) => new Map(issues.map((i) => [i.id, i]));

  it('an open, unheld issue with no deps and runAfter in the past is ready', () => {
    expect(isReady(issue({ runAfter: NOW - 1 }), byId(), NOW)).toBe(true);
  });

  it('runAfter exactly now is ready; in the future is not', () => {
    expect(isReady(issue({ runAfter: NOW }), byId(), NOW)).toBe(true);
    expect(isReady(issue({ runAfter: NOW + 1 }), byId(), NOW)).toBe(false);
  });

  it.each(ISSUE_STATUSES.filter((s) => s !== 'open'))('a %s issue is not ready', (status) => {
    expect(isReady(issue({ status }), byId(), NOW)).toBe(false);
  });

  it('a held issue is not ready', () => {
    expect(isReady(issue({ heldQuestionId: 'Q1' as QuestionId }), byId(), NOW)).toBe(false);
  });

  it('is ready only when every dependency is completed', () => {
    const a = dep('A', 'completed');
    const b = dep('B', 'completed');
    const subject = issue({ dependsOn: [a.id, b.id] });
    expect(isReady(subject, byId(a, b), NOW)).toBe(true);
  });

  it.each(ISSUE_STATUSES.filter((s) => s !== 'completed'))(
    'a dependency in %s blocks readiness',
    (status) => {
      const a = dep('A', 'completed');
      const b = dep('B', status);
      expect(isReady(issue({ dependsOn: [a.id, b.id] }), byId(a, b), NOW)).toBe(false);
    },
  );

  it('an unknown dependency blocks readiness', () => {
    expect(isReady(issue({ dependsOn: ['ZZZ' as IssueId] }), byId(), NOW)).toBe(false);
  });

  it('accepts a plain record keyed by id', () => {
    const a = dep('A', 'completed');
    expect(isReady(issue({ dependsOn: [a.id] }), { [a.id]: a }, NOW)).toBe(true);
    expect(isReady(issue({ dependsOn: [a.id] }), {}, NOW)).toBe(false);
  });
});

describe('slotsFree', () => {
  it.each([
    { running: 0, max: 3, free: 3 },
    { running: 2, max: 3, free: 1 },
    { running: 3, max: 3, free: 0 },
    { running: 5, max: 3, free: 0 },
    { running: 0, max: 0, free: 0 },
  ])('$running running of $max → $free free', ({ running, max, free }) => {
    expect(slotsFree(running, max)).toBe(free);
  });
});
