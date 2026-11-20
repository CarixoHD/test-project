import { z } from 'zod';
import { ProductIdSchema } from './ids.ts';
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
