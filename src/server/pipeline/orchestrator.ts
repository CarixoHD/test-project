import { z } from 'zod';
import {
  PlanResultSchema,
  ProjectConfigSchema,
  type PlanResult,
  type ProjectConfig,
} from '../../shared/agent-results.ts';
import type { Event } from '../../shared/events.ts';
import type { ProductId } from '../../shared/ids.ts';
import type { ProductState } from '../../shared/state.ts';
import { pendingTriggers } from '../../shared/triggers.ts';
import { TOOL_NAMES, type AgentLimits, type AgentResult } from '../agents/index.ts';
import { applyPlan, type ApplyPlanOptions } from '../commands/index.ts';
import type { Git, Worktree } from '../git/index.ts';
import { capabilities, type ModelDeps } from '../llm/index.ts';
import type { ContainerRuntime, Sandbox } from '../sandbox/index.ts';
import type { RunHandle } from '../scheduler/index.ts';
import {
  limitDrafts,
  limitOf,
  LOGIN_RETRY_DELAY_MS,
  type BackendLimitDraft,
} from './backend-limit.ts';
import { OrchestratorBackoff } from './orchestrator-backoff.ts';
import { orchestratorPrompt } from './orchestrator-prompt.ts';
import { readRepoFile } from './repo-file.ts';
import { resolveModel } from './resolve-model.ts';
import { runRecordedAgent, type RecordedRunContext } from './run-recorded.ts';

// Orchestrator run (ARCHITECTURE §6 flow 3, ADR 7, ADR 10): research and repository setup files
// in a sandbox, then the plan. The agent may only touch ALLOWED_PATHS; the host commits, checks
// project.json and the image, merges to main under the merge lock and applies the plan (issue
// events, project config, replan inbox item and cursor advance in one store commit). A failed
// run leaves the cursor alone and is retried with backoff; repeated failures go to the inbox.
// A rate limit or missing login is not a failure: it records backend.limited (like an attempt)
// and the next run waits for the limit instead of counting toward the give-up limit.

export const DEFAULT_ORCHESTRATOR_LIMITS: AgentLimits = { maxSteps: 80, wallClockMs: 45 * 60_000 };
const PROJECT_FILE = '.vibecode/project.json';

/** Paths the orchestrator may change: Dockerfile, .dockerignore, .vibecode/** and docs/**. */
export function isAllowedOrchestratorPath(p: string): boolean {
  return (
    p === 'Dockerfile' ||
    p === '.dockerignore' ||
    p.startsWith('.vibecode/') ||
    p.startsWith('docs/')
  );
}

export interface OrchestratorDeps extends RecordedRunContext {
  git: Git;
  runtime: ContainerRuntime;
  modelDeps: ModelDeps;
  /** The scheduler's per-product merge lock. */
  withMergeLock: <T>(productId: ProductId, fn: () => Promise<T>) => Promise<T>;
  /** Demo mode: fall back to the fake model when none is configured. */
  demo?: boolean;
  limits?: AgentLimits;
  backoff?: { delaysMs?: readonly number[]; maxFailures?: number };
}

export interface Orchestrator {
  runOrchestrator(productId: ProductId, triggers: Event[], run: RunHandle): Promise<void>;
  /** The scheduler's `orchestratorNotBefore` hook (retry backoff). */
  orchestratorNotBefore(productId: ProductId): number;
}

type Outcome =
  | { kind: 'done' }
  | { kind: 'stopped' }
  | { kind: 'failed'; reason: string }
  /** The backend is rate-limited or needs a login: not a failure, wait until `retryAt`. */
  | { kind: 'limited'; limit: BackendLimitDraft; retryAt: number };
type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

