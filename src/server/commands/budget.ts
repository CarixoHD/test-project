import { budgetLevel, type BudgetLevel } from '../../shared/budget.ts';
import type { Event, EventDraft } from '../../shared/events.ts';
import type { ProductId } from '../../shared/ids.ts';
import type { ProductState } from '../../shared/state.ts';
import type { CommandDeps } from './apply-plan.ts';

// Budget enforcement (ARCHITECTURE §6 flow 5, PRD Cost control). Only API spend counts:
// subscription usage has no USD cost and unpriced usage is flagged, never counted as $0.
// From 80 % the owner is warned once (budget.warned); from 100 % the product is paused
// with reason budget once. The scheduler's shouldStop() stops live runs after their step.

export type CheckBudgetResult =
  | {
      ok: true;
      level: BudgetLevel;
      /** API spend in USD (priced usage only). */
      spentUsd: number;
      /** Some API usage had no price: the real spend is higher than `spentUsd`. */
      unpriced: boolean;
      events: Event[];
    }
  | { ok: false; code: 'not_found'; reason: string };

type BudgetView = Pick<ProductState, 'id' | 'paused' | 'budgetWarned'> & {
  budgetUsd: number | null;
};

/** The warn/pause drafts a product at `spentUsd` still needs (none when already done). */
export function budgetDrafts(product: BudgetView, spentUsd: number): EventDraft[] {
  const { budgetUsd } = product;
  const level = budgetLevel(spentUsd, budgetUsd);
  if (budgetUsd === null || level === 'ok') return [];
  const scope = { productId: product.id, entityId: null, v: 1 } as const;
  const drafts: EventDraft[] = [];
  if (!product.budgetWarned) {
    drafts.push({ ...scope, type: 'budget.warned', data: { spentUsd, budgetUsd } });
  }
  // An owner pause stays as it is: resume is refused anyway while the budget is exhausted.
  if (level === 'exhausted' && !product.paused) {
    drafts.push({ ...scope, type: 'product.paused', data: { reason: 'budget' } });
  }
  return drafts;
}

/** Whether a budget change takes a warned product back under 80 % (re-arms the warning). */
export function clearsBudgetWarning(
  product: Pick<ProductState, 'budgetWarned'>,
  spentUsd: number,
  newBudgetUsd: number | null,
): boolean {
  return product.budgetWarned && budgetLevel(spentUsd, newBudgetUsd) === 'ok';
}

/** Run after every usage.recorded and after settings changes. */
export function checkBudget(deps: CommandDeps, productId: ProductId): CheckBudgetResult {
  let result: CheckBudgetResult = {
    ok: false,
    code: 'not_found',
    reason: `No product ${productId}`,
  };
  const events = deps.store.commit((tx) => {
    const product = tx.q.product(productId);
    if (product === null) return [];
    const { apiUsd, apiUnpriced } = tx.q.productUsage(productId);
    const { budgetUsd } = product.settings;
    result = {
      ok: true,
      level: budgetLevel(apiUsd, budgetUsd),
      spentUsd: apiUsd,
      unpriced: apiUnpriced,
      events: [],
    };
    return budgetDrafts({ ...product, budgetUsd }, apiUsd);
  });
  return result.ok ? { ...result, events } : result;
}

/** The agent-run `afterUsage` hook: checks the budget of the usage event's product. */
export function budgetAfterUsage(deps: CommandDeps): (event: { productId: ProductId }) => void {
  return (event) => {
    checkBudget(deps, event.productId);
  };
}
