import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { IssueIdSchema } from '../../../shared/ids.ts';
import type { IssueState } from '../../../shared/state.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { Button, Markdown, StatusBadge } from '../../ui/index.ts';
import { QuestionAnswer } from '../inbox/index.ts';
import { issueCostText } from '../products/cost-format.ts';
import { attemptsOf } from './attempt-text.ts';
import { AttemptList } from './AttemptList.tsx';
import { CancelIssueDialog, isCancellable } from './CancelIssueDialog.tsx';
import { EditIssueDialog, isEditable } from './EditIssueDialog.tsx';
import { PRIORITY_OPTIONS } from './IssueFields.tsx';
import { ISSUE_STATUS_BADGE } from './issue-status.ts';

const selectIssues = (s: AppSnapshot) => s.state.issues;
const selectAttempts = (s: AppSnapshot) => s.state.attempts;

/** "High", or the raw number for a priority outside the named choices. */
function priorityText(priority: number): string {
  return PRIORITY_OPTIONS.find((o) => o.value === priority)?.label ?? `Priority ${priority}`;
}

/**
 * `/products/:id/issues/:issueId`: one issue with its facts, the owner's Edit/Cancel actions,
 * a held question, and every attempt with its log, diff, check output and review.
 */
export function IssuePage() {
  const { id = '', issueId = '' } = useParams();
  const parsedId = IssueIdSchema.safeParse(issueId).data;
  const issue = useApp((s) => (parsedId ? s.state.issues[parsedId] : undefined));
  const loaded = useApp((s) => s.loaded);
  const backLink = <Link to={`/products/${id}`}>Back to the product</Link>;

  if (issue === undefined || issue.productId !== id) {
    return (
      <>
        <h1>{loaded ? 'Issue not found' : 'Loading issue…'}</h1>
        <p>{backLink}</p>
      </>
    );
  }
  return (
    <>
      <p>{backLink}</p>
      <IssueDetail issue={issue} />
    </>
  );
}

function IssueDetail({ issue }: { issue: IssueState }) {
  const [dialog, setDialog] = useState<'edit' | 'cancel' | null>(null);
  const issues = useApp(selectIssues);
  const allAttempts = useApp(selectAttempts);
  const attempts = useMemo(() => attemptsOf(allAttempts, issue.id), [allAttempts, issue.id]);
  const maxAttempts = useApp((s) => s.state.products[issue.productId]?.settings.maxAttempts);
  const usage = useApp((s) => s.state.usage.byIssue[issue.id]);
  const question = useApp((s) =>
    issue.heldQuestionId === null ? undefined : s.state.questions[issue.heldQuestionId],
  );
  const badge = ISSUE_STATUS_BADGE[issue.status];
  const cost = issueCostText(usage);
  const number = `#${String(issue.number)}`;
  const close = () => setDialog(null);

  return (
    <article className="issue-detail">
      <header className="issue-detail__header">
        <h1>
          {number} {issue.title}
        </h1>
        <div className="issue-detail__actions">
          {isEditable(issue) && (
            <Button aria-label={`Edit issue ${number}`} onClick={() => setDialog('edit')}>
              Edit
            </Button>
          )}
          {isCancellable(issue) && (
            <Button aria-label={`Cancel issue ${number}`} onClick={() => setDialog('cancel')}>
              Cancel
            </Button>
          )}
        </div>
      </header>

      <dl className="issue-detail__facts">
        <dt>Status</dt>
        <dd>
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        </dd>
        <dt>Priority</dt>
        <dd>{priorityText(issue.priority)}</dd>
        <dt>Depends on</dt>
        <dd>
          {issue.dependsOn.length === 0 ? (
            'Nothing'
          ) : (
            <ul className="issue-detail__deps">
              {issue.dependsOn.map((depId) => {
                const dep = issues[depId];
                return (
                  <li key={depId}>
                    {dep === undefined ? (
                      'Unknown issue'
                    ) : (
                      <Link to={`/products/${dep.productId}/issues/${dep.id}`}>
                        #{dep.number} {dep.title}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </dd>
        <dt>Attempts used</dt>
        <dd>
          {issue.attemptCount}
          {maxAttempts !== undefined && ` of ${String(maxAttempts)}`}
        </dd>
        <dt>Cost</dt>
        <dd>{cost ?? 'No usage yet'}</dd>
        {issue.failureReason !== null && (
          <>
            <dt>{issue.status === 'failed' ? 'Failure reason' : 'Last failure'}</dt>
            <dd>
              <pre className="attempt__text">{issue.failureReason}</pre>
            </dd>
          </>
        )}
      </dl>

      {question !== undefined && (
        <section className="issue-detail__question" aria-labelledby="held-question">
          <h2 id="held-question">Waiting for your answer</h2>
          <p>{question.text}</p>
          <QuestionAnswer question={question} />
        </section>
      )}

      <section aria-labelledby="issue-body">
        <h2 id="issue-body">Description</h2>
        {issue.body.trim() === '' ? <p>No description.</p> : <Markdown>{issue.body}</Markdown>}
      </section>

      <section aria-labelledby="issue-attempts">
        <h2 id="issue-attempts">Attempts</h2>
        <AttemptList attempts={attempts} />
      </section>

      <EditIssueDialog issue={issue} open={dialog === 'edit'} onClose={close} />
      <CancelIssueDialog issue={issue} open={dialog === 'cancel'} onClose={close} />
    </article>
  );
}
