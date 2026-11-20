import type { IssueStatus } from '../../shared/domain.ts';
import type { ProductId } from '../../shared/ids.ts';
import type { Store } from '../store/index.ts';

// Product completion (ARCHITECTURE §6 flow 9). The scheduler decides when nothing is pending
// (no triggers, no live runs); this module owns the issue rule and the commit.

/** At least one issue, and every issue that is not cancelled is completed. */
export function allIssuesDone(issues: readonly { status: IssueStatus }[]): boolean {
  const active = issues.filter((i) => i.status !== 'cancelled');
  return active.length > 0 && active.every((i) => i.status === 'completed');
}

/**
 * Commits `product.phase_changed{complete}` (the inbox hook adds the 'complete' item) when the
 * product is still building and all its issues are done; re-checked inside the commit so it
 * fires once. Returns whether it committed.
 */
export function completeProduct(store: Store, productId: ProductId): boolean {
  const events = store.commit((tx) => {
    const product = tx.q.product(productId);
    if (product?.phase !== 'building') return [];
    if (!allIssuesDone(tx.q.issuesByProduct(productId))) return [];
    return [
      {
        type: 'product.phase_changed',
        productId,
        entityId: null,
        v: 1,
        data: { phase: 'complete' },
      },
    ];
  });
  return events.length > 0;
}
