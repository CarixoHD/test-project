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
