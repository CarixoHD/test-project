import { describe, expect, it } from 'vitest';
import type { Event } from './events.ts';
import {
  IssueIdSchema,
  ProductIdSchema,
  QuestionIdSchema,
  type ProductId,
  type QuestionId,
} from './ids.ts';
import { pendingTriggers, TRIGGER_TYPES, type QuestionTargets } from './triggers.ts';

const P = ProductIdSchema.parse('product-1');
const P2 = ProductIdSchema.parse('product-2');
const I1 = IssueIdSchema.parse('issue-1');
const QO = QuestionIdSchema.parse('question-orch');
const QI = QuestionIdSchema.parse('question-issue');
const QX = QuestionIdSchema.parse('question-unknown');

// Fixtures are plain objects in the catalogue's shape; the function only reads the envelope.
const at = (seq: number, e: object): Event => ({ ...e, seq, ts: 1_000 + seq, v: 1 }) as Event;

const handedOff = (seq: number, productId: ProductId = P) =>
  at(seq, {
    type: 'product.handed_off',
    productId,
    entityId: null,
    data: { prdVersion: 1 },
  });
const prdApplied = (seq: number) =>
  at(seq, {
    type: 'prd.applied',
    productId: P,
    entityId: null,
    data: { version: 2, markdown: '#', summary: null },
  });
const failed = (seq: number) =>
  at(seq, {
    type: 'issue.failed',
    productId: P,
    entityId: I1,
    data: { from: 'in_review', attemptCount: 3, reason: 'rejected' },
  });
const asked = (seq: number, id: QuestionId, target: 'orchestrator' | 'issue') =>
  at(seq, {
    type: 'question.asked',
    productId: P,
    entityId: id,
    data: { target, issueId: target === 'issue' ? I1 : null, agentId: null, text: 'why?' },
  });
const answered = (seq: number, id: QuestionId) =>
  at(seq, {
    type: 'question.answered',
    productId: P,
    entityId: id,
    data: { answer: 'because' },
  });
const created = (seq: number) =>
  at(seq, {
    type: 'issue.created',
    productId: P,
    entityId: I1,
    data: {},
  });
const cursorAdvanced = (seq: number) =>
  at(seq, {
    type: 'orchestrator.cursor_advanced',
    productId: P,
    entityId: null,
    data: { cursor: seq - 1 },
  });

const seqs = (events: Event[]) => events.map((e) => e.seq);

describe('pendingTriggers', () => {
  it('lists exactly the four trigger types', () => {
    expect([...TRIGGER_TYPES].sort()).toEqual(
      ['issue.failed', 'prd.applied', 'product.handed_off', 'question.answered'].sort(),
    );
  });

  const table: {
    name: string;
    events: Event[];
    cursor: number;
    questions?: QuestionTargets;
    want: number[];
  }[] = [
    { name: 'no events', events: [], cursor: 0, want: [] },
    { name: 'handed_off after the cursor', events: [handedOff(1)], cursor: 0, want: [1] },
    { name: 'prd.applied after the cursor', events: [prdApplied(4)], cursor: 3, want: [4] },
    { name: 'issue.failed after the cursor', events: [failed(9)], cursor: 2, want: [9] },
    {
      name: 'events at or before the cursor are consumed',
      events: [handedOff(1), prdApplied(2), failed(3), failed(4)],
      cursor: 3,
      want: [4],
    },
    {
      name: 'non-trigger types are ignored',
      events: [created(5), cursorAdvanced(6), asked(7, QO, 'orchestrator'), failed(8)],
      cursor: 0,
      want: [8],
    },
    {
      name: 'orchestrator question answered (asked in the same list, before the cursor)',
      events: [asked(2, QO, 'orchestrator'), answered(5, QO)],
      cursor: 3,
      want: [5],
    },
    {
      name: 'issue question answered is not a trigger',
      events: [asked(2, QI, 'issue'), answered(5, QI)],
      cursor: 0,
      want: [],
    },
    {
      name: 'question target from the lookup when the ask is not in the list',
      events: [answered(5, QO), answered(6, QI)],
      cursor: 0,
      questions: { [QO]: { target: 'orchestrator' }, [QI]: { target: 'issue' } },
      want: [5],
    },
    {
      name: 'question target from a Map lookup',
      events: [answered(5, QO)],
      cursor: 0,
      questions: new Map([[QO, { target: 'orchestrator' as const }]]),
      want: [5],
    },
    {
      name: 'answer to an unknown question is not a trigger',
      events: [answered(5, QX)],
      cursor: 0,
      want: [],
    },
    {
      name: 'result is in seq order even if the input is not',
      events: [failed(9), handedOff(1), prdApplied(4)],
      cursor: 0,
      want: [1, 4, 9],
    },
  ];

  it.each(table)('$name', ({ events, cursor, questions, want }) => {
    const opts = questions === undefined ? { productId: P } : { productId: P, questions };
    expect(seqs(pendingTriggers(events, cursor, opts))).toEqual(want);
  });

  it('only selects events of the given product', () => {
    const events = [handedOff(1, P2), handedOff(2, P), failed(3)];
    expect(seqs(pendingTriggers(events, 0, { productId: P }))).toEqual([2, 3]);
    expect(seqs(pendingTriggers(events, 0, { productId: P2 }))).toEqual([1]);
  });

  it('without a productId it considers every product', () => {
    expect(seqs(pendingTriggers([handedOff(1, P2), handedOff(2)], 0))).toEqual([1, 2]);
  });
});
