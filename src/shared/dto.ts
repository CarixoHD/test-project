import { z } from 'zod';
import { PriceOverridesSchema } from './budget.ts';
import { IssueIdSchema } from './ids.ts';
import {
  KEYED_PROVIDER_IDS,
  ModelRefSchema,
  ProviderConfigSchema,
  ProviderIdSchema,
  RoleModelsSchema,
} from './models.ts';
import { ClientStateSchema } from './state-schema.ts';

// HTTP request/response bodies shared by server routes and `src/web/state/api.ts`
// (ARCHITECTURE §4.3). Each issue adds the DTOs its routes need.

/** `GET /api/state`: the snapshot plus the seq it is consistent with (SSE resumes after it). */
export const StateResponseSchema = z.object({
  state: ClientStateSchema,
  lastSeq: z.int().min(0),
});
export type StateResponse = z.infer<typeof StateResponseSchema>;

/** `POST /api/products/:id/issues`: the owner adds an issue. */
export const AddIssueRequestSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string(),
  dependsOn: z.array(IssueIdSchema).default([]),
  priority: z.int().optional(),
});
export type AddIssueRequest = z.infer<typeof AddIssueRequestSchema>;
export const AddIssueResponseSchema = z.object({
  ok: z.literal(true),
  issueId: IssueIdSchema,
  number: z.int().min(1),
});
export type AddIssueResponse = z.infer<typeof AddIssueResponseSchema>;

/** `PATCH /api/issues/:id`: `rev` is the revision the edit is based on (409 when stale). */
export const EditIssueRequestSchema = z.object({
  title: z.string().trim().min(1).optional(),
  body: z.string().optional(),
  dependsOn: z.array(IssueIdSchema).optional(),
  rev: z.int().min(1),
});
export type EditIssueRequest = z.infer<typeof EditIssueRequestSchema>;
export const EditIssueResponseSchema = z.object({ ok: z.literal(true), rev: z.int().min(1) });
export type EditIssueResponse = z.infer<typeof EditIssueResponseSchema>;

/** `POST /api/issues/:id/cancel` (and other plain command acknowledgements). */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

// ---- account settings (GET|PUT /api/settings) ---------------------------------------------

/**
 * Shortest API key accepted. Must be at least the server redactor's MIN_SECRET_LENGTH, so
 * every stored key can be masked (asserted in the server's settings tests).
 */
export const API_KEY_MIN_LENGTH = 8;

/** A key is one token: no whitespace (multi-line secrets are not API keys). */
const ApiKeySchema = z
  .string()
  .min(API_KEY_MIN_LENGTH)
  .max(4096)
  .regex(/^\S+$/, 'An API key must not contain whitespace');

/** `PUT /api/settings`: every section optional; keys are set (string) or cleared (null). */
export const SettingsUpdateRequestSchema = z
  .strictObject({
    providerConfig: ProviderConfigSchema.optional(),
    keys: z.partialRecord(z.enum(KEYED_PROVIDER_IDS), ApiKeySchema.nullable()).optional(),
    roleDefaults: RoleModelsSchema.optional(),
    defaultModel: ModelRefSchema.nullable().optional(),
    priceOverrides: PriceOverridesSchema.optional(),
  })
  .refine((u) => Object.keys(u).length > 0, 'Nothing to update');
export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequestSchema>;

export const ProviderViewSchema = z.object({
  id: ProviderIdSchema.exclude(['fake']),
  name: z.string(),
  /** Usable as configured: key set, or base URL set (openai-compatible); claude-code always. */
  enabled: z.boolean(),
  needsKey: z.boolean(),
  /** Configured base URL (openai-compatible, openrouter override), else null. */
  baseURL: z.string().nullable(),
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;

/** `GET /api/settings`. Keys appear only as provider + last 4 characters (null under 16 chars). */
export const SettingsResponseSchema = z.object({
  providers: z.array(ProviderViewSchema),
  providerConfig: ProviderConfigSchema,
  keys: z.array(
    z.strictObject({
      provider: z.enum(KEYED_PROVIDER_IDS),
      last4: z.string().length(4).nullable(),
    }),
  ),
  roleDefaults: RoleModelsSchema,
  defaultModel: ModelRefSchema.nullable(),
  priceOverrides: PriceOverridesSchema,
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

/** `PUT /api/settings`: the settings after the update. */
export const SettingsUpdateResponseSchema = SettingsResponseSchema.extend({ ok: z.literal(true) });
export type SettingsUpdateResponse = z.infer<typeof SettingsUpdateResponseSchema>;
