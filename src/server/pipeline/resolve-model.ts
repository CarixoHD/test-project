import type { ProductId } from '../../shared/ids.ts';
import type { ModelRef, Role } from '../../shared/models.ts';
import type { Store } from '../store/index.ts';
import { readDefaultModel, readRoleDefaults } from './settings.ts';

export type ResolveModelResult = { ok: true; model: ModelRef } | { ok: false; reason: string };

/** The scripted provider used in demo mode when nothing is configured. */
export const DEMO_MODEL: ModelRef = { provider: 'fake', model: 'fake' };

/**
 * The model for `role` in `productId`: the product's own choice, then the role default from
 * settings, then the global default model, then the fake model in demo mode.
 */
export function resolveModel(
  store: Store,
  productId: ProductId,
  role: Role,
  opts: { demo?: boolean } = {},
): ResolveModelResult {
  const model =
    store.q.product(productId)?.settings.models[role] ??
    readRoleDefaults(store)[role] ??
    readDefaultModel(store) ??
    (opts.demo === true ? DEMO_MODEL : undefined);
  return model === undefined
    ? { ok: false, reason: 'Choose a model in Settings' }
    : { ok: true, model: { ...model } };
}
