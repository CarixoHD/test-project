import type { Hono } from 'hono';
import type { AppDeps } from '../deps.ts';
import { registerEventRoutes } from './events.ts';
import { registerHealthRoutes } from './health.ts';
import { registerIssueRoutes } from './issues.ts';
import { registerStateRoutes } from './state.ts';

export { HEARTBEAT_MS } from './events.ts';

/** Every /api route group, in registration order. Later issues append theirs here. */
export function registerRoutes(app: Hono, deps: AppDeps): void {
  registerHealthRoutes(app);
  registerStateRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerIssueRoutes(app, deps);
}
