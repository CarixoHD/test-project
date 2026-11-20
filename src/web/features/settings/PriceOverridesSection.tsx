import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { PriceSchema, type Price, type PriceOverrides } from '../../../shared/budget.ts';
import type { SettingsResponse } from '../../../shared/dto.ts';
import { ProviderIdSchema } from '../../../shared/models.ts';
import { Button } from '../../ui/index.ts';
import { saveSettings, type SettingsSectionProps } from './settings-save.ts';

type Column = 'model' | 'input' | 'output';

interface Row {
  /** Stable React key for the row while editing. */
  key: number;
  model: string;
  input: string;
  output: string;
  /** Prices this table does not edit (cache, reasoning, web search); kept as saved. */
  extra: Omit<Price, 'input' | 'output'>;
}

type RowErrors = Partial<Record<Column, string>>;

const COLUMN_LABELS: Record<Column, string> = {
  model: 'Model',
  input: 'Input $ per 1M tokens',
  output: 'Output $ per 1M tokens',
};

let nextRowKey = 0;
function newRow(model = '', price?: Price): Row {
  nextRowKey += 1;
  if (price === undefined) return { key: nextRowKey, model, input: '', output: '', extra: {} };
  const { input, output, ...extra } = price;
  return { key: nextRowKey, model, input: String(input), output: String(output), extra };
}

const toRows = (overrides: PriceOverrides): Row[] =>
  Object.entries(overrides).map(([model, price]) => newRow(model, price));

/** `provider/model`, the key prices are looked up by (shared `priceKey`). */
function modelError(model: string, seen: Set<string>): string | undefined {
  const slash = model.indexOf('/');
  if (model === '') return 'Enter the model as provider/model.';
  if (
    slash <= 0 ||
    slash === model.length - 1 ||
    !ProviderIdSchema.safeParse(model.slice(0, slash)).success
  ) {
    return 'Write it as provider/model, for example anthropic/claude-sonnet-4-5.';
  }
  if (seen.has(model)) return 'This model is already in the table.';
  return undefined;
}

function priceError(text: string): string | undefined {
  const value = Number(text);
  return text.trim() === '' || !Number.isFinite(value) || value < 0
    ? 'Enter a price of 0 or more.'
    : undefined;
}

/** Validates every row; returns the overrides to save, or the errors per row. */
function collect(rows: Row[]): { overrides: PriceOverrides } | { errors: RowErrors[] } {
  const seen = new Set<string>();
  const overrides: PriceOverrides = {};
  let invalid = false;
  const errors = rows.map((row) => {
    const model = row.model.trim();
    const found: RowErrors = {};
    const m = modelError(model, seen);
    const i = priceError(row.input);
    const o = priceError(row.output);
    if (m !== undefined) found.model = m;
    if (i !== undefined) found.input = i;
    if (o !== undefined) found.output = o;
    seen.add(model);
    if (Object.keys(found).length > 0) {
      invalid = true;
    } else {
      overrides[model] = PriceSchema.parse({
        ...row.extra,
        input: Number(row.input),
        output: Number(row.output),
      });
    }
    return found;
  });
  return invalid ? { errors } : { overrides };
}

const signature = (s: SettingsResponse) => JSON.stringify(s.priceOverrides);

/** Table of model → input/output price (USD per 1M tokens) that replaces the built-in prices. */
export function PriceOverridesSection({ settings, onSaved }: SettingsSectionProps) {
  const headingId = useId();
  const hintId = useId();
  const errorIdBase = useId();
  const [rows, setRows] = useState(() => toRows(settings.priceOverrides));
  // Saved values that change elsewhere (another tab, the server) replace the table.
  const [shown, setShown] = useState(() => signature(settings));
  if (shown !== signature(settings)) {
    setShown(signature(settings));
    setRows(toRows(settings.priceOverrides));
  }
  const [errors, setErrors] = useState<RowErrors[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  /** Row whose model input gets focus after the next render (a newly added row). */
  const focusRow = useRef<number | null>(null);

  const focusCell = (index: number, column: Column) =>
    tableRef.current
      ?.querySelector<HTMLElement>(`[data-row="${index}"][data-column="${column}"]`)
      ?.focus();

  function edit(index: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    setNotice('');
  }

  function add() {
    setRows((rs) => [...rs, newRow()]);
    setNotice('');
    focusRow.current = rows.length;
  }

  useEffect(() => {
    if (focusRow.current === null) return;
    focusCell(focusRow.current, 'model');
    focusRow.current = null;
  });

  function remove(index: number) {
    setRows((rs) => rs.filter((_, i) => i !== index));
    setErrors((es) => es.filter((_, i) => i !== index));
    setNotice('');
    addRef.current?.focus();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setServerError(null);
    setNotice('');
    const result = collect(rows);
    if ('errors' in result) {
      setErrors(result.errors);
      const index = result.errors.findIndex((r) => Object.keys(r).length > 0);
      const first = (['model', 'input', 'output'] as const).find((c) => result.errors[index]?.[c]);
      if (first !== undefined) focusCell(index, first);
      return;
    }
    setErrors([]);
    setBusy(true);
    const failed = await saveSettings({ priceOverrides: result.overrides }, onSaved);
    setBusy(false);
    setServerError(failed);
    if (failed === null) setNotice('Price overrides saved.');
  }

  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h2 id={headingId}>Price overrides</h2>
      <p id={hintId} className="settings-section__intro">
        Prices used for cost tracking instead of the built-in price list, in USD per 1 million
        tokens. Write the model as provider/model, for example anthropic/claude-sonnet-4-5.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        {rows.length === 0 ? (
          <p>No overrides: every model uses the built-in price list.</p>
        ) : (
          <table ref={tableRef} className="settings-prices" aria-describedby={hintId}>
            <thead>
              <tr>
                <th scope="col">{COLUMN_LABELS.model}</th>
                <th scope="col">{COLUMN_LABELS.input}</th>
                <th scope="col">{COLUMN_LABELS.output}</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.key}>
                  {(['model', 'input', 'output'] as const).map((column) => {
                    const id = `${errorIdBase}-${row.key}-${column}`;
                    const error = errors[index]?.[column];
                    return (
                      <td key={column}>
                        <label htmlFor={id} className="visually-hidden">
                          {`${COLUMN_LABELS[column]}, row ${index + 1}`}
                        </label>
                        <input
                          id={id}
                          data-row={index}
                          data-column={column}
                          type="text"
                          inputMode={column === 'model' ? 'text' : 'decimal'}
                          spellCheck={false}
                          autoComplete="off"
                          value={row[column]}
                          onChange={(e) => edit(index, { [column]: e.target.value })}
                          {...(error !== undefined
                            ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` }
                            : {})}
                        />
                        {error !== undefined ? (
                          <p id={`${id}-error`} className="ui-field__error">
                            {error}
                          </p>
                        ) : null}
                      </td>
                    );
                  })}
                  <td>
                    <Button
                      aria-label={`Remove price override, row ${index + 1}`}
                      onClick={() => remove(index)}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {serverError !== null ? (
          <p role="alert" className="ui-field__error">
            {serverError}
          </p>
        ) : null}
        <div className="settings-actions">
          <Button ref={addRef} onClick={add}>
            Add price override
          </Button>
          <Button type="submit" variant="primary" aria-disabled={busy || undefined}>
            Save price overrides
          </Button>
        </div>
        <p role="status" className="settings-notice">
          {notice}
        </p>
      </form>
    </section>
  );
}
