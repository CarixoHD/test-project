import type { Hono } from 'hono';
import {
  CreateProductRequestSchema,
  type CreateProductResponse,
  SavePrdDraftRequestSchema,
  SparRequestSchema,
  type OkResponse,
} from '../../../shared/dto.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import {
  applyPrd,
  createProduct,
  handoff,
  pauseProduct,
  resumeProduct,
  savePrdDraft,
} from '../../commands/index.ts';
import type { AppDeps } from '../deps.ts';
import { readJson } from '../body.ts';
import { fail } from '../errors.ts';

/**
 * POST /api/products {name, idea} → 201 {id}; POST /api/products/:id/spar {message} → 202
 * (the reply arrives as events); PUT /api/products/:id/prd-draft {markdown};
 * POST /api/products/:id/handoff → 200 (409 outside sparring or with an empty draft);
 * POST /api/products/:id/apply-prd → 200 (409 before handoff or when the draft is unchanged);
 * POST /api/products/:id/pause | resume → 200 (409 when already in that state, or resuming
 * while the budget is exhausted).
 */
export function registerProductRoutes(app: Hono, deps: AppDeps): void {
  app.post('/api/products', async (c) => {
    const input = CreateProductRequestSchema.parse(await readJson(c));
    const result = await createProduct(deps, input);
    if (!result.ok) fail(result);
    const body: CreateProductResponse = { id: result.id };
    return c.json(body, 201);
  });

  app.post('/api/products/:id/spar', async (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const input = SparRequestSchema.parse(await readJson(c));
    if (deps.sparring === undefined) throw new Error('Sparring is not configured on this server');
    const result = deps.sparring.sendSparMessage(productId, input);
    if (!result.ok) fail(result);
    const body: OkResponse = { ok: true };
    return c.json(body, 202);
  });

  app.put('/api/products/:id/prd-draft', async (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const input = SavePrdDraftRequestSchema.parse(await readJson(c));
    const result = savePrdDraft(deps, productId, input);
    if (!result.ok) fail(result);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  app.post('/api/products/:id/handoff', async (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const result = await handoff(deps, productId);
    if (!result.ok) fail(result);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  app.post('/api/products/:id/apply-prd', async (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const result = await applyPrd(deps, productId);
    if (!result.ok) fail(result);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  app.post('/api/products/:id/pause', (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const result = pauseProduct(deps, productId);
    if (!result.ok) fail(result);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  app.post('/api/products/:id/resume', (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const result = resumeProduct(deps, productId);
    if (!result.ok) fail(result);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });
}
