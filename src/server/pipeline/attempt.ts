import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';
import {
  ImplResultSchema,
  ReviewResultSchema,
  type ProjectConfig,
  type ReviewResult,
} from '../../shared/agent-results.ts';
import type { IssueId, ProductId } from '../../shared/ids.ts';
import type { Role } from '../../shared/models.ts';
import type { IssueState } from '../../shared/state.ts';
import { toolsForRole, type AgentLimits, type AgentResult } from '../agents/index.ts';
import type { Git, Worktree } from '../git/index.ts';
import type { ModelDeps } from '../llm/index.ts';
import type { ContainerRuntime, ExecResult, Sandbox, SandboxSpec } from '../sandbox/index.ts';
import type { RunHandle } from '../scheduler/index.ts';
import {
  completeAttempt,
  endWithError,
  moveIssue,
  recordStep,
  startAttempt,
  type AttemptOutcome,
  type AttemptRef,
} from './attempt-events.ts';
import { implementerPrompt, reviewerPrompt, tailLines } from './attempt-prompt.ts';
import { resolveModel } from './resolve-model.ts';
import { runRecordedAgent, type RecordedRunContext } from './run-recorded.ts';

// One attempt at an issue (ARCHITECTURE §6 flow 4, ADR 6/7): worktree → implementer in a warm
// sandbox (egress, rw) → host commit → check (network none) → fresh reviewer (read-only, network
// none) → squash merge to main under the merge lock. Any other outcome is recorded as
// attempt.ended{error}, uncounted, and the issue goes back to open (counted failures: follow-up).

export const DEFAULT_ATTEMPT_LIMITS: Record<'implementer' | 'reviewer', AgentLimits> = {
  implementer: { maxSteps: 150, wallClockMs: 60 * 60_000 },
  reviewer: { maxSteps: 60, wallClockMs: 20 * 60_000 },
};
export const CHECK_TIMEOUT_MS = 30 * 60_000;
/** An errored attempt's issue waits this long before the scheduler starts it again. */
export const ERROR_RETRY_DELAY_MS = 60_000;
export const NO_CHECK_REASON = 'No check command configured (.vibecode/project.json)';

export interface AttemptDeps extends RecordedRunContext {
  git: Git;
  runtime: ContainerRuntime;
  modelDeps: ModelDeps;
  /** The scheduler's per-product merge lock. */
  withMergeLock: <T>(productId: ProductId, fn: () => Promise<T>) => Promise<T>;
  /** `data/artifacts`: each attempt writes `<attemptId>/diff.patch` and `check.log` here. */
  artifactsDir: string;
  /** Demo mode: fall back to the fake model when none is configured. */
  demo?: boolean;
  limits?: Partial<typeof DEFAULT_ATTEMPT_LIMITS>;
  checkTimeoutMs?: number;
}

type Ctx = AttemptRef & {
  deps: AttemptDeps;
  run: RunHandle;
  issueRev: number;
  wt: Worktree & { branch: string };
  artifacts: string;
  /** Warm sandboxes still open; closed in `finally`. */
  sandboxes: Set<Sandbox>;
};

/** What the attempt ends with; `ended` fields go into attempt.ended. */
type Ended = AttemptOutcome & ({ kind: 'merged' } | { kind: 'error'; reason: string });

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runAttempt(deps: AttemptDeps, issueId: IssueId, run: RunHandle) {
  const issue = deps.store.q.issue(issueId);
  if (issue === null) throw new Error(`runAttempt: unknown issue ${issueId}`);
  const attemptId = deps.ids.next('attempt');
  const wt = await deps.git.addWorktree(issue.productId, attemptId);
  const { branch } = wt;
  if (branch === null) {
    await deps.git.removeWorktree(wt.dir);
    throw new Error('runAttempt: the attempt worktree has no branch');
  }
  const ctx: Ctx = {
    store: deps.store,
    deps,
    run,
    productId: issue.productId,
    issueId,
    attemptId,
    issueRev: issue.rev,
    wt: { ...wt, branch },
    artifacts: path.join(deps.artifactsDir, attemptId),
    sandboxes: new Set(),
  };
  try {
    if (!startAttempt(ctx, ctx.wt)) return;
    let ended: Ended;
    try {
      ended = await attempt(ctx);
    } catch (err) {
      ended = {
        kind: 'error',
        reason: errorText(err),
        headSha: null,
        review: null,
        checkExit: null,
      };
    }
    if (ended.kind === 'error') {
      const { kind: _kind, reason, ...outcome } = ended;
      const runAfter = deps.clock.now() + ERROR_RETRY_DELAY_MS;
      endWithError(ctx, deps.redactor.redact(reason), outcome, runAfter);
    }
  } finally {
    try {
      await Promise.all([...ctx.sandboxes].map((s) => s.close()));
    } finally {
      await deps.git.removeWorktree(wt.dir);
    }
  }
}

