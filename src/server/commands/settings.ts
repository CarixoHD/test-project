import type { z } from 'zod';
import { PriceOverridesSchema, type PriceOverrides } from '../../shared/budget.ts';
import {
  SettingsUpdateRequestSchema,
  type ProviderView,
  type SettingsResponse,
  type SettingsUpdateRequest,
} from '../../shared/dto.ts';
import type { Event, SettingsSection } from '../../shared/events.ts';
import {
  KEYED_PROVIDER_IDS,
  ModelRefSchema,
  RoleModelsSchema,
  type KeyedProviderId,
  type ModelDefaults,
  type ModelRef,
  type RoleModels,
} from '../../shared/models.ts';
import type { Db } from '../db/index.ts';
import {
  API_KEY_SECRETS,
  ProviderConfigSchema,
  type ModelDeps,
  type ProviderConfig,
} from '../llm/index.ts';
import type { Secrets } from '../security/index.ts';
import { deleteSetting, writeSetting, type Store } from '../store/index.ts';

// Account-wide settings (ARCHITECTURE §4.3 GET|PUT /api/settings, §4.10, ADR 9): provider
// config, write-only API keys, role defaults, the default model and price overrides.
// Non-secret values live in `settings`, keys in `secrets` under API_KEY_SECRETS names.
// Request/response shapes are the shared DTOs (SettingsUpdateRequest, SettingsResponse).

/** `settings` rows written here; `read()` feeds the shared resolveModel and price overrides. */
export const SETTING_KEYS = {
  /** ProviderConfig (no secrets). */
  providerConfig: 'providerConfig',
  /** RoleModels: per-role default model for every product. */
  roleDefaults: 'roleDefaults',
  /** ModelRef: used when neither the product nor the role defaults name a model. */
  defaultModel: 'defaultModel',
  /** PriceOverrides keyed by `priceKey(ref)`. */
  priceOverrides: 'priceOverrides',
} as const;

/** Providers the Settings page lists (`fake` is for tests and demo mode only). */
const PROVIDERS: readonly Pick<ProviderView, 'id' | 'name'>[] = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google Gemini' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'openai-compatible', name: 'OpenAI-compatible (Ollama, vLLM, …)' },
  { id: 'claude-code', name: 'Claude Code (subscription)' },
];

/** Non-secret settings, validated. */
export interface StoredSettings {
  providerConfig: ProviderConfig;
  roleDefaults: RoleModels;
  defaultModel: ModelRef | null;
  priceOverrides: PriceOverrides;
}

export interface AccountSettings {
  read(): StoredSettings;
  view(): SettingsResponse;
  update(input: SettingsUpdateRequest): { ok: true; events: Event[] };
  /**
   * Registry deps backed by the stored settings: `getSecret` reads `secrets` and
   * `providerConfig` reads `settings` each time model() asks, so changes apply to the next call.
   */
  modelDeps(): ModelDeps;
}

export interface AccountSettingsDeps {
  store: Store;
  /** The store's connection (reads outside commits). */
  db: Db;
  secrets: Secrets;
}

function readValidated<S extends z.ZodType>(store: Store, key: string, schema: S) {
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

// Validated readers of single `settings` rows: the one place that parses them. `read()` below
// and the pipeline (resolveModel, price overrides in runRecordedAgent) both use these.
// Each throws, naming the key, when its row is malformed.

export const readProviderConfig = (store: Store): ProviderConfig =>
  readValidated(store, SETTING_KEYS.providerConfig, ProviderConfigSchema) ?? {};

/** The account's model defaults, in the shape the shared `resolveModel` takes. */
export const readModelDefaults = (store: Store): ModelDefaults => ({
  roleDefaults: readValidated(store, SETTING_KEYS.roleDefaults, RoleModelsSchema) ?? {},
  defaultModel: readValidated(store, SETTING_KEYS.defaultModel, ModelRefSchema) ?? null,
});

export const readPriceOverrides = (store: Store): PriceOverrides =>
  readValidated(store, SETTING_KEYS.priceOverrides, PriceOverridesSchema) ?? {};

export function createAccountSettings({ store, secrets }: AccountSettingsDeps): AccountSettings {
  const read = (): StoredSettings => ({
    providerConfig: readProviderConfig(store),
    ...readModelDefaults(store),
    priceOverrides: readPriceOverrides(store),
  });

  const view = (): SettingsResponse => {
    const stored = read();
    const last4BySecret = new Map(secrets.list().map((s) => [s.key, s.last4]));
    const keys = KEYED_PROVIDER_IDS.flatMap((provider) => {
      const secretKey = API_KEY_SECRETS[provider];
      return last4BySecret.has(secretKey)
        ? [{ provider, last4: last4BySecret.get(secretKey) ?? null }]
        : [];
    });
    const hasKey = new Set<string>(keys.map((k) => k.provider));
    const { openaiCompatible, openrouter } = stored.providerConfig;
    const providers = PROVIDERS.map(({ id, name }): ProviderView => {
      switch (id) {
        case 'openai-compatible':
          return {
            id,
            name,
            enabled: openaiCompatible !== undefined,
            needsKey: false,
            baseURL: openaiCompatible?.baseURL ?? null,
          };
        case 'claude-code':
          return { id, name, enabled: true, needsKey: false, baseURL: null };
        default:
          return {
            id,
            name,
            enabled: hasKey.has(id),
            needsKey: true,
            baseURL: id === 'openrouter' ? (openrouter?.baseURL ?? null) : null,
          };
      }
    });
    return { providers, ...stored, keys };
  };

  const update = (input: SettingsUpdateRequest): { ok: true; events: Event[] } => {
    const u = SettingsUpdateRequestSchema.parse(input);
    const events = store.commit((tx) => {
      const sections: SettingsSection[] = [];
      const keys: { provider: KeyedProviderId; set: boolean }[] = [];
      if (u.providerConfig !== undefined) {
        writeSetting(tx.db, SETTING_KEYS.providerConfig, u.providerConfig);
        sections.push('providerConfig');
      }
      if (u.keys !== undefined) {
        for (const provider of KEYED_PROVIDER_IDS) {
          const value = u.keys[provider];
          if (value === undefined) continue;
          // Same connection as the commit: the secret write joins this transaction.
          if (value === null) secrets.delete(API_KEY_SECRETS[provider]);
          else secrets.set(API_KEY_SECRETS[provider], value);
          keys.push({ provider, set: value !== null });
        }
        if (keys.length > 0) sections.push('keys');
      }
      if (u.roleDefaults !== undefined) {
        writeSetting(tx.db, SETTING_KEYS.roleDefaults, u.roleDefaults);
        sections.push('roleDefaults');
      }
      if (u.defaultModel !== undefined) {
        if (u.defaultModel === null) deleteSetting(tx.db, SETTING_KEYS.defaultModel);
        else writeSetting(tx.db, SETTING_KEYS.defaultModel, u.defaultModel);
        sections.push('defaultModel');
      }
      if (u.priceOverrides !== undefined) {
        writeSetting(tx.db, SETTING_KEYS.priceOverrides, u.priceOverrides);
        sections.push('priceOverrides');
      }
      if (sections.length === 0) return [];
      return [
        {
          type: 'settings.changed',
          productId: null,
          entityId: null,
          v: 1,
          data: { sections, keys },
        },
      ];
    });
    return { ok: true, events };
  };

  const modelDeps = (): ModelDeps => ({
    getSecret: (key) => secrets.get(key),
    get providerConfig() {
      return readProviderConfig(store);
    },
  });

  return { read, view, update, modelDeps };
}
