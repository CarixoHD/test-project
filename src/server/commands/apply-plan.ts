import { z } from 'zod';
import {
  PlanResultSchema,
  ProjectConfigSchema,
  type IssueOp,
  type PlanResult,
  type ProjectConfig,
} from '../../shared/agent-results.ts';
import type { IssueStatus, IssueView } from '../../shared/domain.ts';
import type { Event, EventDraft } from '../../shared/events.ts';
import type { IdGen, IssueId, ProductId } from '../../shared/ids.ts';
import { transition } from '../../shared/issues.ts';
import type { ProductState } from '../../shared/state.ts';
import type { Queries, Store } from '../store/index.ts';
import {
  findDependencyCycle,
  nextIssueNumber,
  resolveDependsOn,
  type DependsOnContext,
} from './issue-graph.ts';

// Applies an orchestrator PlanResult to the issue board (ARCHITECTURE §6 flow 3, ADR 7).
// Ops are validated in order against a working copy of the product's issues; if any op is
// invalid nothing is committed. Otherwise every issue event, the plan's questions and the
// cursor advance are committed together, so a failed run never moves the cursor.

export type CommandDeps = { store: Store; ids: IdGen };

export type ApplyPlanOptions = {
  /** Validated `.vibecode/project.json` → `product.settings_changed{project}` in the same commit. */
  project?: ProjectConfig;
  /**
   * Set for replans (PRD v > 1): `prd.summarized{version, summary}` stores the plan summary on
   * that PRD version and `inbox.created{kind:'replan'}` posts it, both in the same commit.
   */
  replan?: { version: number; summary: string };
};

export type ApplyPlanResult =
  | {
      ok: true;
      events: Event[];
      /** Plan key → id of the issue created for it. */
      createdIds: Record<string, IssueId>;
    }
  | { ok: false; reason: string };

type Fail = { ok: false; reason: string };
type Built = { ok: true; drafts: EventDraft[]; createdIds: Record<string, IssueId> } | Fail;

type CancellableStatus = Exclude<IssueStatus, 'completed' | 'cancelled'>;
const isCancellableStatus = (s: IssueStatus): s is CancellableStatus =>
  s !== 'completed' && s !== 'cancelled';

const fail = (reason: string): Fail => ({ ok: false, reason });

/** Mutable state while the plan's ops are checked one by one. */
type Board = {
  productId: ProductId;
  product: ProductState;
  /** Every issue of the product, as it will be after the ops so far (incl. new ones). */
  issues: Map<IssueId, IssueView>;
  existingIds: ReadonlySet<string>;
  keys: Map<string, IssueId>;
  nextNumber: number;
  drafts: EventDraft[];
};

export function applyPlan(
  deps: CommandDeps,
  productId: ProductId,
  plan: PlanResult,
  consumedSeq: number,
  opts: ApplyPlanOptions = {},
): ApplyPlanResult {
  const parsed = PlanResultSchema.safeParse(plan);
  if (!parsed.success) return fail(`invalid plan: ${z.prettifyError(parsed.error)}`);
  const project =
    opts.project === undefined ? undefined : ProjectConfigSchema.safeParse(opts.project);
  if (project?.success === false) {
    return fail(`invalid project config: ${z.prettifyError(project.error)}`);
  }
  let built: Built = fail('plan was not applied');
  const events = deps.store.commit((tx) => {
    built = buildPlan(tx.q, deps.ids, productId, parsed.data, consumedSeq, {
      ...(project === undefined ? {} : { project: project.data }),
      ...(opts.replan === undefined ? {} : { replan: opts.replan }),
    });
    return built.ok ? built.drafts : [];
  });
  // Reassigned inside the builder; TS cannot see that the callback ran.
  const result = built as Built;
  return result.ok ? { ok: true, events, createdIds: result.createdIds } : result;
}

