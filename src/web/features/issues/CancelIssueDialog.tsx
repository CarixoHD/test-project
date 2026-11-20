import { useState } from 'react';
import type { IssueState } from '../../../shared/state.ts';
import { ApiError, cancelIssue } from '../../state/api.ts';
import { Button, Dialog } from '../../ui/index.ts';

export interface CancelIssueDialogProps {
  issue: IssueState;
  open: boolean;
  onClose: () => void;
}

/** Whether the owner can still cancel the issue (completed and cancelled are final). */
export function isCancellable(issue: IssueState): boolean {
  return issue.status !== 'completed' && issue.status !== 'cancelled';
}

/** Confirmation before cancelling; the card moves to Cancelled when `issue.cancelled` arrives. */
export function CancelIssueDialog({ issue, open, onClose }: CancelIssueDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={`Cancel issue #${String(issue.number)}?`}>
      <CancelConfirm issue={issue} onDone={onClose} />
    </Dialog>
  );
}

function CancelConfirm({ issue, onDone }: { issue: IssueState; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);

  async function confirm() {
    if (isSubmitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await cancelIssue(issue.id);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the issue.');
      setSubmitting(false);
    }
  }

  return (
    <>
      <p>“{issue.title}” moves to Cancelled and will not be built. This cannot be undone.</p>
      {error !== null ? (
        <p role="alert" className="ui-field__error">
          {error}
        </p>
      ) : null}
      <div className="issue-dialog__actions">
        <Button onClick={onDone}>Keep issue</Button>
        <Button
          variant="danger"
          aria-disabled={isSubmitting || undefined}
          onClick={() => void confirm()}
        >
          {isSubmitting ? 'Cancelling…' : 'Cancel issue'}
        </Button>
      </div>
    </>
  );
}