const failed = (reason: string): Outcome => ({ kind: 'failed', reason });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const backoff = new OrchestratorBackoff(deps.backoff);

  const latestTriggerSeq = (productId: ProductId): number => {
    const { state } = deps.store.snapshot();
    const cursor = state.products[productId]?.orchestratorCursor ?? 0;
    const pending = pendingTriggers(deps.store.eventsSince(cursor), cursor, {
      productId,
      questions: state.questions,
    });
    return pending.at(-1)?.seq ?? 0;
  };

  const recordFailure = (productId: ProductId, consumedSeq: number, reason: string): void => {
    const { failures, gaveUp } = backoff.recordFailure(productId, deps.clock.now(), consumedSeq);
    if (!gaveUp) return;
    const name = deps.store.q.product(productId)?.name ?? productId;
    deps.store.commit(() => [
      {
        type: 'inbox.created',
        productId,
        entityId: deps.ids.next('inbox'),
        v: 1,
        data: {
          kind: 'error',
          title: `Planning stopped for ${name}`,
          body:
            `The orchestrator failed ${String(failures)} times in a row and stopped retrying. ` +
            `Last error: ${deps.redactor.redact(reason)}. It runs again on the next PRD change, ` +
            'failed issue or answered question.',
          link: `/products/${productId}`,
        },
      },
    ]);
  };

  return {
    async runOrchestrator(productId, triggers, run) {
      if (triggers.length === 0) return;
      const consumedSeq = Math.max(...triggers.map((e) => e.seq));
      let outcome: Outcome;
      try {
        outcome = await orchestrate(deps, productId, triggers, consumedSeq, run);
      } catch (err) {
        outcome = failed(errorText(err));
      }
      if (outcome.kind === 'done') backoff.recordSuccess(productId);
      if (outcome.kind === 'failed') recordFailure(productId, consumedSeq, outcome.reason);
      if (outcome.kind === 'limited') {
        const { limit } = outcome;
        deps.store.commit((tx) => limitDrafts(tx, limit));
        backoff.waitUntil(productId, outcome.retryAt);
      }
    },
    orchestratorNotBefore(productId) {
      return backoff.notBefore(productId, () => latestTriggerSeq(productId));
    },
  };
}

async function orchestrate(
  deps: OrchestratorDeps,
  productId: ProductId,
  triggers: readonly Event[],
  consumedSeq: number,
  run: RunHandle,
): Promise<Outcome> {
  const resolved = resolveModel(deps.store, productId, 'orchestrator', {
    demo: deps.demo === true,
  });
  if (!resolved.ok) return failed(resolved.reason);
  const model = resolved.model;
  const wt = await deps.git.addWorktree(productId, run.runId);
  let sandbox: Sandbox | undefined;
  try {
    // Claude Code: the derived image FROM the product image, plus the CLI login volume (ADR 4).
    const claude = model.provider === 'claude-code';
    const image = await deps.runtime.ensureImage({
      productId,
      contextDir: wt.dir,
      ...(claude ? { claude } : {}),
    });
    sandbox = await deps.runtime.open({
      runId: run.runId,
      productId,
      role: 'agent',
      image,
      worktree: wt.dir,
      readOnly: false,
      network: 'egress',
      ...(claude ? { claude } : {}),
    });
    const webSearch = capabilities(model).webSearch;
    const prd = await readRepoFile(wt.dir, 'docs/PRD.md');
    const { instructions, prompt } = orchestratorPrompt({
      store: deps.store,
      productId,
      triggers,
      prd: prd.ok ? prd.value : null,
      webSearch,
    });
    const { result } = await runRecordedAgent(deps, {
      productId,
      role: 'orchestrator',
      model,
      instructions,
      prompt,
      schema: PlanResultSchema,
      sandbox,
      tools: TOOL_NAMES,
      webSearch,
      limits: deps.limits ?? DEFAULT_ORCHESTRATOR_LIMITS,
      shouldStop: () => run.shouldStop(),
      modelDeps: { ...deps.modelDeps, webSearch },
    });
    if (result.kind === 'stopped') return { kind: 'stopped' };
    if (result.kind === 'rate_limited' || result.kind === 'auth_required') {
      const retryAt =
        result.kind === 'rate_limited' ? result.until : deps.clock.now() + LOGIN_RETRY_DELAY_MS;
      return { kind: 'limited', limit: limitOf(result, agentFailure(result)), retryAt };
    }
    if (result.kind !== 'ok') return failed(agentFailure(result));
    return await land(deps, productId, wt, result.result, triggers, consumedSeq);
  } finally {
    try {
      await sandbox?.close();
    } finally {
      await deps.git.removeWorktree(wt.dir);
    }
  }
}

