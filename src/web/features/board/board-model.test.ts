import { describe, expect, it } from 'vitest';
import type { IssueStatus } from '../../../shared/domain.ts';
import { IssueIdSchema, ProductIdSchema } from '../../../shared/ids.ts';
import type { IssueState } from '../../../shared/state.ts';
import {
  BOARD_COLUMNS,
  describeStatusChanges,
  diffStatuses,
  groupIntoColumns,
  unmetDependencies,
} from './board-model.ts';

const P = ProductIdSchema.parse('p1');

const issue = (n: number, status: IssueStatus, extra: Partial<IssueState> = {}): IssueState => ({
  id: IssueIdSchema.parse(`i${String(n)}`),
  productId: P,
  number: n,
  title: `Issue ${String(n)}`,
  body: '',
  status,
  rev: 1,
  priority: 0,
  origin: 'orchestrator',
  prdVersion: 1,
  attemptCount: 0,
  heldQuestionId: null,
  runAfter: 0,
  mergedOrder: null,
  mergeSha: null,
  failureReason: null,
  dependsOn: [],
  ...extra,
});

const byId = (...issues: IssueState[]) => Object.fromEntries(issues.map((i) => [i.id, i]));

describe('groupIntoColumns', () => {
  it('has the six status columns in board order', () => {
    expect(BOARD_COLUMNS.map((c) => c.label)).toEqual([
      'Open',
      'In progress',
      'In review',
      'Completed',
      'Failed',
      'Cancelled',
    ]);
  });

  it('puts each issue of the product in its status column, priority first then number', () => {
    const other = { ...issue(9, 'open'), productId: ProductIdSchema.parse('p2') };
    const cols = groupIntoColumns(
      byId(
        issue(1, 'open'),
        issue(2, 'open', { priority: 5 }),
        issue(3, 'completed'),
        issue(4, 'open'),
        other,
      ),
      P,
    );
    expect(cols.open.map((i) => i.number)).toEqual([2, 1, 4]);
    expect(cols.completed.map((i) => i.number)).toEqual([3]);
    expect(cols.in_progress).toEqual([]);
  });
});

describe('unmetDependencies', () => {
  it('lists dependencies that are not completed, by number', () => {
    const a = issue(1, 'completed');
    const b = issue(2, 'in_progress');
    const c = issue(3, 'open', { dependsOn: [a.id, b.id] });
    expect(unmetDependencies(c, byId(a, b, c)).map((i) => i.number)).toEqual([2]);
  });
});

describe('diffStatuses / describeStatusChanges', () => {
  it('reports issues whose status changed, ignoring new and unchanged ones', () => {
    const before = byId(issue(1, 'open'), issue(2, 'open'));
    const after = byId(issue(1, 'in_progress'), issue(2, 'open'), issue(3, 'open'));
    expect(diffStatuses(before, after, P)).toEqual([{ id: 'i1', status: 'in_progress' }]);
  });

  it('names one change with number, title and status text', () => {
    const issues = byId(issue(1, 'in_review'));
    expect(describeStatusChanges([{ id: 'i1', status: 'in_review' }], issues)).toBe(
      '#1 Issue 1 is now In review.',
    );
  });

  it('summarises many changes in one sentence instead of one per issue', () => {
    const issues = byId(...[1, 2, 3, 4].map((n) => issue(n, 'completed')));
    const changes = [1, 2, 3, 4].map((n) => ({ id: `i${String(n)}`, status: 'completed' as const }));
    expect(describeStatusChanges(changes, issues)).toBe('4 issues changed status.');
  });

  it('lists a few changes together', () => {
    const issues = byId(issue(1, 'completed'), issue(2, 'failed'));
    expect(
      describeStatusChanges(
        [
          { id: 'i1', status: 'completed' },
          { id: 'i2', status: 'failed' },
        ],
        issues,
      ),
    ).toBe('#1 Issue 1 is now Completed. #2 Issue 2 is now Failed.');
  });
});
