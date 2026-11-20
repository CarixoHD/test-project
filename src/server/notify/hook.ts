import type { EventDraft } from '../../shared/events.ts';
import type { IdGen } from '../../shared/ids.ts';
import type { CommitHook } from '../store/index.ts';
import { inboxFor, type InboxRuleOptions } from './rules.ts';

export interface InboxHookDeps extends InboxRuleOptions {
  ids: IdGen;
}

/**
 * Store commit hook: every committed domain event that matches an inbox rule gets its
 * `inbox.created` event appended in the same transaction (ARCHITECTURE §3 notify/).
 */
export function inboxHook({ ids, ...opts }: InboxHookDeps): CommitHook {
  return (committed, tx) => {
    const drafts: EventDraft[] = [];
    for (const event of committed) {
      const item = inboxFor(event, tx.q, opts);
      if (item === null) continue;
      const { productId, ...data } = item;
      drafts.push({ type: 'inbox.created', productId, entityId: ids.next('inbox'), v: 1, data });
    }
    return drafts;
  };
}
