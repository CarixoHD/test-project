import type { Hono } from 'hono';
import type { AppDeps } from '../deps.ts';
import { registerAgentRoutes } from './agents.ts';
import { registerAttemptRoutes } from './attempts.ts';
import { registerBackendRoutes } from './backends.ts';
import { registerEventRoutes } from './events.ts';
import { registerHealthRoutes } from './health.ts';
import { registerPreviewRoutes } from './preview.ts';
import { registerProductRoutes } from './products.ts';
import { registerProductSettingsRoutes } from './product-settings.ts';
import { registerIssueRoutes } from './issues.ts';
import { registerQuestionRoutes } from './questions.ts';
import { registerSettingsRoutes } from './settings.ts';
import { registerStateRoutes } from './state.ts';

export { HEARTBEAT_MS } from './events.ts';

/** Every /api route group, in registration order. Later issues append theirs here. */
export function registerRoutes(app: Hono, deps: AppDeps): void {
  registerHealthRoutes(app);
  registerStateRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerProductRoutes(app, deps);
  registerProductSettingsRoutes(app, deps);
  registerIssueRoutes(app, deps);
  registerQuestionRoutes(app, deps);
  registerBackendRoutes(app, deps);
  if (deps.settings !== undefined) registerSettingsRoutes(app, deps.settings);
  if (deps.previews !== undefined) registerPreviewRoutes(app, deps.previews);
  if (deps.logsDir !== undefined) registerAgentRoutes(app, deps, deps.logsDir);
  if (deps.artifactsDir !== undefined) registerAttemptRoutes(app, deps, deps.artifactsDir);
}