function buildPlan(
  q: Queries,
  ids: IdGen,
  productId: ProductId,
  plan: PlanResult,
  consumedSeq: number,
  opts: ApplyPlanOptions,
): Built {
  const product = q.product(productId);
  if (product === null) return fail(`unknown product "${productId}"`);
  if (!Number.isInteger(consumedSeq) || consumedSeq < product.orchestratorCursor) {
    return fail(
      `consumed seq ${consumedSeq} is behind the orchestrator cursor ${product.orchestratorCursor}`,
    );
  }
  const existing = q.issuesByProduct(productId);
  const board: Board = {
    productId,
    product,
    issues: new Map(existing.map(({ productId: _p, ...view }) => [view.id, view])),
    existingIds: new Set(existing.map((i) => i.id)),
    keys: new Map(),
    nextNumber: nextIssueNumber(existing),
    drafts: [],
  };
  const keyed = allocateKeys(board, plan.issueOps, ids);
  if (!keyed.ok) return keyed;

  for (const op of plan.issueOps) {
    const applied = applyOp(board, op);
    if (!applied.ok) return applied;
  }
  const cycle = findDependencyCycle(
    new Map([...board.issues].map(([id, issue]) => [id, issue.dependsOn])),
  );
  if (cycle !== null) return fail(`dependency cycle: ${describePath(board, cycle)}`);

  // New or reopened work means a complete product is building again (flow 9). Cancels alone
  // leave nothing to do, so they keep it complete.
  const reopens = plan.issueOps.some((op) => op.op === 'create' || op.op === 'rewrite');
  if (product.phase === 'complete' && reopens) {
    board.drafts.push({
      type: 'product.phase_changed',
      productId,
      entityId: null,
      v: 1,
      data: { phase: 'building' },
    });
  }

  for (const text of plan.questions) {
    board.drafts.push({
      type: 'question.asked',
      productId,
      entityId: ids.next('question'),
      v: 1,
      data: { target: 'orchestrator', issueId: null, agentId: null, text },
    });
  }
  if (opts.project !== undefined) {
    board.drafts.push({
      type: 'product.settings_changed',
      productId,
      entityId: null,
      v: 1,
      data: { project: opts.project },
    });
  }
  if (opts.replan !== undefined) {
    board.drafts.push({
      type: 'prd.summarized',
      productId,
      entityId: null,
      v: 1,
      data: { version: opts.replan.version, summary: opts.replan.summary },
    });
    board.drafts.push({
      type: 'inbox.created',
      productId,
      entityId: ids.next('inbox'),
      v: 1,
      data: {
        kind: 'replan',
        title: `Plan updated for ${product.name}`,
        body: opts.replan.summary,
        link: `/products/${productId}`,
      },
    });
  }
  board.drafts.push({
    type: 'orchestrator.cursor_advanced',
    productId,
    entityId: null,
    v: 1,
    data: { cursor: consumedSeq },
  });
  return { ok: true, drafts: board.drafts, createdIds: Object.fromEntries(board.keys) };
}

/** Gives every create op an id up front, so ops may depend on keys created later. */
function allocateKeys(board: Board, ops: readonly IssueOp[], ids: IdGen): { ok: true } | Fail {
  for (const op of ops) {
    if (op.op !== 'create') continue;
    if (board.keys.has(op.key)) return fail(`duplicate key "${op.key}"`);
    if (board.existingIds.has(op.key)) {
      return fail(`key "${op.key}" is already the id of an existing issue`);
    }
    board.keys.set(op.key, ids.next('issue'));
  }
  return { ok: true };
}

