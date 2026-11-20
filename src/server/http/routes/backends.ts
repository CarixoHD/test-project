import type { Hono } from 'hono';
import type { ClaudeLoginResponse, OkResponse } from '../../../shared/dto.ts';
import { ProviderIdSchema } from '../../../shared/models.ts';
import { clearBackendLimit } from '../../commands/index.ts';
import type { AppDeps } from '../deps.ts';

/**
 * GET /api/backends/claude-code/login: the one-time setup commands (ADR 4).
 * POST /api/backends/:backend/clear (ARCHITECTURE §4.3): the owner clears an account-wide
 * backend limit, e.g. Claude Code's needs_login after logging in again. Idempotent.
 */
export function registerBackendRoutes(app: Hono, { store, claudeLogin }: AppDeps): void {
  app.post('/api/backends/:backend/clear', (c) => {
    const backend = ProviderIdSchema.parse(c.req.param('backend'));
    clearBackendLimit({ store }, backend);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  // The Settings page's Claude Code setup: the server knows its uid:gid and the image tag.
  if (claudeLogin !== undefined) {
    app.get('/api/backends/claude-code/login', async (c) => {
      const body: ClaudeLoginResponse = await claudeLogin.claudeLoginCommands();
      return c.json(body);
    });
  }
}
