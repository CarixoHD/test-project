import type { Context, Hono } from 'hono';
import { CreateProductRequestSchema, type CreateProductResponse } from '../../../shared/dto.ts';
import { createProduct } from '../../commands/index.ts';
import type { AppDeps } from '../deps.ts';
import { fail } from '../errors.ts';

/** Reads a JSON body; malformed JSON is the client's fault (400), not a server error. */
async function jsonBody(c: Context): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    return fail({ ok: false, reason: 'The request body must be valid JSON' });
  }
}

/** POST /api/products {name, idea} → 201 {id}. */
export function registerProductRoutes(app: Hono, deps: AppDeps): void {
  app.post('/api/products', async (c) => {
    const input = CreateProductRequestSchema.parse(await jsonBody(c));
    const result = await createProduct(deps, input);
    if (!result.ok) fail(result);
    const body: CreateProductResponse = { id: result.id };
    return c.json(body, 201);
  });
}
