import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  MAX_ATTEMPTS_LIMIT,
  MAX_PARALLEL_LIMIT,
  ProductSettingsUpdateRequestSchema,
  type ProductSettingsUpdateRequest,
} from '../../../shared/dto.ts';
import {
  PROVIDER_IDS,
  ROLES,
  type ModelRef,
  type ProviderId,
  type Role,
} from '../../../shared/models.ts';
import type { ProductState } from '../../../shared/state.ts';
import { ApiError, updateProductSettings } from '../../state/api.ts';
import { Button, Field } from '../../ui/index.ts';

const ROLE_LABELS: Record<Role, string> = {
  sparring: 'Sparring',
  orchestrator: 'Orchestrator',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  utility: 'Utility',
};

const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI-compatible',
  'claude-code': 'Claude Code (subscription)',
  fake: 'Fake (demo)',
};

type RoleInput = { provider: string; model: string };
interface FormValues {
  budgetUsd: string;
  maxParallel: string;
  maxAttempts: string;
  gitRemote: string;
  models: Record<Role, RoleInput>;
}
/** Error per control: `budgetUsd`, `maxParallel`, …, `models.<role>.provider|model`. */
type FieldErrors = Partial<Record<string, string>>;

type SaveStatus =
  { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; message: string };

function initialValues(product: ProductState): FormValues {
  const s = product.settings;
  const models = Object.fromEntries(
    ROLES.map((role) => {
      const ref = s.models[role];
      return [role, { provider: ref?.provider ?? '', model: ref?.model ?? '' }];
    }),
  ) as Record<Role, RoleInput>;
  return {
    budgetUsd: s.budgetUsd === null ? '' : String(s.budgetUsd),
    maxParallel: String(s.maxParallel),
    maxAttempts: String(s.maxAttempts),
    gitRemote: s.gitRemote?.url ?? '',
    models,
  };
}

/** Blank number fields become NaN, so the schema reports them as "must be a … number". */
const toNumber = (text: string): number => (text.trim() === '' ? Number.NaN : Number(text));

/** The PATCH body for the form, or the errors per control (same schema as the server). */
function toRequest(
  v: FormValues,
): { ok: true; request: ProductSettingsUpdateRequest } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const models: Partial<Record<Role, ModelRef | null>> = {};
  for (const role of ROLES) {
    const provider = PROVIDER_IDS.find((p) => p === v.models[role].provider);
    const model = v.models[role].model.trim();
    if (provider === undefined && model === '') models[role] = null;
    else if (provider === undefined) errors[`models.${role}.provider`] = 'Choose a provider';
    else if (model === '') errors[`models.${role}.model`] = 'Enter a model';
    else models[role] = { provider, model };
  }
  const gitRemote = v.gitRemote.trim();
  const parsed = ProductSettingsUpdateRequestSchema.safeParse({
    budgetUsd: v.budgetUsd.trim() === '' ? null : toNumber(v.budgetUsd),
    maxParallel: toNumber(v.maxParallel),
    maxAttempts: toNumber(v.maxAttempts),
    gitRemote: gitRemote === '' ? null : { url: gitRemote },
    models,
  });
  for (const issue of parsed.error?.issues ?? []) {
    const key = issue.path.slice(0, issue.path[0] === 'models' ? 3 : 1).join('.');
    errors[key] ??= issue.message;
  }
  if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, request: parsed.data };
}

/** Settings tab of a product: budget, parallelism, attempts, git remote and models per role. */
export function ProductSettingsTab({ product }: { product: ProductState }) {
  // Another product starts from its own values.
  return <ProductSettingsForm key={product.id} product={product} />;
}

