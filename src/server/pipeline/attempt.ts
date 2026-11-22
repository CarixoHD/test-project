import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';
import {
  ImplResultSchema,
  ReviewResultSchema,
  type ProjectConfig,
  type ReviewResult,
} from '../../shared/agent-results.ts';
import type { AgentId, IssueId, ProductId } from '../../shared/ids.ts';
import type { ModelRef, Role } from '../../shared/models.ts';
import type { IssueState } from '../../shared/state.ts';
import { toolsForRole, type AgentLimits, type AgentResult } from '../agents/index.ts';
import type { Git, Worktree } from '../git/index.ts';
import type { ModelDeps } from '../llm/index.ts';
import type { ContainerRuntime, ExecResult, Sandbox, SandboxSpec } from '../sandbox/index.ts';
import type { RunHandle } from '../scheduler/index.ts';
import {
  completeAttempt,
  moveIssue,
  recordStep,
  startAttempt,
  type AttemptOutcome,
  type AttemptRef,
  type QuestionDraft,
} from './attempt-events.ts';
import {
  agentFailed,
  asked,
  counted,
  discarded,
  fail,
  interrupted,
  isCancelled,
  ISSUE_CHANGED_FEEDBACK,
  recordEnd,
  stopped,
  stopRequested,
  type Ended,
  type Failed,
} from './attempt-outcome.ts';
import { implementerPrompt, reviewerPrompt, tailLines } from './attempt-prompt.ts';
import { parseProjectConfig, PROJECT_FILE, projectConfigChanged } from './project-config.ts';
import { resolveModel } from './resolve-model.ts';
import { runRecordedAgent, type RecordedRunContext } from './run-recorded.ts';

// One attempt at an issue (ARCHITECTURE §6 flow 4, ADR 6/7): worktree → implementer in a warm
// sandbox (egress, rw) → host commit → check (network none) → fresh reviewer (read-only, network
// none) → squash merge to main under the merge lock. Counted failures (check_failed, rejected,
// conflict, empty diff, agent error) store their feedback for the next attempt and count against
// maxAttempts. Interruptions (pause, budget, shutdown, rate limit, login, an owner edit) end it
// as `interrupted`, not counted, and so does an implementer question, which also holds the issue
// until the owner answers; an owner cancel discards it. Both stop after the current step.
// Any other outcome is an uncounted error and the issue goes back to open later.

export const DEFAULT_ATTEMPT_LIMITS: Record<'implementer' | 'reviewer', AgentLimits> = {
  implementer: { maxSteps: 150, wallClockMs: 60 * 60_000 },
  reviewer: { maxSteps: 60, wallClockMs: 20 * 60_000 },
};
export const CHECK_TIMEOUT_MS = 30 * 60_000;
export { ERROR_RETRY_DELAY_MS } from './attempt-outcome.ts';
export const NO_CHECK_REASON = 'No check command configured (.vibecode/project.json)';
export const NO_CHANGES_FEEDBACK = 'no changes: the implementer finished without changing any file';
/** An aborted check (stop, restart) is an interruption, never a counted check_failed (ADR 7). */
export const CHECK_ABORTED_REASON = 'the check was aborted (the run was stopped)';
/** Check output lines kept as feedback for the next attempt. */
const CHECK_FEEDBACK_LINES = 200;

export interface AttemptDeps extends RecordedRunContext {
  git: Git;
  runtime: ContainerRuntime;
  /**
   * Demo mode: a run whose model is the fake provider uses this runtime instead, so demo work
   * needs no Docker (and starts no containers next to the dev server's browser, issue #206).
   */
  demoRuntime?: ContainerRuntime;
  modelDeps: ModelDeps;
  /** The scheduler's per-product merge lock. */
  withMergeLock: <T>(productId: ProductId, fn: () => Promise<T>) => Promise<T>;
  /** `data/artifacts`: each attempt writes `<attemptId>/diff.patch` and `check.log` here. */
  artifactsDir: string;
  /** Demo mode: fall back to the fake model when none is configured. */
  demo?: boolean;
  limits?: Partial<typeof DEFAULT_ATTEMPT_LIMITS>;
  checkTimeoutMs?: number;
  /** Warnings that do not fail the attempt (an invalid merged project.json); default console.warn. */
  log?: (line: string) => void;
}

