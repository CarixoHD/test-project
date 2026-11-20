import type { z } from 'zod';
import type { Usage } from '../../shared/budget.ts';
import type { Role } from '../../shared/models.ts';
import type { ModelRef } from '../../shared/models.ts';
import type { ModelDeps } from '../llm/index.ts';
import type { Sandbox } from '../sandbox/index.ts';
import type { Clock } from '../util/clock.ts';
import type { ToolName } from './tools.ts';

/** Outcome of one agent run (docs/ARCHITECTURE.md §4.6). */
export type AgentResult<T> =
  | { kind: 'ok'; result: T }
  | { kind: 'stopped' }
  | { kind: 'rate_limited'; until: number; backend: string }
  | { kind: 'auth_required'; backend: string }
  | { kind: 'error'; message: string; transient: boolean };

/** Usage of one model call (step) in the disjoint `Usage` buckets, plus raw provider metadata. */
export type StepUsage = Usage & { step: number; providerMetadata: unknown };

export type AgentLimits = {
  maxSteps: number;
  wallClockMs: number;
  /** Per model call; the call is aborted after this long. Default 10 minutes. */
  stepTimeoutMs?: number;
};

export type AgentSpec<T> = {
  agentId: string;
  role: Role;
  /** Provider `claude-code` selects the Claude Code backend; every other provider the API loop. */
  model: ModelRef;
  instructions: string;
  prompt: string;
  /** Input schema of the `finish` tool; the run's result. Should describe a JSON object. */
  schema: z.ZodType<T>;
  /** Required when `tools` is non-empty: every tool executes inside it. */
  sandbox?: Sandbox;
  tools: readonly ToolName[];
  /** Add the provider-native web search when the provider supports it (ADR 10). */
  webSearch?: boolean;
  limits: AgentLimits;
  /** Checked between steps; true ends the run as `stopped`. */
  shouldStop: () => boolean;
  /** Secrets and provider settings for llm `model()`; read on every run. */
  modelDeps: ModelDeps;
  clock: Clock;
  /** Human-readable, redacted activity lines (tool calls, assistant text). */
  onActivity?: (line: string) => void;
  /** Called once per completed model call. */
  onUsage?: (usage: StepUsage) => void;
};
