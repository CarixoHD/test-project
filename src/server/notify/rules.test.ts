import { describe, expect, it } from 'vitest';
import type { EventDraft } from '../../shared/events.ts';
import {
  AgentIdSchema,
  InboxIdSchema,
  IssueIdSchema,
  ProductIdSchema,
  QuestionIdSchema,
} from '../../shared/ids.ts';
import { inboxFor, type InboxLookup } from './index.ts';

const P = ProductIdSchema.parse('product-1');
const I = IssueIdSchema.parse('issue-1');
const Q = QuestionIdSchema.parse('question-1');
const A = AgentIdSchema.parse('agent-1');

const lookup: InboxLookup = {
  product: (id) => (id === P ? { name: 'Todo' } : null),
  issue: (id) => (id === I ? { number: 3, title: 'Login form' } : null),
};

// 2026-11-20 14:05 UTC
const UNTIL = Date.UTC(2026, 10, 20, 14, 5);

const productLink = `/products/${P}`;
const issueLink = `/products/${P}/issues/${I}`;

const cases: { name: string; draft: EventDraft; expected: object }[] = [
  {
    name: 'question.asked on an issue',
    draft: {
      type: 'question.asked',
      productId: P,
      entityId: Q,
      v: 1,
      data: { target: 'issue', issueId: I, agentId: A, text: 'Use OAuth?' },
    },
    expected: {
      productId: P,
      kind: 'question',
      title: 'Question on #3 Login form',
      body: 'Use OAuth?',
      link: issueLink,
    },
  },
  {
    name: 'question.asked to the orchestrator (links the product spec)',
    draft: {
      type: 'question.asked',
      productId: P,
      entityId: Q,
      v: 1,
      data: { target: 'orchestrator', issueId: null, agentId: null, text: 'Which DB?' },
    },
    expected: {
      productId: P,
      kind: 'question',
      title: 'Question about Todo',
      body: 'Which DB?',
      link: productLink,
    },
  },
  {
    name: 'issue.failed',
    draft: {
      type: 'issue.failed',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'in_review', attemptCount: 3, reason: 'checks failed' },
    },
    expected: {
      productId: P,
      kind: 'failed',
      title: 'Issue #3 Login form failed',
      body: 'Failed after 3 attempts: checks failed',
      link: issueLink,
    },
  },
  {
    name: 'budget.warned',
    draft: {
      type: 'budget.warned',
      productId: P,
      entityId: null,
      v: 1,
      data: { spentUsd: 8.5, budgetUsd: 10 },
    },
    expected: {
      productId: P,
      kind: 'budget_warn',
      title: 'Todo has used 85% of its budget',
      body: '$8.50 of $10.00 spent.',
      link: productLink,
    },
  },
  {
    name: 'product.paused{budget}',
    draft: {
      type: 'product.paused',
      productId: P,
      entityId: null,
      v: 1,
      data: { reason: 'budget' },
    },
    expected: {
      productId: P,
      kind: 'budget_paused',
      title: 'Todo paused: budget exhausted',
      body: 'Raise the budget in the product settings, then resume.',
      link: productLink,
    },
  },
  {
    name: 'backend.limited with a reset time',
    draft: {
      type: 'backend.limited',
      productId: null,
      entityId: null,
      v: 1,
      data: { backend: 'claude-code', until: UNTIL, needsLogin: false, reason: 'usage limit' },
    },
    expected: {
      productId: null,
      kind: 'rate_limited',
      title: 'Claude Code rate limited until 14:05',
      body: 'usage limit',
      link: null,
    },
  },
  {
    name: 'backend.limited without a reset time',
    draft: {
      type: 'backend.limited',
      productId: null,
      entityId: null,
      v: 1,
      data: { backend: 'anthropic', until: null, needsLogin: false, reason: '429' },
    },
    expected: {
      productId: null,
      kind: 'rate_limited',
      title: 'Anthropic rate limited',
      body: '429',
      link: null,
    },
  },
  {
    name: 'backend.limited needing login',
    draft: {
      type: 'backend.limited',
      productId: null,
      entityId: null,
      v: 1,
      data: { backend: 'claude-code', until: null, needsLogin: true, reason: 'Login expired' },
    },
    expected: {
      productId: null,
      kind: 'auth_required',
      title: 'Claude Code needs you to log in again',
      body: 'Login expired',
      link: null,
    },
  },
  {
    name: 'product.phase_changed{complete}',
    draft: {
      type: 'product.phase_changed',
      productId: P,
      entityId: null,
      v: 1,
      data: { phase: 'complete' },
    },
    expected: {
      productId: P,
      kind: 'complete',
      title: 'Todo is complete',
      body: 'Every issue is merged to main.',
      link: productLink,
    },
  },
];

const ignored: { name: string; draft: EventDraft }[] = [
  {
    name: 'product.paused{owner}',
    draft: {
      type: 'product.paused',
      productId: P,
      entityId: null,
      v: 1,
      data: { reason: 'owner' },
    },
  },
  {
    name: 'product.phase_changed{building}',
    draft: {
      type: 'product.phase_changed',
      productId: P,
      entityId: null,
      v: 1,
      data: { phase: 'building' },
    },
  },
  {
    name: 'question.answered',
    draft: { type: 'question.answered', productId: P, entityId: Q, v: 1, data: { answer: 'yes' } },
  },
  {
    name: 'backend.cleared',
    draft: {
      type: 'backend.cleared',
      productId: null,
      entityId: null,
      v: 1,
      data: { backend: 'claude-code' },
    },
  },
  {
    name: 'inbox.created (never recursive)',
    draft: {
      type: 'inbox.created',
      productId: P,
      entityId: InboxIdSchema.parse('inbox-1'),
      v: 1,
      data: { kind: 'error', title: 'x', body: '', link: null },
    },
  },
  {
    name: 'issue.cancelled',
    draft: {
      type: 'issue.cancelled',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'open', by: 'owner', reason: 'dup' },
    },
  },
];

describe('inboxFor', () => {
  it.each(cases)('$name → one inbox draft', ({ draft, expected }) => {
    expect(inboxFor(draft, lookup, { timeZone: 'UTC' })).toEqual(expected);
  });

  it.each(ignored)('$name → none', ({ draft }) => {
    expect(inboxFor(draft, lookup, { timeZone: 'UTC' })).toBeNull();
  });

  it('formats the reset time in the given time zone', () => {
    const draft = cases.find((c) => c.name === 'backend.limited with a reset time')?.draft;
    expect(inboxFor(draft as EventDraft, lookup, { timeZone: 'Europe/Berlin' })).toMatchObject({
      title: 'Claude Code rate limited until 15:05',
    });
  });

  it('falls back to ids when the lookup misses', () => {
    const empty: InboxLookup = { product: () => null, issue: () => null };
    const failed = cases.find((c) => c.name === 'issue.failed')?.draft as EventDraft;
    const paused = cases.find((c) => c.name === 'product.paused{budget}')?.draft as EventDraft;
    expect(inboxFor(failed, empty)).toMatchObject({ title: `Issue ${I} failed` });
    expect(inboxFor(paused, empty)).toMatchObject({ title: 'Product paused: budget exhausted' });
  });

  it('says "1 attempt" in the singular', () => {
    const draft: EventDraft = {
      type: 'issue.failed',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'in_progress', attemptCount: 1, reason: 'boom' },
    };
    expect(inboxFor(draft, lookup)).toMatchObject({ body: 'Failed after 1 attempt: boom' });
  });
});
