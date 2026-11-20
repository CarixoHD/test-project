import type { Hono } from 'hono';
import type { OkResponse, StartPreviewResponse } from '../../../shared/dto.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import type { Previews } from '../../sandbox/index.ts';
import { fail } from '../errors.ts';

/**
 * POST /api/products/:id/preview → 200 {url} once the preview answers (replaces a running one;
 * 409 without a preview config or when it fails to start, with the reason);
 * DELETE /api/products/:id/preview → 200 (409 when none is running).
 */
export function registerPreviewRoutes(app: Hono, previews: Previews): void {
  app.post('/api/products/:id/preview', async (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const result = await previews.startPreview(productId);
    if (!result.ok) fail(result);
    const body: StartPreviewResponse = { url: result.url };
    return c.json(body);
  });

  app.delete('/api/products/:id/preview', async (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const result = await previews.stopPreview(productId);
    if (!result.ok) fail(result);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });
}
