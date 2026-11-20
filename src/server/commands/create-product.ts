import { CreateProductRequestSchema, type CreateProductRequest } from '../../shared/dto.ts';
import type { ProductSettings } from '../../shared/domain.ts';
import type { ProductId } from '../../shared/ids.ts';
import type { Git } from '../git/index.ts';
import type { CommandDeps } from './apply-plan.ts';

// Owner command: create a product (ARCHITECTURE §6 flow 1). The bare repo is created before the
// event is committed, so a failed repo init leaves no product behind (at worst an unused repo).

export type CreateProductDeps = CommandDeps & { git: Pick<Git, 'initRepo'> };

export type CreateProductResult = { ok: true; id: ProductId } | { ok: false; reason: string };

/** Settings of a new product; the owner changes them later in the Settings tab. */
export const DEFAULT_PRODUCT_SETTINGS: ProductSettings = {
  budgetUsd: null,
  maxParallel: 3,
  maxAttempts: 3,
  models: {},
  gitRemote: null,
};

export async function createProduct(
  deps: CreateProductDeps,
  input: CreateProductRequest,
): Promise<CreateProductResult> {
  const parsed = CreateProductRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const { name, idea } = parsed.data;
  const id = deps.ids.next('product');
  await deps.git.initRepo(id);
  deps.store.commit(() => [
    {
      type: 'product.created',
      productId: id,
      entityId: null,
      v: 1,
      data: { name, idea, ...DEFAULT_PRODUCT_SETTINGS },
    },
  ]);
  return { ok: true, id };
}