function agentFailure(result: Exclude<AgentResult<unknown>, { kind: 'ok' | 'stopped' }>): string {
  switch (result.kind) {
    case 'error':
      return `agent error: ${result.message}`;
    case 'rate_limited':
      return `${result.backend} is rate limited`;
    case 'auth_required':
      return `${result.backend} needs a login`;
    default:
      return assertNever(result);
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled agent result: ${JSON.stringify(x)}`);
}

/** Host-side checks of the agent's work, then merge to main and apply the plan. */
async function land(
  deps: OrchestratorDeps,
  productId: ProductId,
  wt: Worktree,
  plan: PlanResult,
  triggers: readonly Event[],
  consumedSeq: number,
): Promise<Outcome> {
  const message = `Orchestrator: ${firstLine(plan.summary)}`;
  const commit = await deps.git.commitAll(wt.dir, message);
  if (commit.sha !== null) {
    const changed = await deps.git.changedPaths(wt.dir, wt.baseSha);
    const disallowed = changed.filter((p) => !isAllowedOrchestratorPath(p));
    if (disallowed.length > 0) {
      return failed(
        'changed files outside Dockerfile, .dockerignore, .vibecode/ and docs/: ' +
          disallowed.join(', '),
      );
    }
  }
  const project = await readProjectConfig(wt.dir);
  if (!project.ok) return failed(project.reason);
  if (commit.sha !== null) {
    try {
      await deps.runtime.ensureImage({ productId, contextDir: wt.dir });
    } catch (err) {
      return failed(`image build failed: ${errorText(err)}`);
    }
  }
  const product = deps.store.q.product(productId);
  if (product === null) return failed(`unknown product ${productId}`);
  const opts = planOptions(product, project.value, plan, triggers);

  return deps.withMergeLock(productId, async () => {
    if (commit.sha !== null) {
      const merged = await mergeToMain(deps.git, productId, wt, message);
      if (!merged.ok) return failed(merged.reason);
    }
    const applied = applyPlan(deps, productId, plan, consumedSeq, opts);
    return applied.ok ? { kind: 'done' } : failed(applied.reason);
  });
}

function planOptions(
  product: ProductState,
  project: ProjectConfig | null,
  plan: PlanResult,
  triggers: readonly Event[],
): ApplyPlanOptions {
  // The newest PRD version this run planned for; v1 is the initial plan, not a replan.
  const replanVersion = Math.max(
    0,
    ...triggers.flatMap((e) => (e.type === 'prd.applied' ? [e.data.version] : [])),
  );
  const projectChanged =
    project !== null && JSON.stringify(project) !== JSON.stringify(product.project);
  return {
    ...(projectChanged ? { project } : {}),
    ...(replanVersion > 1 ? { replan: { version: replanVersion, summary: plan.summary } } : {}),
  };
}

/** One squash commit of the worktree branch on main (caller holds the merge lock). */
async function mergeToMain(
  git: Git,
  productId: ProductId,
  wt: Worktree,
  message: string,
): Promise<Check<null>> {
  if (wt.branch === null) throw new Error('orchestrator worktree has no branch');
  const main = await git.mainSha(productId);
  const r = await git.integrate(productId, wt.branch, wt.baseSha, message);
  switch (r.kind) {
    case 'conflict':
      return { ok: false, reason: `conflicts with main in ${r.paths.join(', ')}` };
    case 'fast':
      await git.advanceMain(productId, r.commitSha, main);
      return { ok: true, value: null };
    case 'merged':
      try {
        await git.advanceMain(productId, r.commitSha, main);
      } finally {
        await git.removeWorktree(r.dir);
      }
      return { ok: true, value: null };
    default:
      return assertNever(r);
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length <= 72 ? line : `${line.slice(0, 71)}…`;
}

/** `.vibecode/project.json` validated with ProjectConfig; null when the file does not exist. */
async function readProjectConfig(dir: string): Promise<Check<ProjectConfig | null>> {
  const file = await readRepoFile(dir, PROJECT_FILE);
  if (!file.ok) return file.missing === true ? { ok: true, value: null } : file;
  let json: unknown;
  try {
    json = JSON.parse(file.value);
  } catch {
    return { ok: false, reason: `${PROJECT_FILE} is not valid JSON` };
  }
  const parsed = ProjectConfigSchema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: `invalid ${PROJECT_FILE}: ${z.prettifyError(parsed.error)}` };
}
