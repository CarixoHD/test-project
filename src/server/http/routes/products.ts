import type { Context, Hono } from 'hono';
import {
  CreateProductRequestSchema,
  type CreateProductResponse,
  SavePrdDraftRequestSchema,
  SparRequestSchema,
  type OkResponse,
} from '../../../shared/dto.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { createProduct, savePrdDraft } from '../../commands/index.ts';
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

/**
 * POST /api/products {name, idea} → 201 {id}; POST /api/products/:id/spar {message} → 202
 * (the reply arrives as events); PUT /api/products/:id/prd-draft {markdown}.
 */
export function registerProductRoutes(app: Hono, deps: AppDeps): void {
  app.post('/api/products', async (c) => {
    const input = CreateProductRequestSchema.parse(await jsonBody(c));
    const result = await createProduct(deps, input);
    if (!result.ok) fail(result);
    const body: CreateProductResponse = { id: result.id };
    return c.json(body, 201);
  });

  app.post('/api/products/:id/spar', async (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const input = SparRequestSchema.parse(await jsonBody(c));
    if (deps.sparring === undefined) throw new Error('Sparring is not configured on this server');
    const result = deps.sparring.sendSparMessage(productId, input);
    if (!result.ok) fail(result);
    const body: OkResponse = { ok: true };
    return c.json(body, 202);
  });

  app.put('/api/products/:id/prd-draft', async (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const input = SavePrdDraftRequestSchema.parse(await jsonBody(c));
    const result = savePrdDraft(deps, productId, input);
    if (!result.ok) fail(result);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });
}
