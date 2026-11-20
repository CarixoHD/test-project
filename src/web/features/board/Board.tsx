import { useId, useMemo, useState } from 'react';
import type { IssueState, ProductState, UsageTotals } from '../../../shared/state.ts';
import type { IssueId } from '../../../shared/ids.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import {
  BOARD_COLUMNS,
  groupIntoColumns,
  unmetDependencies,
  type BoardColumn,
  type IssuesById,
} from './board-model.ts';
import { Button } from '../../ui/index.ts';
import { AddIssueDialog } from '../issues/index.ts';
import { IssueCard } from './IssueCard.tsx';
import { useStatusAnnouncer } from './use-status-announcer.ts';

/** How long status changes are collected before one combined announcement. */
export const ANNOUNCE_DELAY_MS = 1_500;

const selectIssues = (s: AppSnapshot) => s.state.issues;
const selectLoaded = (s: AppSnapshot) => s.loaded;
const selectIssueUsage = (s: AppSnapshot) => s.state.usage.byIssue;

/** The product's issues in status columns, updated live from the store. */
export function Board({ product }: { product: ProductState }) {
  const issues = useApp(selectIssues);
  const loaded = useApp(selectLoaded);
  const usage = useApp(selectIssueUsage);
  const columns = useMemo(() => groupIntoColumns(issues, product.id), [issues, product.id]);
  const announcement = useStatusAnnouncer(issues, product.id, loaded, ANNOUNCE_DELAY_MS);
  const headingId = useId();
  const [isAdding, setAdding] = useState(false);

  return (
    <section className="board" aria-labelledby={headingId}>
      <div className="board__header">
        <h2 id={headingId}>Issues</h2>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add issue
        </Button>
      </div>
      <AddIssueDialog productId={product.id} open={isAdding} onClose={() => setAdding(false)} />
      <div className="board__columns">
        {BOARD_COLUMNS.map((column) => (
          <Column
            key={column.status}
            column={column}
            issues={columns[column.status]}
            all={issues}
            usage={usage}
            maxAttempts={product.settings.maxAttempts}
          />
        ))}
      </div>
      <p className="visually-hidden" aria-live="polite" data-testid="board-announcer">
        {announcement}
      </p>
    </section>
  );
}

interface ColumnProps {
  column: BoardColumn;
  issues: readonly IssueState[];
  all: IssuesById;
  usage: Readonly<Record<IssueId, UsageTotals>>;
  maxAttempts: number;
}

function Column({ column, issues, all, usage, maxAttempts }: ColumnProps) {
  const heading = (
    <h3 className="board__heading">
      {column.label} ({issues.length})
    </h3>
  );
  const list = (
    <ul className="board__cards" aria-label={column.label}>
      {issues.map((issue) => (
        <IssueCard
          key={issue.id}
          issue={issue}
          blockedBy={unmetDependencies(issue, all)}
          usage={usage[issue.id]}
          maxAttempts={maxAttempts}
        />
      ))}
    </ul>
  );
  if (column.collapsed) {
    return (
      <details className="board__column">
        <summary>{heading}</summary>
        {list}
      </details>
    );
  }
  return (
    <div className="board__column">
      {heading}
      {list}
    </div>
  );
}
