import { Hono } from 'hono';
import type { AppDeps } from './deps.ts';
import { installErrorHandling } from './errors.ts';
import { registerRoutes } from './routes/index.ts';
import { serveSpa } from './static.ts';

/** The Hono app: error middleware, /api routes, then the SPA. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  installErrorHandling(app, deps.redactor);
  registerRoutes(app, deps);
  serveSpa(app, deps.webRoot);
  return app;
}
