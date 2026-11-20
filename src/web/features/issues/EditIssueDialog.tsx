import { useId, useRef, useState, type FormEvent } from 'react';
import type { IssueState } from '../../../shared/state.ts';
import { ApiError, editIssue } from '../../state/api.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { Button, Dialog, Markdown } from '../../ui/index.ts';
import { ISSUE_STATUS_BADGE } from './issue-status.ts';
import { IssueFields, PriorityField, TITLE_REQUIRED, type IssueDraft } from './IssueFields.tsx';

export interface EditIssueDialogProps {
  /** The live issue from the store; its latest values are shown when an edit is stale. */
  issue: IssueState;
  open: boolean;
  onClose: () => void;
}

export const STALE_REV_MESSAGE = 'This issue changed meanwhile — reload and retry';

/** Statuses the server accepts edits for (completed and cancelled issues are final). */
export function isEditable(issue: IssueState): boolean {
  return issue.status !== 'completed' && issue.status !== 'cancelled';
}

/** "Edit issue #n": edits title, body, dependencies and priority, guarded by the issue's `rev`. */
export function EditIssueDialog({ issue, open, onClose }: EditIssueDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={`Edit issue #${String(issue.number)}`}>
      <EditIssueForm issue={issue} onDone={onClose} />
    </Dialog>
  );
}

const draftOf = (issue: IssueState): IssueDraft => ({
  title: issue.title,
  body: issue.body,
  dependsOn: [...issue.dependsOn],
});

type Problem = { kind: 'stale' } | { kind: 'error'; message: string } | null;

function EditIssueForm({ issue, onDone }: { issue: IssueState; onDone: () => void }) {
  // The form edits a copy taken at open (or reload) time; `baseRev` is that copy's revision.
  const [draft, setDraft] = useState<IssueDraft>(() => draftOf(issue));
  const [baseRev, setBaseRev] = useState(issue.rev);
  // `basePriority` is the priority the form opened with; priority is sent only when it changed.
  const [priority, setPriority] = useState(issue.priority);
  const [basePriority, setBasePriority] = useState(issue.priority);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [isSubmitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  function reload() {
    setDraft(draftOf(issue));
    setBaseRev(issue.rev);
    setPriority(issue.priority);
    setBasePriority(issue.priority);
    setProblem(null);
    titleRef.current?.focus();
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSubmitting) return;
    setProblem(null);
    const title = draft.title.trim();
    if (title === '') {
      setTitleError(TITLE_REQUIRED);
      titleRef.current?.focus();
      return;
    }
    setTitleError(null);
    setSubmitting(true);
    try {
      await editIssue(issue.id, {
        title,
        body: draft.body,
        dependsOn: draft.dependsOn,
        ...(priority === basePriority ? {} : { priority }),
        rev: baseRev,
      });
      onDone();
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError && err.status === 409 && isEditable(issue)) {
        setProblem({ kind: 'stale' });
      } else {
        setProblem({
          kind: 'error',
          message: err instanceof ApiError ? err.message : 'Could not save the issue.',
        });
      }
    }
  }

  return (
    <form noValidate onSubmit={(e) => void onSubmit(e)}>
      <IssueFields
        productId={issue.productId}
        self={issue.id}
        draft={draft}
        onChange={setDraft}
        titleError={titleError}
        titleRef={titleRef}
      />
      <PriorityField value={priority} onChange={setPriority} />
      {problem?.kind === 'error' ? (
        <p role="alert" className="ui-field__error">
          {problem.message}
        </p>
      ) : null}
      {problem?.kind === 'stale' ? <StaleNotice issue={issue} onReload={reload} /> : null}
      <Button type="submit" variant="primary" aria-disabled={isSubmitting || undefined}>
        {isSubmitting ? 'Saving…' : 'Save changes'}
      </Button>
    </form>
  );
}

/** The stale-rev message with the issue's current values and a way to start over from them. */
function StaleNotice({ issue, onReload }: { issue: IssueState; onReload: () => void }) {
  const headingId = useId();
  return (
    <div className="issue-dialog__stale">
      <p role="alert" className="ui-field__error">
        {STALE_REV_MESSAGE}. Your changes are still in the form; reloading replaces them with the
        latest version below.
      </p>
      <section className="issue-dialog__latest" aria-labelledby={headingId}>
        <h3 id={headingId}>Latest version</h3>
        <p>
          <strong>{issue.title}</strong> ({ISSUE_STATUS_BADGE[issue.status].label}, revision{' '}
          {issue.rev})
        </p>
        <Markdown>{issue.body}</Markdown>
        <DependsOnLine issue={issue} />
      </section>
      <Button onClick={onReload}>Reload latest version</Button>
    </div>
  );
}

const selectIssues = (s: AppSnapshot) => s.state.issues;

function DependsOnLine({ issue }: { issue: IssueState }) {
  const issues = useApp(selectIssues);
  if (issue.dependsOn.length === 0) return <p>No dependencies.</p>;
  const numbers = issue.dependsOn.map((id) => {
    const dep = issues[id];
    return dep === undefined ? id : `#${String(dep.number)}`;
  });
  return <p>Depends on {numbers.join(', ')}.</p>;
}
