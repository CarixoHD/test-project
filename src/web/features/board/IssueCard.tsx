import { Link } from 'react-router';
import type { IssueState } from '../../../shared/state.ts';
import { StatusBadge } from '../../ui/index.ts';
import { ISSUE_STATUS_BADGE } from '../issues/issue-status.ts';

export interface IssueCardProps {
  issue: IssueState;
  /** Dependencies that are not completed yet. */
  blockedBy: readonly IssueState[];
  maxAttempts: number;
}

/** One issue on the board. The title links to the issue detail; status is always in words. */
export function IssueCard({ issue, blockedBy, maxAttempts }: IssueCardProps) {
  const badge = ISSUE_STATUS_BADGE[issue.status];
  return (
    <li className="issue-card">
      <Link className="issue-card__title" to={`/products/${issue.productId}/issues/${issue.id}`}>
        #{issue.number} {issue.title}
      </Link>
      <p className="issue-card__meta">
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        {issue.heldQuestionId !== null && (
          <StatusBadge tone="warning">Waiting for owner</StatusBadge>
        )}
      </p>
      <p className="issue-card__facts">
        <span>Priority {issue.priority}</span>
        <span>
          Attempt {issue.attemptCount} of {maxAttempts}
        </span>
      </p>
      {blockedBy.length > 0 && (
        <p className="issue-card__blocked">
          Blocked by {blockedBy.map((dep) => `#${String(dep.number)}`).join(', ')}
        </p>
      )}
    </li>
  );
}
