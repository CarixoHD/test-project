import { useEffect, useState } from 'react';
import { ClaudeLoginResponseSchema, type ClaudeLoginResponse } from '../../../shared/dto.ts';
import { ApiError, request } from '../../state/api.ts';

export interface ClaudeLoginView {
  commands: ClaudeLoginResponse | null;
  /** Why loading failed; null while loading or once loaded. */
  error: string | null;
}

/**
 * GET /api/backends/claude-code/login: the setup commands the server builds for its own
 * uid:gid and the current `vibecode/claude-code:<hash>` image (ADR 4).
 */
export function useClaudeLogin(): ClaudeLoginView {
  const [view, setView] = useState<ClaudeLoginView>({ commands: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    request('/api/backends/claude-code/login', {
      schema: ClaudeLoginResponseSchema,
      signal: controller.signal,
    }).then(
      (commands) => setView({ commands, error: null }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const why = err instanceof ApiError ? err.message : 'Could not reach Vibecode.';
        setView({ commands: null, error: `Could not load the setup commands: ${why}` });
      },
    );
    return () => controller.abort();
  }, []);
  return view;
}
