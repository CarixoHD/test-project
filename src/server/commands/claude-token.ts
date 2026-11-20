import { ClaudeCodeTokenUpdateRequestSchema, type ClaudeCodeTokenView } from '../../shared/dto.ts';
import { CLAUDE_CODE_TOKEN_SECRET, type Secrets } from '../security/index.ts';
import type { Store } from '../store/index.ts';
import { clearBackendLimit } from './backend-limits.ts';

// Owner command: the Claude subscription token from `claude setup-token` (ADR 13, ARCHITECTURE
// §4.3 GET|PUT /api/backends/claude-code/token). Write-only: it lives in `secrets` (registered
// with the redactor), never in events or state, and reads show at most its last 4 characters.
// Only the Claude Code backend reads the value, to hand it to the CLI as CLAUDE_CODE_OAUTH_TOKEN.

export type ClaudeCodeTokenResult =
  { ok: true; view: ClaudeCodeTokenView } | { ok: false; code: 'invalid'; reason: string };

export interface ClaudeCodeToken {
  view(): ClaudeCodeTokenView;
  /**
   * `input` is validated with ClaudeCodeTokenUpdateRequestSchema; a string sets, null removes.
   * Setting a token also clears an active claude-code limit (needs_login), as "I've logged in".
   */
  update(input: unknown): ClaudeCodeTokenResult;
}

export interface ClaudeCodeTokenDeps {
  store: Store;
  secrets: Pick<Secrets, 'set' | 'delete' | 'list'>;
}

export function createClaudeCodeToken({ store, secrets }: ClaudeCodeTokenDeps): ClaudeCodeToken {
  const view = (): ClaudeCodeTokenView => {
    const info = secrets.list().find((s) => s.key === CLAUDE_CODE_TOKEN_SECRET);
    return { set: info !== undefined, last4: info?.last4 ?? null };
  };
  return {
    view,
    update(input) {
      const parsed = ClaudeCodeTokenUpdateRequestSchema.safeParse(input);
      if (!parsed.success) {
        // Messages only: zod issues may carry the rejected value.
        const reason = parsed.error.issues.map((i) => i.message).join('; ');
        return { ok: false, code: 'invalid', reason };
      }
      const { token } = parsed.data;
      if (token === null) {
        secrets.delete(CLAUDE_CODE_TOKEN_SECRET);
      } else {
        secrets.set(CLAUDE_CODE_TOKEN_SECRET, token);
        clearBackendLimit({ store }, 'claude-code');
      }
      return { ok: true, view: view() };
    },
  };
}