function applyOp(board: Board, op: IssueOp): { ok: true } | Fail {
  switch (op.op) {
    case 'create':
      return createIssue(board, op);
    case 'edit':
      return editIssue(board, op);
    case 'cancel':
      return cancelIssue(board, op);
    case 'rewrite':
      return rewriteIssue(board, op);
    default:
      return assertNever(op);
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled issue op: ${JSON.stringify(x)}`);
}

type OpOf<K extends IssueOp['op']> = Extract<IssueOp, { op: K }>;

/** Dependency context from the working copy, so an issue cancelled earlier in the plan counts. */
function dependsOnContext(board: Board): DependsOnContext<IssueId> {
  const cancelledIds = new Set<string>();
  for (const issue of board.issues.values()) {
    if (issue.status === 'cancelled') cancelledIds.add(issue.id);
  }
  return { keys: board.keys, existingIds: board.existingIds, cancelledIds };
}

function createIssue(board: Board, op: OpOf<'create'>): { ok: true } | Fail {
  const deps = resolveDependsOn(op.dependsOn, dependsOnContext(board));
  if (!deps.ok) return fail(`create "${op.key}": ${deps.reason}`);
  const id = board.keys.get(op.key);
  if (id === undefined) throw new Error(`no id allocated for key "${op.key}"`);
  const issue: IssueView = {
    id,
    number: board.nextNumber++,
    title: op.title,
    body: op.body,
    status: 'open',
    rev: 1,
    priority: op.priority ?? 0,
    origin: 'orchestrator',
    prdVersion: board.product.prdVersion,
    attemptCount: 0,
    heldQuestionId: null,
    runAfter: 0,
    mergedOrder: null,
    mergeSha: null,
    failureReason: null,
    dependsOn: deps.ids,
  };
  board.issues.set(id, issue);
  board.drafts.push({
    type: 'issue.created',
    productId: board.productId,
    entityId: id,
    v: 1,
    data: { issue },
  });
  return { ok: true };
}

/** An existing issue of this product, in its current working state. */
function existingIssue(
  board: Board,
  id: string,
  op: string,
): { ok: true; issue: IssueView } | Fail {
  const issue = board.existingIds.has(id) ? board.issues.get(id as IssueId) : undefined;
  return issue === undefined ? fail(`${op}: unknown issue "${id}"`) : { ok: true, issue };
}

function editIssue(board: Board, op: OpOf<'edit'>): { ok: true } | Fail {
  const found = existingIssue(board, op.id, 'edit');
  if (!found.ok) return found;
  const { issue } = found;
  if (issue.status !== 'open' && issue.status !== 'failed') {
    return fail(
      `edit #${issue.number}: only open or failed issues can be edited, it is ${issue.status}`,
    );
  }
  let dependsOn: IssueId[] | undefined;
  if (op.dependsOn !== undefined) {
    const deps = resolveDependsOn(op.dependsOn, dependsOnContext(board));
    if (!deps.ok) return fail(`edit #${issue.number}: ${deps.reason}`);
    dependsOn = deps.ids;
  }
  const next: IssueView = {
    ...issue,
    rev: issue.rev + 1,
    title: op.title ?? issue.title,
    body: op.body ?? issue.body,
    dependsOn: dependsOn ?? issue.dependsOn,
    priority: op.priority ?? issue.priority,
  };
  board.issues.set(issue.id, next);
  board.drafts.push({
    type: 'issue.edited',
    productId: board.productId,
    entityId: issue.id,
    v: 1,
    data: {
      rev: next.rev,
      ...(op.title === undefined ? {} : { title: op.title }),
      ...(op.body === undefined ? {} : { body: op.body }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
      ...(op.priority === undefined ? {} : { priority: op.priority }),
    },
  });
  return { ok: true };
}

function cancelIssue(board: Board, op: OpOf<'cancel'>): { ok: true } | Fail {
  const found = existingIssue(board, op.id, 'cancel');
  if (!found.ok) return found;
  const { issue } = found;
  const t = transition(issue, { type: 'cancel' }, board.product.settings);
  if (!t.ok) return fail(`cancel #${issue.number}: ${t.reason}`);
  const from = issue.status;
  if (!isCancellableStatus(from)) throw new Error(`transition allowed cancelling a ${from} issue`);
  board.issues.set(issue.id, t.next);
  board.drafts.push({
    type: 'issue.cancelled',
    productId: board.productId,
    entityId: issue.id,
    v: 1,
    data: { from, by: 'orchestrator', reason: op.reason },
  });
  return { ok: true };
}

function rewriteIssue(board: Board, op: OpOf<'rewrite'>): { ok: true } | Fail {
  const found = existingIssue(board, op.id, 'rewrite');
  if (!found.ok) return found;
  const { issue } = found;
  const t = transition(issue, { type: 'rewrite', body: op.body }, board.product.settings);
  if (!t.ok) return fail(`rewrite #${issue.number}: ${t.reason}`);
  board.issues.set(issue.id, t.next);
  board.drafts.push({
    type: 'issue.rewritten',
    productId: board.productId,
    entityId: issue.id,
    v: 1,
    data: { rev: t.next.rev, body: t.next.body },
  });
  return { ok: true };
}

/** "#1 → #3 → #1", using plan keys for issues the plan creates. */
function describePath(board: Board, path: readonly string[]): string {
  const keyOf = new Map([...board.keys].map(([key, id]) => [id as string, key]));
  return path
    .map((id) => {
      const key = keyOf.get(id);
      const n = board.issues.get(id as IssueId)?.number;
      return key === undefined ? `#${n ?? id}` : `"${key}"`;
    })
    .join(' → ');
}
