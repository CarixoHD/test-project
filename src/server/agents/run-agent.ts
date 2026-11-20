import { runApiBackend } from './api-backend.ts';
import { runClaudeCodeBackend } from './claude-code-backend.ts';
import type { AgentResult, AgentSpec } from './types.ts';

/**
 * Runs one agent to completion (docs/ARCHITECTURE.md §4.6). Never throws for provider or limit
 * failures: they come back as `stopped`, `rate_limited`, `auth_required` or `error`.
 */
export async function runAgent<T>(spec: AgentSpec<T>): Promise<AgentResult<T>> {
  switch (spec.model.provider) {
    case 'claude-code':
      return runClaudeCodeBackend(spec);
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'openrouter':
    case 'openai-compatible':
    case 'fake':
      return runApiBackend(spec);
  }
}
