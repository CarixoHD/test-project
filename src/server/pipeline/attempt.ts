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
  failAttempt,
  moveIssue,
  recordStep,
  startAttempt,
  type AttemptOutcome,
  type AttemptRef,
  type CountedStatus,
} from './attempt-events.ts';
import { implementerPrompt, reviewerPrompt, tailLines } from './attempt-prompt.ts';
import { resolveModel } from './resolve-model.ts';
import { runRecordedAgent, type RecordedRunContext } from './run-recorded.ts';

// One attempt at an issue (ARCHITECTURE §6 flow 4, ADR 6/7): worktree → implementer in a warm
// sandbox (egress, rw) → host commit → check (network none) → fresh reviewer (read-only, network
// none) → squash merge to main under the merge lock. Counted failures (check_failed, rejected,
// conflict, empty diff, agent error) store their feedback for the next attempt and count against
// maxAttempts; any other outcome is an uncounted error and the issue goes back to open later.

export const DEFAULT_ATTEMPT_LIMITS: Record<'implementer' | 'reviewer', AgentLimits> = {
  implementer: { maxSteps: 150, wallClockMs: 60 * 60_000 },
  reviewer: { maxSteps: 60, wallClockMs: 20 * 60_000 },
};
export const CHECK_TIMEOUT_MS = 30 * 60_000;
/** An errored attempt's issue waits this long before the scheduler starts it again. */
export const ERROR_RETRY_DELAY_MS = 60_000;
export const NO_CHECK_REASON = 'No check command configured (.vibecode/project.json)';
export const NO_CHANGES_FEEDBACK = 'no changes: the implementer finished without changing any file';
/** Check output lines kept as feedback for the next attempt. */
const CHECK_FEEDBACK_LINES = 200;

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

/** What the attempt ends with; the outcome fields go into attempt.ended. */
type Ended = AttemptOutcome &
  (
    | { kind: 'merged' }
    | { kind: 'failed'; status: CountedStatus; feedback: string }
    | { kind: 'error'; reason: string }
  );

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
    if (ended.kind === 'failed') {
      const { kind: _kind, status, feedback, ...outcome } = ended;
      failAttempt(ctx, status, deps.redactor.redact(feedback), outcome);
    } else if (ended.kind === 'error') {
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

const outcomeOf = (p: Partial<AttemptOutcome>): AttemptOutcome => ({
  headSha: p.headSha ?? null,
  review: p.review ?? null,
  checkExit: p.checkExit ?? null,
});

/** An uncounted error: the issue goes back to open after ERROR_RETRY_DELAY_MS. */
const fail = (reason: string, p: Partial<AttemptOutcome> = {}): Ended => ({
  kind: 'error',
  reason,
  ...outcomeOf(p),
});

/** A counted failure whose feedback goes to the next attempt. */
const counted = (
  status: CountedStatus,
  feedback: string,
  p: Partial<AttemptOutcome> = {},
): Ended => ({ kind: 'failed', status, feedback, ...outcomeOf(p) });

/** A failed agent run: agent errors count, everything else (stop, rate limit, …) does not. */
const agentFailed = (r: Failed, p: Partial<AttemptOutcome> = {}): Ended =>
  r.counted === true ? counted('error', r.reason, p) : fail(r.reason, p);

function checkFailedFeedback(what: string, check: CheckRun): string {
  const output = tailLines(check.output, CHECK_FEEDBACK_LINES);
  return (
    `${what} failed (exit ${check.code ?? 'none'}). Last ${String(CHECK_FEEDBACK_LINES)} ` +
    `lines of its output:\n${output === '' ? '(no output)' : output}`
  );
}

function rejectedFeedback(review: ReviewResult): string {
  const findings = review.findings.map((f) => `- ${f}`).join('\n');
  return `The reviewer rejected the change:\n${findings === '' ? '(no findings given)' : findings}`;
}

async function attempt(ctx: Ctx): Promise<Ended> {
  const product = ctx.deps.store.q.product(ctx.productId);
  const issue = ctx.deps.store.q.issue(ctx.issueId);
  if (product === null || issue === null) return fail('product or issue disappeared');
  const project = product.project;
  if (project === null || project.check.length === 0) return fail(NO_CHECK_REASON);

  recordStep(ctx, 'implement');
  const impl = await implement(ctx, issue, product.name, project);
  if (!impl.ok) return agentFailed(impl);

  const commit = await ctx.deps.git.commitAll(ctx.wt.dir, mergeMessage(issue));
  if (commit.sha === null) return counted('error', NO_CHANGES_FEEDBACK);
  const headSha = commit.sha;
  await mkdir(ctx.artifacts, { recursive: true });
  await writeFile(path.join(ctx.artifacts, 'diff.patch'), commit.diff, { mode: 0o600 });

  recordStep(ctx, 'check');
  const check = await runCheck(ctx, project, ctx.wt.dir, 'check.log');
  await ctx.deps.git.cleanWorktree(ctx.wt.dir);
  if (check.code !== 0) {
    const what = `The check \`${project.check.join(' ')}\``;
    return counted('check_failed', checkFailedFeedback(what, check), {
      headSha,
      checkExit: check.code,
    });
  }

  if (!moveIssue(ctx, { type: 'checks_passed' }, 'review')) {
    return fail('the issue changed during the check', { headSha, checkExit: 0 });
  }
  const review = await reviewChange(ctx, issue, product.name, project, check.output, commit.diff);
  const done = { headSha, checkExit: check.code };
  if (!review.ok) return agentFailed(review, done);
  if (!review.value.approve) {
    return counted('rejected', rejectedFeedback(review.value), { ...done, review: review.value });
  }

  recordStep(ctx, 'merge');
  return ctx.deps.withMergeLock(ctx.productId, () =>
    merge(ctx, issue, project, { ...done, review: review.value }),
  );
}

/** A failed step; `counted` marks agent errors (ADR 7), which count against maxAttempts. */
type Failed = { ok: false; reason: string; counted?: boolean };
type Check<T> = { ok: true; value: T } | Failed;

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
    if (result.kind === 'ok') return { ok: true, value: result.result };
    return {
      ok: false,
      reason: `${role}: ${agentFailure(result)}`,
      counted: result.kind === 'error',
    };
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
  const { git, store } = ctx.deps;
  const now = store.q.issue(ctx.issueId);
  if (now?.status !== 'in_review' || now.rev !== ctx.issueRev) {
    return fail('the issue changed or was cancelled before the merge', done);
  }
  const main = await git.mainSha(ctx.productId);
  const r = await git.integrate(ctx.productId, ctx.wt.branch, ctx.wt.baseSha, mergeMessage(issue));
  switch (r.kind) {
    case 'conflict':
      return counted(
        'conflict',
        `Merging into main conflicted in: ${r.paths.join(', ')}. Main changed since this ` +
          'attempt started; build on its current version of these files.',
        done,
      );
    case 'fast':
      break;
    case 'merged':
      try {
        const recheck = await runCheck(ctx, project, r.dir, 'integration-check.log');
        if (recheck.code !== 0) {
          const what = `The check \`${project.check.join(' ')}\` on the merge with main`;
          return counted('check_failed', checkFailedFeedback(what, recheck), {
            ...done,
            checkExit: recheck.code,
          });
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
