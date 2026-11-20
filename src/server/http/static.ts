import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

/**
 * Serves the built SPA from `webRoot` (when it exists), with index.html as the fallback for
 * client-side routes. /api paths never fall back, so unknown API routes stay JSON 404s.
 */
export function serveSpa(app: Hono, webRoot: string | undefined): void {
  if (webRoot === undefined || !existsSync(webRoot)) return;
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next();
    return serveStatic({ root: webRoot })(c, next);
  });
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next();
    return serveStatic({ root: webRoot, path: 'index.html' })(c, next);
  });
}
