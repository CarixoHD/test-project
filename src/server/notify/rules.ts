import type { InboxKind } from '../../shared/domain.ts';
import type { EventDraft } from '../../shared/events.ts';
import type { IssueId, ProductId } from '../../shared/ids.ts';

// Inbox rules (ARCHITECTURE §3 notify/): which domain events deserve the owner's attention,
// and how the inbox item reads. Pure: names come from `lookup`, time zone from `opts`.

/** The inbox item a rule produces; the store hook wraps it into an `inbox.created` event. */
type DraftOf<T extends EventDraft['type']> = Extract<EventDraft, { type: T }>;

export interface InboxDraft {
  productId: ProductId | null;
  kind: InboxKind;
  title: string;
  body: string;
  link: string | null;
}

/** Read access to names used in titles (`store.q` satisfies it). */
export interface InboxLookup {
  product(id: ProductId): { name: string } | null;
  issue(id: IssueId): { number: number; title: string } | null;
}

export interface InboxRuleOptions {
  /** IANA zone for "until 14:05"; defaults to the host's zone. */
  timeZone?: string;
}

const BACKEND_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI-compatible provider',
  fake: 'Fake model',
};

const productLink = (productId: ProductId) => `/products/${productId}`;
const issueLink = (productId: ProductId, issueId: IssueId) =>
  `/products/${productId}/issues/${issueId}`;

function productName(lookup: InboxLookup, id: ProductId): string | null {
  return lookup.product(id)?.name ?? null;
}

function issueLabel(lookup: InboxLookup, id: IssueId): string {
  const issue = lookup.issue(id);
  return issue === null ? id : `#${String(issue.number)} ${issue.title}`;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function clockTime(ms: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(ms);
}

function questionAsked(e: DraftOf<'question.asked'>, lookup: InboxLookup): InboxDraft {
  const { issueId, text } = e.data;
  const name = productName(lookup, e.productId) ?? 'the product';
  return {
    productId: e.productId,
    kind: 'question',
    title:
      issueId === null ? `Question about ${name}` : `Question on ${issueLabel(lookup, issueId)}`,
    body: text,
    link: issueId === null ? productLink(e.productId) : issueLink(e.productId, issueId),
  };
}

function issueFailed(e: DraftOf<'issue.failed'>, lookup: InboxLookup): InboxDraft {
  const { attemptCount, reason } = e.data;
  const attempts = `${String(attemptCount)} attempt${attemptCount === 1 ? '' : 's'}`;
  return {
    productId: e.productId,
    kind: 'failed',
    title: `Issue ${issueLabel(lookup, e.entityId)} failed`,
    body: `Failed after ${attempts}: ${reason}`,
    link: issueLink(e.productId, e.entityId),
  };
}

function budgetWarned(e: DraftOf<'budget.warned'>, lookup: InboxLookup): InboxDraft {
  const { spentUsd, budgetUsd } = e.data;
  const pct = budgetUsd > 0 ? Math.floor((spentUsd / budgetUsd) * 100) : 100;
  return {
    productId: e.productId,
    kind: 'budget_warn',
    title: `${productName(lookup, e.productId) ?? 'Product'} has used ${String(pct)}% of its budget`,
    body: `${usd(spentUsd)} of ${usd(budgetUsd)} spent.`,
    link: productLink(e.productId),
  };
}

function backendLimited(e: DraftOf<'backend.limited'>, opts: InboxRuleOptions): InboxDraft {
  const { backend, until, needsLogin, reason } = e.data;
  const label = BACKEND_LABELS[backend] ?? backend;
  if (needsLogin) {
    return {
      productId: null,
      kind: 'auth_required',
      title: `${label} needs you to log in again`,
      body: reason,
      link: null,
    };
  }
  const suffix = until === null ? '' : ` until ${clockTime(until, opts.timeZone)}`;
  return {
    productId: null,
    kind: 'rate_limited',
    title: `${label} rate limited${suffix}`,
    body: reason,
    link: null,
  };
}

/** The inbox item for `event`, or null when the event does not concern the owner. */
export function inboxFor(
  event: EventDraft,
  lookup: InboxLookup,
  opts: InboxRuleOptions = {},
): InboxDraft | null {
  switch (event.type) {
    case 'question.asked':
      return questionAsked(event, lookup);
    case 'issue.failed':
      return issueFailed(event, lookup);
    case 'budget.warned':
      return budgetWarned(event, lookup);
    case 'product.paused':
      if (event.data.reason !== 'budget') return null;
      return {
        productId: event.productId,
        kind: 'budget_paused',
        title: `${productName(lookup, event.productId) ?? 'Product'} paused: budget exhausted`,
        body: 'Raise the budget in the product settings, then resume.',
        link: productLink(event.productId),
      };
    case 'backend.limited':
      return backendLimited(event, opts);
    case 'product.phase_changed':
      if (event.data.phase !== 'complete') return null;
      return {
        productId: event.productId,
        kind: 'complete',
        title: `${productName(lookup, event.productId) ?? 'Product'} is complete`,
        body: 'Every issue is merged to main.',
        link: productLink(event.productId),
      };
    default:
      return null;
  }
}
