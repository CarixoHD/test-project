import type { Hono } from 'hono';
import type { GitTokenView } from '../../../shared/dto.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import type { GitTokens } from '../../commands/index.ts';
import { readJson } from '../body.ts';
import { fail } from '../errors.ts';

/**
 * GET|PUT /api/products/:id/git-token {token: string|null}: the product's git remote token.
 * Write-only: responses are `{set, last4}`, never the token.
 */
export function registerGitTokenRoutes(app: Hono, gitTokens: GitTokens): void {
  app.get('/api/products/:id/git-token', (c) => {
    const r = gitTokens.view(ProductIdSchema.parse(c.req.param('id')));
    if (!r.ok) fail(r);
    const body: GitTokenView = r.view;
    return c.json(body);
  });

  app.put('/api/products/:id/git-token', async (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const r = gitTokens.update(productId, await readJson(c));
    if (!r.ok) fail(r);
    const body: GitTokenView = r.view;
    return c.json(body);
  });
}
