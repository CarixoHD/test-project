import { z } from 'zod';
import { PriceOverridesSchema, type PriceOverrides } from '../../shared/budget.ts';
import type { Event, SettingsSection } from '../../shared/events.ts';
import {
  ModelRefSchema,
  RoleModelsSchema,
  type ModelRef,
  type ProviderId,
  type RoleModels,
} from '../../shared/models.ts';
import type { Db } from '../db/index.ts';
import {
  API_KEY_SECRETS,
  ProviderConfigSchema,
  type ModelDeps,
  type ProviderConfig,
} from '../llm/index.ts';
import { MIN_SECRET_LENGTH, type Secrets } from '../security/index.ts';
import { deleteSetting, readSetting, writeSetting, type Store } from '../store/index.ts';

// Account-wide settings (ARCHITECTURE §4.3 GET|PUT /api/settings, §4.10, ADR 9): provider
// config, write-only API keys, role defaults, the default model and price overrides.
// Non-secret values live in `settings`, keys in `secrets` under API_KEY_SECRETS names.

/** `settings` rows written here. The pipeline's resolveModel and pricing read the same keys. */
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

export type KeyedProvider = keyof typeof API_KEY_SECRETS;
const KEYED_PROVIDERS = Object.keys(API_KEY_SECRETS) as [KeyedProvider, ...KeyedProvider[]];

/** Providers the Settings page lists (`fake` is for tests and demo mode only). */
const PROVIDERS: readonly { id: Exclude<ProviderId, 'fake'>; name: string }[] = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google Gemini' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'openai-compatible', name: 'OpenAI-compatible (Ollama, vLLM, …)' },
  { id: 'claude-code', name: 'Claude Code (subscription)' },
];

/**
 * A key is one token: no whitespace (multi-line secrets are not API keys) and at least
 * MIN_SECRET_LENGTH characters, so the redactor can mask it.
 */
const ApiKeySchema = z
  .string()
  .min(MIN_SECRET_LENGTH)
  .max(4096)
  .regex(/^\S+$/, 'An API key must not contain whitespace');

/** PUT /api/settings: every section optional; keys are set (string) or cleared (null). */
export const SettingsUpdateSchema = z
  .strictObject({
    providerConfig: ProviderConfigSchema.optional(),
    keys: z.partialRecord(z.enum(KEYED_PROVIDERS), ApiKeySchema.nullable()).optional(),
    roleDefaults: RoleModelsSchema.optional(),
    defaultModel: ModelRefSchema.nullable().optional(),
    priceOverrides: PriceOverridesSchema.optional(),
  })
  .refine((u) => Object.keys(u).length > 0, 'Nothing to update');
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

export interface ProviderView {
  id: Exclude<ProviderId, 'fake'>;
  name: string;
  /** Usable as configured: key set, or base URL set (openai-compatible); claude-code always. */
  enabled: boolean;
  needsKey: boolean;
  /** Configured base URL (openai-compatible, openrouter override), else null. */
  baseURL: string | null;
}

/** GET /api/settings. Keys appear only as provider + last 4 characters. */
export interface SettingsView {
  providers: ProviderView[];
  providerConfig: ProviderConfig;
  keys: { provider: KeyedProvider; last4: string | null }[];
  roleDefaults: RoleModels;
  defaultModel: ModelRef | null;
  priceOverrides: PriceOverrides;
}

/** Non-secret settings, validated. */
export interface StoredSettings {
  providerConfig: ProviderConfig;
  roleDefaults: RoleModels;
  defaultModel: ModelRef | null;
  priceOverrides: PriceOverrides;
}

export interface AccountSettings {
  read(): StoredSettings;
  view(): SettingsView;
  update(input: SettingsUpdate): { ok: true; events: Event[] };
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

function readValidated<S extends z.ZodType>(db: Db, key: string, schema: S) {
  const raw = readSetting(db, key);
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Setting ${key} is malformed: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  return parsed.data as z.infer<S>;
}

export function createAccountSettings({
  store,
  db,
  secrets,
}: AccountSettingsDeps): AccountSettings {
  const readProviderConfig = () =>
    readValidated(db, SETTING_KEYS.providerConfig, ProviderConfigSchema) ?? {};

  const read = (): StoredSettings => ({
    providerConfig: readProviderConfig(),
    roleDefaults: readValidated(db, SETTING_KEYS.roleDefaults, RoleModelsSchema) ?? {},
    defaultModel: readValidated(db, SETTING_KEYS.defaultModel, ModelRefSchema) ?? null,
    priceOverrides: readValidated(db, SETTING_KEYS.priceOverrides, PriceOverridesSchema) ?? {},
  });

  const view = (): SettingsView => {
    const stored = read();
    const last4BySecret = new Map(secrets.list().map((s) => [s.key, s.last4]));
    const keys = KEYED_PROVIDERS.flatMap((provider) => {
      const secretKey = API_KEY_SECRETS[provider];
      return last4BySecret.has(secretKey)
        ? [{ provider, last4: last4BySecret.get(secretKey) ?? null }]
        : [];
    });
    const hasKey = new Set<ProviderId>(keys.map((k) => k.provider));
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

  const update = (input: SettingsUpdate): { ok: true; events: Event[] } => {
    const u = SettingsUpdateSchema.parse(input);
    const events = store.commit((tx) => {
      const sections: SettingsSection[] = [];
      const keys: { provider: KeyedProvider; set: boolean }[] = [];
      if (u.providerConfig !== undefined) {
        writeSetting(tx.db, SETTING_KEYS.providerConfig, u.providerConfig);
        sections.push('providerConfig');
      }
      if (u.keys !== undefined) {
        for (const provider of KEYED_PROVIDERS) {
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
      return readProviderConfig();
    },
  });

  return { read, view, update, modelDeps };
}