async function attempt(ctx: Ctx): Promise<Ended> {
  const fail = (reason: string, p: Partial<AttemptOutcome> = {}): Ended => ({
    kind: 'error',
    reason,
    headSha: p.headSha ?? null,
    review: p.review ?? null,
    checkExit: p.checkExit ?? null,
  });
  const product = ctx.deps.store.q.product(ctx.productId);
  const issue = ctx.deps.store.q.issue(ctx.issueId);
  if (product === null || issue === null) return fail('product or issue disappeared');
  const project = product.project;
  if (project === null || project.check.length === 0) return fail(NO_CHECK_REASON);

  recordStep(ctx, 'implement');
  const impl = await implement(ctx, issue, product.name, project);
  if (!impl.ok) return fail(impl.reason);

  const commit = await ctx.deps.git.commitAll(ctx.wt.dir, mergeMessage(issue));
  if (commit.sha === null) return fail('no changes');
  const headSha = commit.sha;
  await mkdir(ctx.artifacts, { recursive: true });
  await writeFile(path.join(ctx.artifacts, 'diff.patch'), commit.diff, { mode: 0o600 });

  recordStep(ctx, 'check');
  const check = await runCheck(ctx, project, ctx.wt.dir, 'check.log');
  await ctx.deps.git.cleanWorktree(ctx.wt.dir);
  if (check.code !== 0) {
    return fail(`check failed (exit ${check.code ?? 'none'}):\n${tailLines(check.output)}`, {
      headSha,
      checkExit: check.code,
    });
  }

  if (!moveIssue(ctx, { type: 'checks_passed' }, 'review')) {
    return fail('the issue changed during the check', { headSha, checkExit: 0 });
  }
  const review = await reviewChange(ctx, issue, product.name, project, check.output, commit.diff);
  const done = { headSha, checkExit: check.code };
  if (!review.ok) return fail(review.reason, done);
  if (!review.value.approve) {
    return fail(`rejected:\n${review.value.findings.join('\n')}`, {
      ...done,
      review: review.value,
    });
  }

  recordStep(ctx, 'merge');
  return ctx.deps.withMergeLock(ctx.productId, () =>
    merge(ctx, issue, project, { ...done, review: review.value }),
  );
}

type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

async function implement(
  ctx: Ctx,
  issue: IssueState,
  productName: string,
  project: ProjectConfig,
): Promise<Check<null>> {
  const { instructions, prompt } = await implementerPrompt({
    store: ctx.deps.store,
    issue,
    productName,
    worktree: ctx.wt.dir,
    checkCommand: project.check,
  });
  const result = await runAgentIn(ctx, 'implementer', {
    worktree: ctx.wt.dir,
    readOnly: false,
    network: 'egress',
    instructions,
    prompt,
    schema: ImplResultSchema,
    runId: ctx.run.runId,
  });
  if (!result.ok) return result;
  if (result.value.question !== undefined) {
    return { ok: false, reason: `the implementer asked: ${result.value.question}` };
  }
  return { ok: true, value: null };
}

async function reviewChange(
  ctx: Ctx,
  issue: IssueState,
  productName: string,
  project: ProjectConfig,
  checkOutput: string,
  diff: string,
): Promise<Check<ReviewResult>> {
  const { instructions, prompt } = reviewerPrompt({
    issue,
    productName,
    checkCommand: project.check,
    checkExit: 0,
    checkOutput,
    diff,
  });
  return runAgentIn(ctx, 'reviewer', {
    worktree: ctx.wt.dir,
    readOnly: true,
    network: 'none',
    instructions,
    prompt,
    schema: ReviewResultSchema,
    runId: ctx.deps.ids.next('run'),
  });
}

