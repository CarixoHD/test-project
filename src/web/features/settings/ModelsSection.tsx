import { useId, useRef, useState, type FormEvent } from 'react';
import type { SettingsResponse } from '../../../shared/dto.ts';
import {
  ProviderIdSchema,
  ROLES,
  type ModelRef,
  type Role,
  type RoleModels,
} from '../../../shared/models.ts';
import { Button, Field } from '../../ui/index.ts';
import { saveSettings, type SettingsSectionProps } from './settings-save.ts';

/** A row of the form: one role, or the default for all roles. */
type RowId = Role | 'default';
const ROWS: readonly RowId[] = ['default', ...ROLES];

const ROW_LABELS: Record<RowId, string> = {
  default: 'Default for all roles',
  sparring: 'Sparring',
  orchestrator: 'Orchestrator',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  utility: 'Utility',
};

const ROW_HINTS: Partial<Record<RowId, string>> = {
  default: 'Used by every role that has no model of its own.',
  utility: 'Small jobs such as summaries and titles.',
};

/** `provider` '' means "not set". */
type Draft = Record<RowId, { provider: string; model: string }>;
type Errors = Partial<Record<RowId, { field: 'provider' | 'model'; message: string }>>;

function toDraft(roleDefaults: RoleModels, defaultModel: ModelRef | null): Draft {
  const row = (ref: ModelRef | null | undefined) => ({
    provider: ref?.provider ?? '',
    model: ref?.model ?? '',
  });
  const draft = { default: row(defaultModel) } as Draft;
  for (const role of ROLES) draft[role] = row(roleDefaults[role]);
  return draft;
}

function validate(draft: Draft): Errors {
  const errors: Errors = {};
  for (const id of ROWS) {
    const { provider, model } = draft[id];
    if (provider !== '' && model.trim() === '') {
      errors[id] = {
        field: 'model',
        message: 'Enter the model name, or set the provider to Not set.',
      };
    } else if (provider === '' && model.trim() !== '') {
      errors[id] = { field: 'provider', message: 'Choose the provider for this model.' };
    }
  }
  return errors;
}

function toRef(row: Draft[RowId]): ModelRef | null {
  const provider = ProviderIdSchema.safeParse(row.provider);
  return provider.success ? { provider: provider.data, model: row.model.trim() } : null;
}

const signature = (s: SettingsResponse) => JSON.stringify([s.roleDefaults, s.defaultModel]);

/** Provider + model per role, and the default model for roles without one. */
export function ModelsSection({ settings, onSaved }: SettingsSectionProps) {
  const headingId = useId();
  const [draft, setDraft] = useState(() => toDraft(settings.roleDefaults, settings.defaultModel));
  // Saved values that change elsewhere (another tab, the server) replace the draft.
  const [shown, setShown] = useState(() => signature(settings));
  if (shown !== signature(settings)) {
    setShown(signature(settings));
    setDraft(toDraft(settings.roleDefaults, settings.defaultModel));
  }
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  function setRow(id: RowId, patch: Partial<Draft[RowId]>) {
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
    setNotice('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found = validate(draft);
    setErrors(found);
    setServerError(null);
    setNotice('');
    const first = ROWS.find((id) => found[id] !== undefined);
    if (first !== undefined) {
      const field = found[first]?.field ?? 'model';
      formRef.current
        ?.querySelector<HTMLElement>(`[data-row="${first}"][data-field="${field}"]`)
        ?.focus();
      return;
    }
    const roleDefaults: RoleModels = {};
    for (const role of ROLES) {
      const ref = toRef(draft[role]);
      if (ref !== null) roleDefaults[role] = ref;
    }
    setBusy(true);
    const failed = await saveSettings(
      { roleDefaults, defaultModel: toRef(draft.default) },
      onSaved,
    );
    setBusy(false);
    setServerError(failed);
    if (failed === null) setNotice('Models saved.');
  }

  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h2 id={headingId}>Models</h2>
      <p className="settings-section__intro">
        Which model each agent role uses. A product can choose its own models in its settings.
      </p>
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate>
        {ROWS.map((id) => {
          const row = draft[id];
          const error = errors[id];
          const hint = ROW_HINTS[id];
          return (
            <fieldset key={id} className="settings-model-row">
              <legend>{ROW_LABELS[id]}</legend>
              {hint !== undefined ? <p className="ui-field__hint">{hint}</p> : null}
              <Field label="Provider" error={error?.field === 'provider' ? error.message : null}>
                {(control) => (
                  <select
                    {...control}
                    data-row={id}
                    data-field="provider"
                    value={row.provider}
                    onChange={(e) =>
                      setRow(
                        id,
                        // Not set clears the row, so the role falls back to the default.
                        e.target.value === ''
                          ? { provider: '', model: '' }
                          : { provider: e.target.value },
                      )
                    }
                  >
                    <option value="">Not set</option>
                    {settings.providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.enabled ? p.name : `${p.name} (not set up)`}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Model" error={error?.field === 'model' ? error.message : null}>
                {(control) => (
                  <input
                    {...control}
                    data-row={id}
                    data-field="model"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    value={row.model}
                    onChange={(e) => setRow(id, { model: e.target.value })}
                  />
                )}
              </Field>
            </fieldset>
          );
        })}
        {serverError !== null ? (
          <p role="alert" className="ui-field__error">
            {serverError}
          </p>
        ) : null}
        <div className="settings-actions">
          <Button type="submit" variant="primary" aria-disabled={busy || undefined}>
            Save models
          </Button>
        </div>
        <p role="status" className="settings-notice">
          {notice}
        </p>
      </form>
    </section>
  );
}
