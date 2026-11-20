import { z } from 'zod';

export const ROLES = ['sparring', 'orchestrator', 'implementer', 'reviewer', 'utility'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** `claude-code` selects the CLI subscription backend; `fake` is the scripted test/demo provider. */
export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'openai-compatible',
  'fake',
  'claude-code',
] as const;
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ModelRefSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

/** Per-role model choice; roles without an entry use the global default. */
export const RoleModelsSchema = z.partialRecord(RoleSchema, ModelRefSchema);
export type RoleModels = z.infer<typeof RoleModelsSchema>;

/** Account-wide model settings (GET|PUT /api/settings). */
export type ModelDefaults = { roleDefaults: RoleModels; defaultModel: ModelRef | null };

/**
 * The model a `role` runs on: the product's own choice, then the account's role default, then
 * the account's default model. `undefined`: nothing configured (the caller decides, e.g. the
 * fake model in demo mode or "Choose a model in Settings").
 */
export function resolveModel(
  role: Role,
  productModels: RoleModels,
  defaults: ModelDefaults,
): ModelRef | undefined {
  const ref = productModels[role] ?? defaults.roleDefaults[role] ?? defaults.defaultModel;
  return ref === null || ref === undefined ? undefined : { ...ref };
}

/** Providers that take an API key (stored under `API_KEY_SECRETS` in server/llm). */
export const KEYED_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'openai-compatible',
] as const satisfies readonly ProviderId[];
export type KeyedProviderId = (typeof KEYED_PROVIDER_IDS)[number];

/** Non-secret provider settings (stored in `settings`; validated by the LLM registry). */
export const ProviderConfigSchema = z.strictObject({
  openaiCompatible: z.strictObject({ baseURL: z.url() }).optional(),
  openrouter: z.strictObject({ baseURL: z.url() }).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