type Ctx = AttemptRef & {
  deps: AttemptDeps;
  run: RunHandle;
  /** The issue as attempt.started recorded it: the content the agents work on. */
  issue: IssueState;
  wt: Worktree & { branch: string };
  artifacts: string;
  /** Warm sandboxes still open; closed in `finally`. */
  sandboxes: Set<Sandbox>;
  /** The runtime the last agent ran on; its check runs there too. */
  runRuntime?: ContainerRuntime;
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The runtime for a role's model: the demo fake for fake models, the server runtime otherwise. */
const runtimeFor = (deps: AttemptDeps, model: ModelRef): ContainerRuntime =>
  model.provider === 'fake' ? (deps.demoRuntime ?? deps.runtime) : deps.runtime;

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
  const sandboxes = new Set<Sandbox>();
  try {
    const ref = { store: deps.store, productId: issue.productId, issueId, attemptId };
    const started = startAttempt(ref, { ...wt, branch });
    if (started === null) return;
    const ctx: Ctx = {
      ...ref,
      deps,
      run,
      issue: started,
      wt: { ...wt, branch },
      artifacts: path.join(deps.artifactsDir, attemptId),
      sandboxes,
    };
    let ended: Ended;
    try {
      ended = await attempt(ctx);
    } catch (err) {
      ended = fail(errorText(err));
    }
    recordEnd(ctx, ended);
  } finally {
    try {
      await Promise.all([...sandboxes].map((s) => s.close()));
    } finally {
      await deps.git.removeWorktree(wt.dir);
    }
  }
}

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
  if (product === null) return fail('the product disappeared');
  const { issue } = ctx;
  const project = product.project;
  if (project === null || project.check.length === 0) return fail(NO_CHECK_REASON);

  recordStep(ctx, 'implement');
  const impl = await implement(ctx, issue, product.name, project);
  if (!impl.ok) return agentFailed(ctx, impl);
  if (impl.value !== null) return isCancelled(ctx) ? discarded() : asked(impl.value);
  if (stopRequested(ctx)) return stopped(ctx, 'the run was stopped after the implementer');

  const commit = await ctx.deps.git.commitAll(ctx.wt.dir, mergeMessage(issue));
  if (commit.sha === null) return counted('error', NO_CHANGES_FEEDBACK);
  const headSha = commit.sha;
  await mkdir(ctx.artifacts, { recursive: true });
  await writeFile(path.join(ctx.artifacts, 'diff.patch'), commit.diff, { mode: 0o600 });

  recordStep(ctx, 'check');
  const check = await runCheck(ctx, project, ctx.wt.dir, 'check.log');
  await ctx.deps.git.cleanWorktree(ctx.wt.dir);
  if (check.aborted) return stopped(ctx, CHECK_ABORTED_REASON, { headSha });
  if (check.code !== 0) {
    const what = `The check \`${project.check.join(' ')}\``;
    return counted('check_failed', checkFailedFeedback(what, check), {
      headSha,
      checkExit: check.code,
    });
  }

  const done = { headSha, checkExit: check.code };
  if (stopRequested(ctx)) return stopped(ctx, 'the run was stopped after the check', done);
  if (!moveIssue(ctx, { type: 'checks_passed' }, 'review')) {
    return isCancelled(ctx) ? discarded(done) : fail('the issue changed during the check', done);
  }
  const review = await reviewChange(ctx, issue, product.name, project, check.output, commit.diff);
  if (!review.ok) return agentFailed(ctx, review, done);
  if (!review.value.approve) {
    return counted('rejected', rejectedFeedback(review.value), { ...done, review: review.value });
  }

  const reviewed = { ...done, review: review.value };
  if (stopRequested(ctx)) return stopped(ctx, 'the run was stopped after the review', reviewed);
  recordStep(ctx, 'merge');
  return ctx.deps.withMergeLock(ctx.productId, () => merge(ctx, issue, project, reviewed));
}

type Check<T> = { ok: true; value: T } | Failed;

