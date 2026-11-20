import type { z } from 'zod';
import { PriceOverridesSchema, type PriceOverrides } from '../../shared/budget.ts';
import {
  ModelRefSchema,
  RoleModelsSchema,
  type ModelRef,
  type RoleModels,
} from '../../shared/models.ts';
import type { Store } from '../store/index.ts';

/** Keys of the account-wide `settings` rows the pipeline reads (written by the settings API). */
export const SETTING_KEYS = {
  /** RoleModels: per-role default model for every product. */
  roleDefaults: 'roleDefaults',
  /** ModelRef: used when neither the product nor the role defaults name a model. */
  defaultModel: 'defaultModel',
  /** PriceOverrides keyed by `priceKey(ref)`. */
  priceOverrides: 'priceOverrides',
} as const;

function readSetting<S extends z.ZodType>(store: Store, key: string, schema: S) {
  const raw = store.q.setting(key);
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Setting ${key} is malformed: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  return parsed.data as z.infer<S>;
}

export const readRoleDefaults = (store: Store): RoleModels =>
  readSetting(store, SETTING_KEYS.roleDefaults, RoleModelsSchema) ?? {};

export const readDefaultModel = (store: Store): ModelRef | undefined =>
  readSetting(store, SETTING_KEYS.defaultModel, ModelRefSchema);

export const readPriceOverrides = (store: Store): PriceOverrides =>
  readSetting(store, SETTING_KEYS.priceOverrides, PriceOverridesSchema) ?? {};
