import type { IssueStatus } from '../../../shared/domain.ts';
import type { BadgeTone } from '../../ui/index.ts';

/** Text and tone for an issue status badge; the text always carries the meaning. */
export const ISSUE_STATUS_BADGE: Record<IssueStatus, { label: string; tone: BadgeTone }> = {
  open: { label: 'Open', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'progress' },
  in_review: { label: 'In review', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'warning' },
};
