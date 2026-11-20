import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { SettingsUpdateRequest } from '../../../shared/dto.ts';
import { KEYED_PROVIDER_IDS, type KeyedProviderId } from '../../../shared/models.ts';
import { Button, Dialog, Field } from '../../ui/index.ts';
import { invalidReason, saveSettings, type SettingsSectionProps } from './settings-save.ts';

const isKeyed = (id: string): id is KeyedProviderId =>
  (KEYED_PROVIDER_IDS as readonly string[]).includes(id);

/** One provider per fieldset: its API key (write-only) and, for OpenAI-compatible, the base URL. */
export function ProvidersSection({ settings, onSaved }: SettingsSectionProps) {
  const headingId = useId();
  const providers = settings.providers.filter((p) => isKeyed(p.id));
  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h2 id={headingId}>Providers</h2>
      <p className="settings-section__intro">
        API keys are stored on this machine and are never shown again after you save them; only
        their last 4 characters are.
      </p>
      {providers.map((p) =>
        isKeyed(p.id) ? (
          <fieldset key={p.id} className="settings-provider">
            <legend>{p.name}</legend>
            <ProviderKey
              provider={p.id}
              name={p.name}
              optional={!p.needsKey}
              stored={settings.keys.find((k) => k.provider === p.id) ?? null}
              onSaved={onSaved}
            />
            {p.id === 'openai-compatible' ? (
              <BaseUrl name={p.name} settings={settings} onSaved={onSaved} />
            ) : null}
          </fieldset>
        ) : null,
      )}
    </section>
  );
}

interface ProviderKeyProps {
  provider: KeyedProviderId;
  name: string;
  optional: boolean;
  stored: { last4: string | null } | null;
  onSaved: SettingsSectionProps['onSaved'];
}

/**
 * Key entry for one provider. The typed key lives only in the password input until it is
 * saved; afterwards the page shows "Key ending in abcd" and never the key itself.
 */
function ProviderKey({ provider, name, optional, stored, onSaved }: ProviderKeyProps) {
  const [draft, setDraft] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  /** Saving, replacing and removing swap the key input and the masked key: keep focus inside. */
  const focusNext = useRef<'input' | 'replace' | null>(null);
  useEffect(() => {
    if (focusNext.current === null) return;
    (focusNext.current === 'input' ? inputRef : replaceRef).current?.focus();
    focusNext.current = null;
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const body: SettingsUpdateRequest = { keys: { [provider]: draft.trim() } };
    const reason = draft.trim() === '' ? 'Enter an API key.' : invalidReason(body);
    setError(reason);
    if (reason !== null) return inputRef.current?.focus();
    setBusy(true);
    const failed = await saveSettings(body, onSaved);
    setBusy(false);
    setError(failed);
    if (failed !== null) return;
    setDraft('');
    setReplacing(false);
    setNotice(`${name} key saved.`);
    focusNext.current = 'replace';
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    const failed = await saveSettings({ keys: { [provider]: null } }, onSaved);
    setBusy(false);
    setConfirmingRemove(false);
    setError(failed);
    if (failed !== null) return;
    setNotice(`${name} key removed.`);
    focusNext.current = 'input';
  }

  const showEntry = stored === null || replacing;
  return (
    <div className="settings-provider__key">
      {stored !== null && !replacing ? (
        <div className="settings-provider__stored">
          <p>{stored.last4 === null ? 'Key saved' : `Key ending in ${stored.last4}`}</p>
          <Button
            ref={replaceRef}
            aria-label={`Replace ${name} key`}
            onClick={() => {
              setNotice('');
              setError(null);
              setReplacing(true);
              focusNext.current = 'input';
            }}
          >
            Replace
          </Button>
          <Button
            variant="danger"
            aria-label={`Remove ${name} key`}
            onClick={() => {
              setNotice('');
              setConfirmingRemove(true);
            }}
          >
            Remove
          </Button>
        </div>
      ) : null}
      {showEntry ? (
        <form onSubmit={(e) => void submit(e)} className="settings-provider__form" noValidate>
          <Field
            label={`${name} API key`}
            {...(optional ? { hint: 'Optional: local servers such as Ollama need no key.' } : {})}
            error={error}
          >
            {(control) => (
              <input
                {...control}
                ref={inputRef}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
          </Field>
          <div className="settings-actions">
            <Button type="submit" variant="primary" aria-disabled={busy || undefined}>
              Save {name} key
            </Button>
            {replacing ? (
              <Button
                onClick={() => {
                  setDraft('');
                  setError(null);
                  setReplacing(false);
                  focusNext.current = 'replace';
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : error !== null ? (
        <p role="alert" className="ui-field__error">
          {error}
        </p>
      ) : null}
      <p role="status" className="settings-notice">
        {notice}
      </p>
      <Dialog
        open={confirmingRemove}
        onClose={() => setConfirmingRemove(false)}
        title={`Remove the ${name} key?`}
      >
        <p>Agents that use {name} stop working until you enter a new key.</p>
        <div className="settings-actions">
          <Button variant="danger" aria-disabled={busy || undefined} onClick={() => void remove()}>
            Remove key
          </Button>
          <Button onClick={() => setConfirmingRemove(false)}>Cancel</Button>
        </div>
      </Dialog>
    </div>
  );
}

interface BaseUrlProps extends SettingsSectionProps {
  name: string;
}

/** Base URL of an OpenAI-compatible endpoint (e.g. Ollama); empty clears it. */
function BaseUrl({ name, settings, onSaved }: BaseUrlProps) {
  const current = settings.providerConfig.openaiCompatible?.baseURL ?? '';
  const [draft, setDraft] = useState(current);
  // A change from elsewhere (another tab, a save) replaces the draft.
  const [shown, setShown] = useState(current);
  if (shown !== current) {
    setShown(current);
    setDraft(current);
  }
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const url = draft.trim();
    const { openaiCompatible: _old, ...rest } = settings.providerConfig;
    const body: SettingsUpdateRequest = {
      providerConfig: url === '' ? rest : { ...rest, openaiCompatible: { baseURL: url } },
    };
    const reason =
      invalidReason(body) === null ? null : 'Enter a full URL, such as http://localhost:11434/v1.';
    setError(reason);
    setNotice('');
    if (reason !== null) return inputRef.current?.focus();
    setBusy(true);
    const failed = await saveSettings(body, onSaved);
    setBusy(false);
    setError(failed);
    if (failed === null)
      setNotice(url === '' ? `${name} base URL cleared.` : `${name} base URL saved.`);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="settings-provider__form" noValidate>
      <Field
        label={`${name} base URL`}
        hint="For example http://localhost:11434/v1 for Ollama. Leave empty to turn it off."
        error={error}
      >
        {(control) => (
          <input
            {...control}
            ref={inputRef}
            type="url"
            inputMode="url"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        )}
      </Field>
      <div className="settings-actions">
        <Button type="submit" variant="primary" aria-disabled={busy || undefined}>
          Save {name} base URL
        </Button>
      </div>
      <p role="status" className="settings-notice">
        {notice}
      </p>
    </form>
  );
}
