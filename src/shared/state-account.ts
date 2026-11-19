import type { EventOf } from './events.ts';
import type {
  ClientState,
  InboxItem,
  QuestionState,
  TokenCounts,
  UsageTotals,
} from './state-schema.ts';
import { patch, without } from './state-records.ts';

// Reducers for accounting and account-wide events: usage totals, questions, inbox and
// backend limits.
type UsageRecorded = EventOf<'usage.recorded'>['data'];

const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

const EMPTY_USAGE_TOTALS: UsageTotals = {
  apiUsd: 0,
  apiUnpriced: false,
  subscriptionTokens: ZERO_TOKENS,
  subscriptionCalls: 0,
};

function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

/**
 * Adds one usage row to running totals. API usage adds USD (or sets `apiUnpriced` when the
 * price is unknown, never counting it as $0); subscription usage adds tokens and calls only,
 * its `estCostUsd` is informational and never counted.
 */
function addUsage(t: UsageTotals | undefined, u: UsageRecorded): UsageTotals {
  const cur = t ?? EMPTY_USAGE_TOTALS;
  if (u.billing === 'api') {
    return {
      ...cur,
      apiUsd: cur.apiUsd + (u.costUsd ?? 0),
      apiUnpriced: cur.apiUnpriced || u.unpriced,
    };
  }
  return {
    ...cur,
    subscriptionTokens: addTokens(cur.subscriptionTokens, u.tokens),
    subscriptionCalls: cur.subscriptionCalls + u.calls,
  };
}

function usageRecorded(s: ClientState, e: EventOf<'usage.recorded'>): ClientState {
  const { byProduct, byIssue } = s.usage;
  const issueId = e.data.issueId;
  return {
    ...s,
    usage: {
      byProduct: { ...byProduct, [e.productId]: addUsage(byProduct[e.productId], e.data) },
      byIssue:
        issueId === null ? byIssue : { ...byIssue, [issueId]: addUsage(byIssue[issueId], e.data) },
    },
  };
}

type AccountEvent = EventOf<
  | 'usage.recorded'
  | 'question.asked'
  | 'question.answered'
  | 'inbox.created'
  | 'inbox.read'
  | 'backend.limited'
  | 'backend.cleared'
>;

export function reduceAccountEvent(s: ClientState, e: AccountEvent): ClientState {
  switch (e.type) {
    case 'usage.recorded':
      return usageRecorded(s, e);
    case 'question.asked': {
      const asked: QuestionState = {
        id: e.entityId,
        productId: e.productId,
        ...e.data,
        answer: null,
        createdAt: e.ts,
        answeredAt: null,
      };
      return { ...s, questions: { ...s.questions, [e.entityId]: asked } };
    }
    case 'question.answered':
      return {
        ...s,
        questions: patch(s.questions, e.entityId, (q) => ({
          ...q,
          answer: e.data.answer,
          answeredAt: e.ts,
        })),
      };
    case 'inbox.created': {
      const item: InboxItem = {
        id: e.entityId,
        productId: e.productId,
        ...e.data,
        read: false,
        createdAt: e.ts,
      };
      return { ...s, inbox: { ...s.inbox, [e.entityId]: item } };
    }
    case 'inbox.read':
      return { ...s, inbox: patch(s.inbox, e.entityId, (i) => ({ ...i, read: true })) };
    case 'backend.limited':
      return { ...s, backendLimits: { ...s.backendLimits, [e.data.backend]: { ...e.data } } };
    case 'backend.cleared':
      return { ...s, backendLimits: without(s.backendLimits, e.data.backend) };
  }
}
