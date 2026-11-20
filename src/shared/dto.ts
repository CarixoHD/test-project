import { z } from 'zod';
import { ProductIdSchema } from './ids.ts';
import { IssueIdSchema } from './ids.ts';
import { ClientStateSchema } from './state-schema.ts';

// HTTP request/response bodies shared by server routes and `src/web/state/api.ts`
// (ARCHITECTURE §4.3). Each issue adds the DTOs its routes need.

/** `GET /api/state`: the snapshot plus the seq it is consistent with (SSE resumes after it). */
export const StateResponseSchema = z.object({
  state: ClientStateSchema,
  lastSeq: z.int().min(0),
});
export type StateResponse = z.infer<typeof StateResponseSchema>;

export const PRODUCT_NAME_MAX = 80;
export const PRODUCT_IDEA_MAX = 4000;

/** `POST /api/products`. Surrounding whitespace is trimmed before the length checks. */
export const CreateProductRequestSchema = z.object({
  name: z
    .string({ error: 'Name is required' })
    .trim()
    .min(1, 'Name is required')
    .max(PRODUCT_NAME_MAX, `Name must be at most ${PRODUCT_NAME_MAX} characters`),
  idea: z
    .string({ error: 'Idea is required' })
    .trim()
    .min(1, 'Idea is required')
    .max(PRODUCT_IDEA_MAX, `Idea must be at most ${PRODUCT_IDEA_MAX} characters`),
});
export type CreateProductRequest = z.input<typeof CreateProductRequestSchema>;

/** `201` answer of `POST /api/products`. */
export const CreateProductResponseSchema = z.object({ id: ProductIdSchema });
export type CreateProductResponse = z.infer<typeof CreateProductResponseSchema>;
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
