import { useRef, useState, type FormEvent } from 'react';
import type { ProductId } from '../../../shared/ids.ts';
import { addIssue, ApiError } from '../../state/api.ts';
import { Button, Dialog } from '../../ui/index.ts';
import { IssueFields, PriorityField, TITLE_REQUIRED, type IssueDraft } from './IssueFields.tsx';

export interface AddIssueDialogProps {
  productId: ProductId;
  open: boolean;
  onClose: () => void;
}

/** "Add issue" dialog: the new card arrives on the board as `issue.created`. */
export function AddIssueDialog({ productId, open, onClose }: AddIssueDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Add issue">
      <AddIssueForm productId={productId} onDone={onClose} />
    </Dialog>
  );
}

function AddIssueForm({ productId, onDone }: { productId: ProductId; onDone: () => void }) {
  const [draft, setDraft] = useState<IssueDraft>({ title: '', body: '', dependsOn: [] });
  const [priority, setPriority] = useState(0);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSubmitting) return;
    setServerError(null);
    const title = draft.title.trim();
    if (title === '') {
      setTitleError(TITLE_REQUIRED);
      titleRef.current?.focus();
      return;
    }
    setTitleError(null);
    setSubmitting(true);
    try {
      await addIssue(productId, { title, body: draft.body, priority, dependsOn: draft.dependsOn });
      onDone();
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not add the issue.');
      setSubmitting(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => void onSubmit(e)}>
      <IssueFields
        productId={productId}
        draft={draft}
        onChange={setDraft}
        titleError={titleError}
        titleRef={titleRef}
      />
      <PriorityField value={priority} onChange={setPriority} />
      {serverError !== null ? (
        <p role="alert" className="ui-field__error">
          {serverError}
        </p>
      ) : null}
      <Button type="submit" variant="primary" aria-disabled={isSubmitting || undefined}>
        {isSubmitting ? 'Creating…' : 'Create issue'}
      </Button>
    </form>
  );
}
