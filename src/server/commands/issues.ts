import type { IssueStatus, IssueView } from '../../shared/domain.ts';
import type { Event, EventDraft } from '../../shared/events.ts';
import type { IssueId, ProductId } from '../../shared/ids.ts';
import { transition } from '../../shared/issues.ts';
import type { IssueState } from '../../shared/state.ts';
import type { Queries } from '../store/index.ts';
import type { CommandDeps } from './apply-plan.ts';
import { findDependencyCycle, nextIssueNumber, resolveDependsOn } from './issue-graph.ts';

// Owner issue commands (ARCHITECTURE §6 flow 7): add, edit (rev-guarded) and cancel.
// Each validates against the projections inside the commit and emits nothing on failure.

/** A refused owner command; `code` picks the HTTP status (invalid 400, not_found 404, conflict 409). */
export type IssueCommandFailure = {
  ok: false;
  reason: string;
  code: 'invalid' | 'not_found' | 'conflict';
};

export type AddIssueInput = {
  title: string;
  body: string;
  /** Ids of existing, non-cancelled issues of the same product. */
  dependsOn: readonly string[];
  priority?: number | undefined;
};
export type AddIssueResult =
  { ok: true; events: Event[]; issueId: IssueId; number: number } | IssueCommandFailure;

export type EditIssueInput = {
  title?: string | undefined;
  body?: string | undefined;
  dependsOn?: readonly string[] | undefined;
  priority?: number | undefined;
  /** The revision the owner's edit is based on; a different current rev is a conflict. */
  rev: number;
};
export type EditIssueResult = { ok: true; events: Event[]; rev: number } | IssueCommandFailure;

export type CancelIssueResult = { ok: true; events: Event[] } | IssueCommandFailure;

/** Statuses an owner may edit; completed and cancelled issues are final. */
const EDITABLE: readonly IssueStatus[] = ['open', 'failed', 'in_progress', 'in_review'];

const failure = (code: IssueCommandFailure['code'], reason: string): IssueCommandFailure => ({
  ok: false,
  code,
  reason,
});

type Built<T> = ({ ok: true; drafts: EventDraft[] } & T) | IssueCommandFailure;

/** Runs `build` inside one commit; its drafts are committed only when it succeeds. */
function commitBuilt<T extends object>(
  deps: CommandDeps,
  build: (q: Queries) => Built<T>,
): ({ ok: true; events: Event[] } & Omit<T, 'drafts'>) | IssueCommandFailure {
  let built: Built<T> = failure('invalid', 'command was not applied');
  const events = deps.store.commit((tx) => {
    built = build(tx.q);
    return built.ok ? built.drafts : [];
  });
  // Reassigned inside the builder; TS cannot see that the callback ran.
  const result = built as Built<T>;
  if (!result.ok) return result;
  const { ok: _ok, drafts: _drafts, ...rest } = result;
  return { ok: true, events, ...rest };
}

/** Dependencies resolved against the product's current issues (no plan keys). */
function resolveOwnerDeps(refs: readonly string[], issues: readonly IssueState[]) {
  return resolveDependsOn<IssueId>(refs, {
    keys: new Map(),
    existingIds: new Set(issues.map((i) => i.id)),
    cancelledIds: new Set(issues.filter((i) => i.status === 'cancelled').map((i) => i.id)),
  });
}

/** A cycle in the product's dependency graph, as "#1 → #3 → #1", or null. */
function cycleIn(issues: readonly Pick<IssueView, 'id' | 'number' | 'dependsOn'>[]): string | null {
  const cycle = findDependencyCycle(new Map(issues.map((i) => [i.id as string, i.dependsOn])));
  if (cycle === null) return null;
  const numberOf = new Map(issues.map((i) => [i.id as string, i.number]));
  return cycle.map((id) => `#${numberOf.get(id) ?? id}`).join(' → ');
}

function issueOf(q: Queries, id: IssueId): IssueState | IssueCommandFailure {
  return q.issue(id) ?? failure('not_found', `unknown issue "${id}"`);
}

/**
 * Adds an owner issue: next per-product number, origin owner, the product's prd version.
 * A complete product goes back to building in the same commit.
 */