/** The implementer's work is done (null) or it asked the owner a question (flow 4.3). */
async function implement(
  ctx: Ctx,
  issue: IssueState,
  productName: string,
  project: ProjectConfig,
): Promise<Check<QuestionDraft | null>> {
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
    waitsForOwner: (r) => r.question !== undefined,
  });
  if (!result.ok) return result;
  const text = result.value.question;
  if (text === undefined) return { ok: true, value: null };
  const question = { id: ctx.deps.ids.next('question'), agentId: result.agentId, text };
  return { ok: true, value: question };
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
    waitsForOwner?: (result: T) => boolean;
  },
): Promise<{ ok: true; value: T; agentId: AgentId } | Failed> {
  const { deps } = ctx;
  const resolved = resolveModel(deps.store, ctx.productId, role, { demo: deps.demo === true });
  if (!resolved.ok) return resolved;
  const model = resolved.model;
  // Demo (fake model) work runs on the demo runtime: no Docker needed for a scripted agent.
  const runtime = runtimeFor(deps, model);
  ctx.runRuntime = runtime;
  // Claude Code runs in the derived image with the CLI login volume, and needs egress to reach
  // Anthropic even for the reviewer (ADR 4); its mount stays read-only.
  const claude = model.provider === 'claude-code';
  const image = await runtime.ensureImage({
    productId: ctx.productId,
    contextDir: o.worktree,
    ...(claude ? { claude } : {}),
  });
  const sandbox = await runtime.open({
    runId: o.runId,
    productId: ctx.productId,
    role: 'agent',
    image,
    worktree: o.worktree,
    readOnly: o.readOnly,
    network: claude ? 'egress' : o.network,
    ...(claude ? { claude } : {}),
  });
  ctx.sandboxes.add(sandbox);
  try {
    const { agentId, result } = await runRecordedAgent(deps, {
      productId: ctx.productId,
      issueId: ctx.issueId,
      attemptId: ctx.attemptId,
      role,
      model,
      instructions: o.instructions,
      prompt: o.prompt,
      schema: o.schema,
      ...(o.waitsForOwner === undefined ? {} : { waitsForOwner: o.waitsForOwner }),
      sandbox,
      tools: toolsForRole(role).map((t) => t.name),
      limits: deps.limits?.[role] ?? DEFAULT_ATTEMPT_LIMITS[role],
      shouldStop: () => stopRequested(ctx),
      // Not spread: the registry reads the provider settings when the model is created.
      modelDeps: deps.modelDeps,
    });
    if (result.kind === 'ok') return { ok: true, value: result.result, agentId };
    const reason = `${role}: ${agentFailure(result)}`;
    if (result.kind === 'error') return { ok: false, reason, counted: true };
    return { ok: false, reason, agent: result };
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
      return `${result.backend} needs you to log in again: log in from Settings`;
    default:
      return assertNever(result);
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}

/** `aborted`: the run's signal fired (stop or restart), so the result says nothing about the work. */
type CheckRun = { code: number | null; output: string; aborted: boolean };

/** The project's check in a one-shot container with no network; the output goes to `logName`. */
async function runCheck(
  ctx: Ctx,
  project: ProjectConfig,
  worktree: string,
  logName: string,
): Promise<CheckRun> {
  const { deps } = ctx;
  const runtime = ctx.runRuntime ?? deps.runtime;
  const image = await runtime.ensureImage({ productId: ctx.productId, contextDir: worktree });
  const lines: string[] = [];
  const r: ExecResult = await runtime.runOnce(
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
  return { code: r.code, output, aborted: r.aborted };
}

/**
 * Under the merge lock: re-read the issue (cancelled → discarded; title, body or dependencies
 * edited since attempt.started → interrupted{issue_changed}; a priority-only edit merges), then
 * integrate, (re-check,) advance main, complete.
 */
async function merge(
  ctx: Ctx,
  issue: IssueState,
  project: ProjectConfig,
  done: AttemptOutcome,
): Promise<Ended> {
  const { git, store } = ctx.deps;
  const now = store.q.issue(ctx.issueId);
  if (now === null || now.status === 'cancelled') return discarded(done);
  if (contentChanged(ctx.issue, now))
    return interrupted('issue_changed', ISSUE_CHANGED_FEEDBACK, done);
  if (now.status !== 'in_review') return fail(`the issue is ${now.status}, not in review`, done);
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
        if (recheck.aborted) return stopped(ctx, CHECK_ABORTED_REASON, done);
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
  await syncProjectConfig(ctx);
  return { kind: 'merged', ...done };
}

/**
 * After main advanced: product.project follows main's `.vibecode/project.json`, so a config an
 * implementer merged (e.g. `preview`) applies at once. A missing or invalid file keeps the
 * current config with a warning; the attempt is already merged and never fails here.
 */
async function syncProjectConfig(ctx: Ctx): Promise<void> {
  const { git, store, redactor } = ctx.deps;
  const warn = (what: string) => {
    const log = ctx.deps.log ?? ((line: string) => console.warn(line));
    log(redactor.redact(`attempt ${ctx.attemptId}: kept the project config: ${what}`));
  };
  let text: string | null;
  try {
    text = await git.readFileAtMain(ctx.productId, PROJECT_FILE);
  } catch (err) {
    warn(`could not read ${PROJECT_FILE} at main: ${errorText(err)}`);
    return;
  }
  if (text === null) return warn(`${PROJECT_FILE} is missing on main`);
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) return warn(parsed.reason);
  const project = parsed.value;
  store.commit((tx) => {
    const product = tx.q.product(ctx.productId);
    if (product === null || !projectConfigChanged(product.project, project)) return [];
    return [
      {
        type: 'product.settings_changed',
        productId: ctx.productId,
        entityId: null,
        v: 1,
        data: { project },
      },
    ];
  });
}

/** What the agents worked on differs: an edit of title, body or dependencies (not priority). */
function contentChanged(was: IssueState, now: IssueState): boolean {
  if (now.rev === was.rev) return false;
  const deps = (i: IssueState) => [...i.dependsOn].sort().join(',');
  return now.title !== was.title || now.body !== was.body || deps(now) !== deps(was);
}

function mergeMessage(issue: IssueState): string {
  return `#${String(issue.number)} ${issue.title}`;
}
