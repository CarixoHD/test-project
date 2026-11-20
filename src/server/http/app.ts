import { Hono } from 'hono';
import { inboxRoutes } from '../notify/index.ts';
import { installAccessControl, registerAuthRoutes, remoteAddress } from './auth.ts';
import type { AppDeps } from './deps.ts';
import { installErrorHandling } from './errors.ts';
import { registerRoutes } from './routes/index.ts';
import { serveSpa } from './static.ts';

/** The Hono app: error middleware, access control, /api routes, then the SPA. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  installErrorHandling(app, deps.redactor);
  installAccessControl(app, deps.access);
  if (deps.access !== undefined) {
    registerAuthRoutes(app, deps.access, deps.clientKey ?? remoteAddress);
  }
  registerRoutes(app, deps);
  // notify/ owns its route group; its paths are absolute (`/api/inbox/...`).
  app.route('/', inboxRoutes({ store: deps.store }));
  serveSpa(app, deps.webRoot);
  return app;
}
