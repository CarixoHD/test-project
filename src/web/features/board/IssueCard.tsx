import { useState } from 'react';
import { Link } from 'react-router';
import type { IssueState } from '../../../shared/state.ts';
import { Button, StatusBadge } from '../../ui/index.ts';
import { CancelIssueDialog, EditIssueDialog, isCancellable, isEditable } from '../issues/index.ts';
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
      <IssueActions issue={issue} />
    </li>
  );
}

type OpenDialog = 'edit' | 'cancel' | null;

/** Edit and Cancel buttons, named with the issue number so they are distinct by keyboard. */
function IssueActions({ issue }: { issue: IssueState }) {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const canEdit = isEditable(issue);
  const canCancel = isCancellable(issue);
  if (!canEdit && !canCancel) return null;
  const number = `#${String(issue.number)}`;
  const close = () => setDialog(null);
  return (
    <div className="issue-card__actions">
      {canEdit && (
        <>
          <Button aria-label={`Edit issue ${number}`} onClick={() => setDialog('edit')}>
            Edit
          </Button>
          <EditIssueDialog issue={issue} open={dialog === 'edit'} onClose={close} />
        </>
      )}
      {canCancel && (
        <>
          <Button aria-label={`Cancel issue ${number}`} onClick={() => setDialog('cancel')}>
            Cancel
          </Button>
          <CancelIssueDialog issue={issue} open={dialog === 'cancel'} onClose={close} />
        </>
      )}
    </div>
  );
}