function ProductSettingsForm({ product }: { product: ProductState }) {
  const [values, setValues] = useState<FormValues>(() => initialValues(product));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [focusRequest, setFocusRequest] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const headingId = `product-settings-${product.id}`;

  // After a failed validation, focus the first invalid control (in document order).
  useEffect(() => {
    if (focusRequest === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusRequest]);

  const set = (patch: Partial<FormValues>) => setValues((v) => ({ ...v, ...patch }));
  const setRole = (role: Role, patch: Partial<RoleInput>) =>
    setValues((v) => ({ ...v, models: { ...v.models, [role]: { ...v.models[role], ...patch } } }));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.kind === 'saving') return;
    const result = toRequest(values);
    if (!result.ok) {
      setErrors(result.errors);
      setStatus({ kind: 'idle' });
      setFocusRequest((n) => n + 1);
      return;
    }
    setErrors({});
    setStatus({ kind: 'saving' });
    try {
      await updateProductSettings(product.id, result.request);
      setStatus({ kind: 'saved' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Unexpected error.';
      setStatus({ kind: 'failed', message });
    }
  }

  // `fake` (demo/test provider) is offered only when the product already uses it.
  const providerOptions = PROVIDER_IDS.filter(
    (p) => p !== 'fake' || ROLES.some((r) => values.models[r].provider === 'fake'),
  );

  return (
    <form ref={formRef} aria-labelledby={headingId} noValidate onSubmit={(e) => void onSubmit(e)}>
      <h2 id={headingId}>Settings for {product.name}</h2>
      <Field
        label="Budget (USD)"
        hint="Agents pause when the product has spent this much. Leave blank for no budget."
        error={errors.budgetUsd ?? null}
      >
        {(control) => (
          <input
            {...control}
            name="budgetUsd"
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={values.budgetUsd}
            onChange={(e) => set({ budgetUsd: e.target.value })}
          />
        )}
      </Field>
      <Field
        label="Parallel agents"
        hint={`How many agents work at the same time (1–${MAX_PARALLEL_LIMIT}).`}
        error={errors.maxParallel ?? null}
      >
        {(control) => (
          <input
            {...control}
            name="maxParallel"
            type="number"
            min={1}
            max={MAX_PARALLEL_LIMIT}
            step={1}
            value={values.maxParallel}
            onChange={(e) => set({ maxParallel: e.target.value })}
          />
        )}
      </Field>
      <Field
        label="Attempts per issue"
        hint={`How often an issue is tried before it fails (1–${MAX_ATTEMPTS_LIMIT}).`}
        error={errors.maxAttempts ?? null}
      >
        {(control) => (
          <input
            {...control}
            name="maxAttempts"
            type="number"
            min={1}
            max={MAX_ATTEMPTS_LIMIT}
            step={1}
            value={values.maxAttempts}
            onChange={(e) => set({ maxAttempts: e.target.value })}
          />
        )}
      </Field>
      <Field
        label="Git remote URL"
        hint="Optional. An https:// or SSH URL (git@host:path) without credentials. Leave blank for none."
        error={errors.gitRemote ?? null}
      >
        {(control) => (
          <input
            {...control}
            name="gitRemote"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={values.gitRemote}
            onChange={(e) => set({ gitRemote: e.target.value })}
          />
        )}
      </Field>

      <h3>Models</h3>
      <p className="ui-field__hint">
        Leave a role blank to use the default model from the global Settings page.
      </p>
      {ROLES.map((role) => (
        <fieldset key={role}>
          <legend>{ROLE_LABELS[role]} model</legend>
          <Field label="Provider" error={errors[`models.${role}.provider`] ?? null}>
            {(control) => (
              <select
                {...control}
                name={`models.${role}.provider`}
                value={values.models[role].provider}
                onChange={(e) => setRole(role, { provider: e.target.value })}
              >
                <option value="">Global default</option>
                {providerOptions.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Model" error={errors[`models.${role}.model`] ?? null}>
            {(control) => (
              <input
                {...control}
                name={`models.${role}.model`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={values.models[role].model}
                onChange={(e) => setRole(role, { model: e.target.value })}
              />
            )}
          </Field>
        </fieldset>
      ))}

      {status.kind === 'saved' ? <p role="status">Settings saved.</p> : null}
      {status.kind === 'failed' ? (
        <p role="alert" className="ui-field__error">
          Could not save the settings: {status.message}
        </p>
      ) : null}
      <Button type="submit" variant="primary" aria-disabled={status.kind === 'saving' || undefined}>
        {status.kind === 'saving' ? 'Saving…' : 'Save settings'}
      </Button>
    </form>
  );
}
