import type { ProductId } from '../../shared/ids.ts';
import {
  resolveModel as resolveConfiguredModel,
  type ModelRef,
  type Role,
} from '../../shared/models.ts';
import { readModelDefaults } from '../commands/index.ts';
import type { Store } from '../store/index.ts';

export type ResolveModelResult = { ok: true; model: ModelRef } | { ok: false; reason: string };

/** The scripted provider used in demo mode when nothing is configured. */
export const DEMO_MODEL: ModelRef = { provider: 'fake', model: 'fake' };

/**
 * The model for `role` in `productId`: the shared precedence (product model, then the role
 * default from settings, then the global default model), then the fake model in demo mode.
 * Throws, naming the key, when a model setting is malformed.
 */
export function resolveModel(
  store: Store,
  productId: ProductId,
  role: Role,
  opts: { demo?: boolean } = {},
): ResolveModelResult {
  const productModels = store.q.product(productId)?.settings.models ?? {};
  const model =
    resolveConfiguredModel(role, productModels, readModelDefaults(store)) ??
    (opts.demo === true ? { ...DEMO_MODEL } : undefined);
  return model === undefined
    ? { ok: false, reason: 'Choose a model in Settings' }
    : { ok: true, model };
}
