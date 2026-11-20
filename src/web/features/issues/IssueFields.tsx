import { useMemo, type RefObject } from 'react';
import { IssueIdSchema, type IssueId, type ProductId } from '../../../shared/ids.ts';
import type { IssueState } from '../../../shared/state.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { Field } from '../../ui/index.ts';

/** Editable fields shared by the add and edit dialogs. */
export interface IssueDraft {
  title: string;
  body: string;
  dependsOn: IssueId[];
}

/** Priority choices; higher is more urgent (ARCHITECTURE §4.4). 0 is the server default. */
export const PRIORITY_OPTIONS = [
  { value: 2, label: 'Urgent' },
  { value: 1, label: 'High' },
  { value: 0, label: 'Normal' },
  { value: -1, label: 'Low' },
] as const;

export const TITLE_REQUIRED = 'Title is required';

const selectIssues = (s: AppSnapshot) => s.state.issues;

/** Issues of the product that may be depended on: not cancelled, not `exclude`, by number. */
export function useDependencyOptions(productId: ProductId, exclude?: IssueId): IssueState[] {
  const issues = useApp(selectIssues);
  return useMemo(
    () =>
      Object.values(issues)
        .filter(
          (i): i is IssueState =>
            i !== undefined &&
            i.productId === productId &&
            i.status !== 'cancelled' &&
            i.id !== exclude,
        )
        .sort((a, b) => a.number - b.number),
    [issues, productId, exclude],
  );
}

export interface IssueFieldsProps {
  productId: ProductId;
  /** The issue being edited; it is left out of the dependency choices. */
  self?: IssueId;
  draft: IssueDraft;
  onChange: (draft: IssueDraft) => void;
  titleError: string | null;
  titleRef: RefObject<HTMLInputElement | null>;
}

/** Title, markdown body and "depends on" controls for an issue form. */
export function IssueFields({
  productId,
  self,
  draft,
  onChange,
  titleError,
  titleRef,
}: IssueFieldsProps) {
  const options = useDependencyOptions(productId, self);
  return (
    <>
      <Field label="Title" error={titleError}>
        {(control) => (
          <input
            {...control}
            ref={titleRef}
            name="title"
            type="text"
            autoComplete="off"
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
          />
        )}
      </Field>
      <Field label="Body (markdown)">
        {(control) => (
          <textarea
            {...control}
            name="body"
            rows={8}
            value={draft.body}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
          />
        )}
      </Field>
      <Field
        label="Depends on"
        hint="Issues that must be completed first. Hold Ctrl or Shift to pick several."
      >
        {(control) => (
          <select
            {...control}
            name="dependsOn"
            multiple
            size={Math.min(Math.max(options.length, 2), 6)}
            value={draft.dependsOn}
            onChange={(e) =>
              onChange({
                ...draft,
                dependsOn: Array.from(e.target.selectedOptions, (o) =>
                  IssueIdSchema.parse(o.value),
                ),
              })
            }
          >
            {options.map((issue) => (
              <option key={issue.id} value={issue.id}>
                #{issue.number} {issue.title}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}