/** Runs one agent of the attempt in its own warm sandbox, closed when the agent is done. */
async function runAgentIn<T>(
  ctx: Ctx,
  role: Extract<Role, 'implementer' | 'reviewer'>,
  o: Pick<SandboxSpec, 'worktree' | 'readOnly' | 'network' | 'runId'> & {
    instructions: string;
    prompt: string;
    schema: ZodType<T>;
  },
): Promise<Check<T>> {
  const { deps } = ctx;
  const resolved = resolveModel(deps.store, ctx.productId, role, { demo: deps.demo === true });
  if (!resolved.ok) return resolved;
  const model = resolved.model;
  const image = await deps.runtime.ensureImage({
    productId: ctx.productId,
    contextDir: o.worktree,
  });
  const sandbox = await deps.runtime.open({
    runId: o.runId,
    productId: ctx.productId,
    role: 'agent',
    image,
    worktree: o.worktree,
    readOnly: o.readOnly,
    network: o.network,
    ...(model.provider === 'claude-code' ? { claude: true } : {}),
  });
  ctx.sandboxes.add(sandbox);
  try {
    const { result } = await runRecordedAgent(deps, {
      productId: ctx.productId,
      issueId: ctx.issueId,
      attemptId: ctx.attemptId,
      role,
      model,
      instructions: o.instructions,
      prompt: o.prompt,
      schema: o.schema,
      sandbox,
      tools: toolsForRole(role).map((t) => t.name),
      limits: deps.limits?.[role] ?? DEFAULT_ATTEMPT_LIMITS[role],
      shouldStop: () => ctx.run.shouldStop(),
      // Not spread: the registry reads the provider settings when the model is created.
      modelDeps: deps.modelDeps,
    });
    return result.kind === 'ok'
      ? { ok: true, value: result.result }
      : { ok: false, reason: `${role}: ${agentFailure(result)}` };
  } finally {
    ctx.sandboxes.delete(sandbox);
    await sandbox.close();
  }
}

function agentFailure(result: Exclude<AgentResult<unknown>, { kind: 'ok' }>): string {
  switch (result.kind) {
    case 'stopped':
      return 'stopped';
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
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}

type CheckRun = { code: number | null; output: string };

/** The project's check in a one-shot container with no network; the output goes to `logName`. */
async function runCheck(
  ctx: Ctx,
  project: ProjectConfig,
  worktree: string,
  logName: string,
): Promise<CheckRun> {
  const { deps } = ctx;
  const image = await deps.runtime.ensureImage({ productId: ctx.productId, contextDir: worktree });
  const lines: string[] = [];
  const r: ExecResult = await deps.runtime.runOnce(
    {
      runId: deps.ids.next('run'),
      productId: ctx.productId,
      role: 'check',
      image,
      worktree,
      readOnly: false,
      network: 'none',
    },
    project.check,
    {
      timeoutMs: deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS,
      signal: ctx.run.signal,
      onLine: (line) => lines.push(line),
    },
  );
  const notes = [
    ...(r.timedOut ? ['[check timed out]'] : []),
    ...(r.aborted ? ['[check aborted]'] : []),
    ...(r.truncated ? ['[output truncated]'] : []),
  ];
  const output = deps.redactor.redact([...lines, ...notes].join('\n'));
  await mkdir(ctx.artifacts, { recursive: true });
  await appendFile(path.join(ctx.artifacts, logName), output === '' ? '' : `${output}\n`, {
    mode: 0o600,
  });
  return { code: r.code, output };
}

/** Under the merge lock: re-read the issue, integrate, (re-check,) advance main, complete. */
async function merge(
  ctx: Ctx,
  issue: IssueState,
  project: ProjectConfig,
  done: AttemptOutcome,
): Promise<Ended> {
  const fail = (reason: string): Ended => ({ kind: 'error', reason, ...done });
  const { git, store } = ctx.deps;
  const now = store.q.issue(ctx.issueId);
  if (now?.status !== 'in_review' || now.rev !== ctx.issueRev) {
    return fail('the issue changed or was cancelled before the merge');
  }
  const main = await git.mainSha(ctx.productId);
  const r = await git.integrate(ctx.productId, ctx.wt.branch, ctx.wt.baseSha, mergeMessage(issue));
  switch (r.kind) {
    case 'conflict':
      return fail(`conflicts with main in ${r.paths.join(', ')}`);
    case 'fast':
      break;
    case 'merged':
      try {
        const recheck = await runCheck(ctx, project, r.dir, 'integration-check.log');
        if (recheck.code !== 0) {
          return fail(
            `check failed on the merge with main (exit ${recheck.code ?? 'none'}):\n` +
              tailLines(recheck.output),
          );
        }
      } finally {
        await git.removeWorktree(r.dir);
      }
      break;
    default:
      return assertNever(r);
  }
  await git.advanceMain(ctx.productId, r.commitSha, main);
  completeAttempt(ctx, r.commitSha, done);
  return { kind: 'merged', ...done };
}

function mergeMessage(issue: IssueState): string {
  return `#${String(issue.number)} ${issue.title}`;
}
