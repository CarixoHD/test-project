import type { Hono } from 'hono';
import { ProductSettingsUpdateRequestSchema, type OkResponse } from '../../../shared/dto.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { updateProductSettings } from '../../commands/index.ts';
import type { AppDeps } from '../deps.ts';
import { readJson } from '../body.ts';
import { fail } from '../errors.ts';

/** PATCH /api/products/:id/settings {budgetUsd?, maxParallel?, maxAttempts?, models?, gitRemote?}. */
export function registerProductSettingsRoutes(app: Hono, { store, ids }: AppDeps): void {
  app.patch('/api/products/:id/settings', async (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const input = ProductSettingsUpdateRequestSchema.parse(await readJson(c));
    const r = updateProductSettings({ store, ids }, productId, input);
    if (!r.ok) fail(r);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });
}
