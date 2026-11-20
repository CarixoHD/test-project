import type { EventDraft } from '../../shared/events.ts';
import type { IdGen, InboxId } from '../../shared/ids.ts';
import type { CommitHook } from '../store/index.ts';
import { inboxFor, inboxReadsFor, type InboxRuleOptions } from './rules.ts';

export interface InboxHookDeps extends InboxRuleOptions {
  ids: IdGen;
}

/**
 * Store commit hook: every committed domain event that matches an inbox rule gets its
 * `inbox.created` event appended in the same transaction (ARCHITECTURE §3 notify/). Events
 * that settle existing items (a withdrawn question) get `inbox.read` for them instead.
 */
export function inboxHook({ ids, ...opts }: InboxHookDeps): CommitHook {
  return (committed, tx) => {
    const drafts: EventDraft[] = [];
    const read = new Set<InboxId>();
    for (const event of committed) {
      for (const id of inboxReadsFor(event, tx.q)) {
        if (read.has(id)) continue;
        read.add(id);
        const productId = tx.q.inboxItem(id)?.productId ?? null;
        drafts.push({ type: 'inbox.read', productId, entityId: id, v: 1, data: {} });
      }
      const item = inboxFor(event, tx.q, opts);
      if (item === null) continue;
      const { productId, ...data } = item;
      drafts.push({ type: 'inbox.created', productId, entityId: ids.next('inbox'), v: 1, data });
    }
    return drafts;
  };
}