export function addIssue(
  deps: CommandDeps,
  productId: ProductId,
  input: AddIssueInput,
): AddIssueResult {
  return commitBuilt<{ issueId: IssueId; number: number }>(deps, (q) => {
    const product = q.product(productId);
    if (product === null) return failure('not_found', `unknown product "${productId}"`);
    const existing = q.issuesByProduct(productId);
    const resolved = resolveOwnerDeps(input.dependsOn, existing);
    if (!resolved.ok) return failure('invalid', resolved.reason);
    const issue: IssueView = {
      id: deps.ids.next('issue'),
      number: nextIssueNumber(existing),
      title: input.title,
      body: input.body,
      status: 'open',
      rev: 1,
      priority: input.priority ?? 0,
      origin: 'owner',
      prdVersion: product.prdVersion,
      attemptCount: 0,
      heldQuestionId: null,
      runAfter: 0,
      mergedOrder: null,
      mergeSha: null,
      failureReason: null,
      dependsOn: resolved.ids,
    };
    const drafts: EventDraft[] = [
      { type: 'issue.created', productId, entityId: issue.id, v: 1, data: { issue } },
    ];
    if (product.phase === 'complete') {
      drafts.push({
        type: 'product.phase_changed',
        productId,
        entityId: null,
        v: 1,
        data: { phase: 'building' },
      });
    }
    return { ok: true, drafts, issueId: issue.id, number: issue.number };
  });
}

/**
 * Edits an issue that is not yet final. `rev` must be the current rev (else conflict); the
 * edit bumps it, so an in-flight attempt on the old rev discards itself at merge time.
 */
export function editIssue(deps: CommandDeps, id: IssueId, input: EditIssueInput): EditIssueResult {
  return commitBuilt<{ rev: number }>(deps, (q) => {
    const issue = issueOf(q, id);
    if (!('id' in issue)) return issue;
    if (!EDITABLE.includes(issue.status)) {
      return failure('conflict', `cannot edit an issue that is ${issue.status}`);
    }
    if (input.rev !== issue.rev) {
      return failure(
        'conflict',
        `stale rev ${input.rev}: #${issue.number} was changed, its current rev is ${issue.rev}`,
      );
    }
    const issues = q.issuesByProduct(issue.productId);
    let dependsOn: IssueId[] | undefined;
    if (input.dependsOn !== undefined) {
      const resolved = resolveOwnerDeps(input.dependsOn, issues);
      if (!resolved.ok) return failure('invalid', resolved.reason);
      dependsOn = resolved.ids;
      const cycle = cycleIn(
        issues.map((i) => (i.id === id ? { ...i, dependsOn: resolved.ids } : i)),
      );
      if (cycle !== null) return failure('invalid', `dependency cycle: ${cycle}`);
    }
    const rev = issue.rev + 1;
    const draft: EventDraft = {
      type: 'issue.edited',
      productId: issue.productId,
      entityId: id,
      v: 1,
      data: {
        rev,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(dependsOn === undefined ? {} : { dependsOn }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
      },
    };
    return { ok: true, drafts: [draft], rev };
  });
}

/** Cancels an issue through the transition guards (completed or cancelled → conflict). */
export function cancelIssue(deps: CommandDeps, id: IssueId): CancelIssueResult {
  return commitBuilt<object>(deps, (q) => {
    const issue = issueOf(q, id);
    if (!('id' in issue)) return issue;
    const product = q.product(issue.productId);
    if (product === null) throw new Error(`issue ${id} has no product ${issue.productId}`);
    const t = transition(issue, { type: 'cancel' }, product.settings);
    const from = issue.status;
    if (!t.ok) return failure('conflict', t.reason);
    if (from === 'completed' || from === 'cancelled') {
      throw new Error(`transition allowed cancelling a ${from} issue`);
    }
    const draft: EventDraft = {
      type: 'issue.cancelled',
      productId: issue.productId,
      entityId: id,
      v: 1,
      data: { from, by: 'owner', reason: 'cancelled by the owner' },
    };
    return { ok: true, drafts: [draft] };
  });
}
