import type { ProductSettings } from '../../shared/domain.ts';
import {
  ProductSettingsUpdateRequestSchema,
  type ProductSettingsUpdateRequest,
} from '../../shared/dto.ts';
import type { Event } from '../../shared/events.ts';
import type { ProductId } from '../../shared/ids.ts';
import { ROLES, type RoleModels } from '../../shared/models.ts';
import type { CommandDeps } from './apply-plan.ts';
import { budgetDrafts, clearsBudgetWarning } from './budget.ts';

// Owner command: change a product's budget, parallelism, attempts, model overrides or git
// remote (ARCHITECTURE §4.3 PATCH /api/products/:id/settings) → product.settings_changed.
// A budget change is checked in the same commit: back under 80 % clears the warning
// (budgetWarned:false), at 80 % / 100 % of the new budget it warns / pauses (§6 flow 5).

export type UpdateProductSettingsResult =
  { ok: true; events: Event[] } | { ok: false; reason: string; code: 'invalid' | 'not_found' };

type SettingsChange = Partial<ProductSettings> & { budgetWarned?: false };

/** The new per-role models: given roles replace the current entry, null removes it. */
function mergeModels(
  current: RoleModels,
  patch: NonNullable<ProductSettingsUpdateRequest['models']>,
): RoleModels {
  const next: RoleModels = {};
  for (const role of ROLES) {
    const ref = role in patch ? patch[role] : current[role];
    if (ref !== null && ref !== undefined) next[role] = { ...ref };
  }
  return next;
}

export function updateProductSettings(
  deps: CommandDeps,
  productId: ProductId,
  input: ProductSettingsUpdateRequest,
): UpdateProductSettingsResult {
  const parsed = ProductSettingsUpdateRequestSchema.safeParse(input);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return { ok: false, code: 'invalid', reason };
  }
  const { models, ...rest } = parsed.data;

  let found = false;
  const events = deps.store.commit((tx) => {
    const product = tx.q.product(productId);
    if (product === null) return [];
    found = true;
    const change: SettingsChange = {};
    if (rest.budgetUsd !== undefined) change.budgetUsd = rest.budgetUsd;
    if (rest.maxParallel !== undefined) change.maxParallel = rest.maxParallel;
    if (rest.maxAttempts !== undefined) change.maxAttempts = rest.maxAttempts;
    if (rest.gitRemote !== undefined) change.gitRemote = rest.gitRemote;
    if (models !== undefined) change.models = mergeModels(product.settings.models, models);
    const spentUsd = tx.q.productUsage(productId).apiUsd;
    const budgetUsd =
      change.budgetUsd === undefined ? product.settings.budgetUsd : change.budgetUsd;
    if (clearsBudgetWarning(product, spentUsd, budgetUsd)) change.budgetWarned = false;
    const budgetWarned = change.budgetWarned ?? product.budgetWarned;
    return [
      { type: 'product.settings_changed', productId, entityId: null, v: 1, data: change },
      ...budgetDrafts({ id: productId, paused: product.paused, budgetWarned, budgetUsd }, spentUsd),
    ];
  });
  if (!found) return { ok: false, code: 'not_found', reason: `No product ${productId}` };
  return { ok: true, events };
}
