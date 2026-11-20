import type { Hono } from 'hono';
import type { ClaudeCodeTokenView, ClaudeLoginResponse, OkResponse } from '../../../shared/dto.ts';
import { ProviderIdSchema } from '../../../shared/models.ts';
import { clearBackendLimit } from '../../commands/index.ts';
import { readJson } from '../body.ts';
import type { AppDeps } from '../deps.ts';
import { fail } from '../errors.ts';

/**
 * GET /api/backends/claude-code/login: the one-time setup commands (ADR 4).
 * POST /api/backends/:backend/clear (ARCHITECTURE §4.3): the owner clears an account-wide
 * backend limit, e.g. Claude Code's needs_login after logging in again. Idempotent.
 * GET|PUT /api/backends/claude-code/token {token: string|null} (ADR 13): the Claude
 * subscription token. Write-only: responses are `{set, last4}`, never the token.
 */
export function registerBackendRoutes(
  app: Hono,
  { store, claudeLogin, claudeCodeToken }: AppDeps,
): void {
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

  if (claudeCodeToken !== undefined) {
    app.get('/api/backends/claude-code/token', (c) => {
      const body: ClaudeCodeTokenView = claudeCodeToken.view();
      return c.json(body);
    });

    app.put('/api/backends/claude-code/token', async (c) => {
      const r = claudeCodeToken.update(await readJson(c));
      if (!r.ok) fail(r);
      const body: ClaudeCodeTokenView = r.view;
      return c.json(body);
    });
  }
}
