import { budgetLevel } from '../../shared/budget.ts';
import type { Event } from '../../shared/events.ts';
import type { ProductId } from '../../shared/ids.ts';
import type { CommandDeps } from './apply-plan.ts';

// Owner commands: pause and resume a product's build (ARCHITECTURE §6 flow 5). The scheduler
// reads `paused` from the projection: it starts nothing and live runs see shouldStop().

export type PauseCommandResult =
  { ok: true; events: Event[] } | { ok: false; reason: string; code: 'not_found' | 'conflict' };

type Outcome = { ok: true } | { ok: false; reason: string; code: 'not_found' | 'conflict' };

export function pauseProduct(deps: CommandDeps, productId: ProductId): PauseCommandResult {
  let outcome: Outcome = { ok: true };
  const events = deps.store.commit((tx) => {
    const product = tx.q.product(productId);
    if (product === null) {
      outcome = { ok: false, code: 'not_found', reason: `No product ${productId}` };
      return [];
    }
    if (product.paused) {
      outcome = { ok: false, code: 'conflict', reason: 'The product is already paused' };
      return [];
    }
    return [{ type: 'product.paused', productId, entityId: null, v: 1, data: { reason: 'owner' } }];
  });
  return outcome.ok ? { ok: true, events } : outcome;
}

/** Refused (conflict) while the budget is still exhausted: raise the budget first. */
export function resumeProduct(deps: CommandDeps, productId: ProductId): PauseCommandResult {
  let outcome: Outcome = { ok: true };
  const events = deps.store.commit((tx) => {
    const product = tx.q.product(productId);
    if (product === null) {
      outcome = { ok: false, code: 'not_found', reason: `No product ${productId}` };
      return [];
    }
    if (!product.paused) {
      outcome = { ok: false, code: 'conflict', reason: 'The product is not paused' };
      return [];
    }
    const spent = tx.q.productUsage(productId).apiUsd;
    if (budgetLevel(spent, product.settings.budgetUsd) === 'exhausted') {
      outcome = {
        ok: false,
        code: 'conflict',
        reason: 'The budget is exhausted; raise it in Settings before resuming',
      };
      return [];
    }
    return [{ type: 'product.resumed', productId, entityId: null, v: 1, data: {} }];
  });
  return outcome.ok ? { ok: true, events } : outcome;
}
