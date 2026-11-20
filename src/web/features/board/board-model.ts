import type { IssueStatus } from '../../../shared/domain.ts';
import type { ProductId } from '../../../shared/ids.ts';
import type { IssueState } from '../../../shared/state.ts';
import { ISSUE_STATUS_BADGE } from '../issues/issue-status.ts';

// Pure board logic: which column an issue sits in, what blocks it, and how status changes are
// put into words for the live region. Kept out of the components so it is tested directly.

export type IssuesById = Readonly<Partial<Record<string, IssueState>>>;

export interface BoardColumn {
  status: IssueStatus;
  label: string;
  /** Starts collapsed (cancelled work is rarely interesting). */
  collapsed: boolean;
}

export const BOARD_COLUMNS: readonly BoardColumn[] = (
  ['open', 'in_progress', 'in_review', 'completed', 'failed', 'cancelled'] as const
).map((status) => ({
  status,
  label: ISSUE_STATUS_BADGE[status].label,
  collapsed: status === 'cancelled',
}));

/** More changes than this in one announcement are summarised as a count. */
export const MAX_NAMED_CHANGES = 3;

const byPriorityThenNumber = (a: IssueState, b: IssueState): number =>
  b.priority - a.priority || a.number - b.number;

/** The product's issues per status column, in the scheduler's ready order. */
export function groupIntoColumns(
  issues: IssuesById,
  productId: ProductId,
): Record<IssueStatus, IssueState[]> {
  const cols: Record<IssueStatus, IssueState[]> = {
    open: [],
    in_progress: [],
    in_review: [],
    completed: [],
    failed: [],
    cancelled: [],
  };
  for (const issue of Object.values(issues)) {
    if (issue?.productId === productId) cols[issue.status].push(issue);
  }
  for (const list of Object.values(cols)) list.sort(byPriorityThenNumber);
  return cols;
}

/** Dependencies of `issue` that are known and not completed yet, by number. */
export function unmetDependencies(issue: IssueState, issues: IssuesById): IssueState[] {
  return issue.dependsOn
    .map((id) => issues[id])
    .filter((dep): dep is IssueState => dep !== undefined && dep.status !== 'completed')
    .sort((a, b) => a.number - b.number);
}

export interface StatusChange {
  id: string;
  status: IssueStatus;
}

/** Issues of the product that exist in both maps and whose status differs. */
export function diffStatuses(
  before: IssuesById,
  after: IssuesById,
  productId: ProductId,
): StatusChange[] {
  const changes: StatusChange[] = [];
  for (const issue of Object.values(after)) {
    if (issue?.productId !== productId) continue;
    const prev = before[issue.id];
    if (prev !== undefined && prev.status !== issue.status) {
      changes.push({ id: issue.id, status: issue.status });
    }
  }
  return changes;
}

/** One sentence per change for a few changes, a count for many. */
export function describeStatusChanges(
  changes: readonly StatusChange[],
  issues: IssuesById,
): string {
  if (changes.length === 0) return '';
  if (changes.length > MAX_NAMED_CHANGES) return `${String(changes.length)} issues changed status.`;
  return changes
    .map((c) => {
      const issue = issues[c.id];
      const name = issue ? `#${String(issue.number)} ${issue.title}` : 'An issue';
      return `${name} is now ${ISSUE_STATUS_BADGE[c.status].label}.`;
    })
    .join(' ');
}
