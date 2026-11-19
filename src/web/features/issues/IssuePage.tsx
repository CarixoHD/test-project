import { Link, useParams } from 'react-router';
import { IssueIdSchema } from '../../../shared/ids.ts';
import { useApp } from '../../state/store.ts';
import { StatusBadge } from '../../ui/index.ts';
import { ISSUE_STATUS_BADGE } from './issue-status.ts';

/** `/products/:id/issues/:issueId`: issue detail. Placeholder until the issues feature lands. */
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
  const badge = ISSUE_STATUS_BADGE[issue.status];
  return (
    <>
      <h1>
        #{issue.number} {issue.title}
      </h1>
      <p>
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
      </p>
      <p>{backLink}</p>
    </>
  );
}
