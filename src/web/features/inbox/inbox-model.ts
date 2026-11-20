import type { InboxKind } from '../../../shared/domain.ts';
import type { InboxItem, QuestionState } from '../../../shared/state.ts';

// Pure helpers for the inbox page, the nav badge and notifications (ARCHITECTURE §4.12).

/** Each kind as text, so the type of an item never depends on colour or icon alone. */
export const KIND_TEXT: Record<InboxKind, string> = {
  question: 'Question',
  failed: 'Issue failed',
  budget_warn: 'Budget warning',
  budget_paused: 'Paused: budget',
  rate_limited: 'Rate limited',
  auth_required: 'Login needed',
  replan: 'Plan updated',
  complete: 'Complete',
  error: 'Error',
};

type ById<T> = Readonly<Record<string, T>>;

/** Newest first; equal times fall back to the (time-ordered ULID) id, newest first. */
export function sortedItems(inbox: ById<InboxItem>): InboxItem[] {
  return Object.values(inbox).sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

export function unreadCount(inbox: ById<InboxItem>): number {
  let n = 0;
  for (const item of Object.values(inbox)) if (!item.read) n += 1;
  return n;
}

/** The nav link's accessible name: "Inbox", or "Inbox, 3 unread". */
export function inboxNavLabel(unread: number): string {
  return unread === 0 ? 'Inbox' : `Inbox, ${String(unread)} unread`;
}

/**
 * The question an inbox item is about. Inbox items carry no question id, but the inbox rule
 * creates a question's item in the same commit as `question.asked`: same product, same
 * timestamp, and the question text as the body.
 */
export function questionForItem(
  item: InboxItem,
  questions: ById<QuestionState>,
): QuestionState | undefined {
  if (item.kind !== 'question') return undefined;
  return Object.values(questions).find(
    (q) => q.productId === item.productId && q.createdAt === item.createdAt && q.text === item.body,
  );
}

export const formatInboxTime = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
