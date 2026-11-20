import { useState } from 'react';
import { Link } from 'react-router';
import type { IssueState, QuestionState, UsageTotals } from '../../../shared/state.ts';
import { Button, StatusBadge } from '../../ui/index.ts';
import { CancelIssueDialog, EditIssueDialog, isCancellable, isEditable } from '../issues/index.ts';
import { ISSUE_STATUS_BADGE } from '../issues/issue-status.ts';
import { issueCostText } from '../products/cost-format.ts';

export interface IssueCardProps {
  issue: IssueState;
  /** Dependencies that are not completed yet. */
  blockedBy: readonly IssueState[];
  maxAttempts: number;
  /** The issue's usage totals from ClientState; undefined before any usage. */
  usage?: UsageTotals | undefined;
  /** The question `issue.heldQuestionId` points at, from ClientState; undefined if none. */
  heldQuestion?: QuestionState | undefined;
}

/**
 * The owner still owes an answer: the issue is not cancelled and its held question is neither
 * answered nor withdrawn. `heldQuestionId` stays set after cancel/withdraw (#139), so it alone
 * is not enough.
 */
export function isWaitingForOwner(issue: IssueState, heldQuestion: QuestionState | undefined) {
  return (
    issue.status !== 'cancelled' &&
    issue.heldQuestionId !== null &&
    heldQuestion?.id === issue.heldQuestionId &&
    heldQuestion.answer === null &&
    heldQuestion.withdrawnAt === null
  );
}

/** One issue on the board. The title links to the issue detail; status is always in words. */
export function IssueCard({ issue, blockedBy, maxAttempts, usage, heldQuestion }: IssueCardProps) {
  const badge = ISSUE_STATUS_BADGE[issue.status];
  const cost = issueCostText(usage);
  return (
    <li className="issue-card">
      <Link className="issue-card__title" to={`/products/${issue.productId}/issues/${issue.id}`}>
        #{issue.number} {issue.title}
      </Link>
      <p className="issue-card__meta">
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        {isWaitingForOwner(issue, heldQuestion) && (
          <StatusBadge tone="warning">Waiting for owner</StatusBadge>
        )}
      </p>
      <p className="issue-card__facts">
        <span>Priority {issue.priority}</span>
        {/* attemptCount counts failed attempts, not the current attempt number (#189). */}
        <span>
          {issue.attemptCount} of {maxAttempts} failed attempts used
        </span>
        {cost !== null && <span>Cost: {cost}</span>}
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
