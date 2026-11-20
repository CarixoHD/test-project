import { useCallback, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, getGitToken, updateGitToken } from '../../state/api.ts';
import { Button, Field } from '../../ui/index.ts';
import { useRetryableLoad } from './use-retryable-load.ts';

const messageOf = (err: unknown): string =>
  err instanceof ApiError ? err.message : 'Unexpected error.';

/**
 * The access token used to push main to the product's git remote. Write-only: the typed token
 * lives only in the password input until it is saved; afterwards only its last 4 characters
 * are shown.
 */
export function GitTokenSection({ productId }: { productId: string }) {
  const headingId = useId();
  const fetchToken = useCallback(
    (signal: AbortSignal) => getGitToken(productId, signal),
    [productId],
  );
  const { load, setView, retry } = useRetryableLoad(fetchToken, messageOf);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function save(token: string | null): Promise<boolean> {
    setBusy(true);
    try {
      const view = await updateGitToken(productId, token);
      setView(view);
      setError(null);
      return true;
    } catch (err) {
      setError(messageOf(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setNotice('');
    const token = draft.trim();
    if (token === '') {
      setError('Enter a token.');
      inputRef.current?.focus();
      return;
    }
    if (await save(token)) {
      setDraft('');
      setNotice('Token saved.');
    } else {
      inputRef.current?.focus();
    }
  }

  async function remove() {
    if (busy) return;
    setNotice('');
    if (await save(null)) setNotice('Token removed.');
  }

  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h3 id={headingId}>Push access</h3>
      <p className="ui-field__hint">
        Used only to push main to the git remote above. It is stored on this machine and never shown
        again after you save it; only its last 4 characters are.
      </p>
      {load.kind === 'loading' ? <p>Loading…</p> : null}
      {load.kind === 'failed' ? (
        <div className="settings-provider__stored">
          <p role="alert" className="ui-field__error">
            Could not load the token status: {load.message}
          </p>
          <Button onClick={retry}>Try again</Button>
        </div>
      ) : null}
      {load.kind === 'loaded' && load.view.set ? (
        <div className="settings-provider__stored">
          <p>{load.view.last4 === null ? 'Token saved' : `Token ending in ${load.view.last4}`}</p>
          <Button variant="danger" aria-disabled={busy || undefined} onClick={() => void remove()}>
            Remove token
          </Button>
          {error !== null ? <p className="ui-field__error">{error}</p> : null}
        </div>
      ) : null}
      {load.kind === 'loaded' && !load.view.set ? (
        <form onSubmit={(e) => void submit(e)} noValidate>
          <Field
            label="Git remote access token"
            hint="Optional. A token with push access (e.g. a GitHub fine-grained token)."
            error={error}
          >
            {(control) => (
              <input
                {...control}
                ref={inputRef}
                name="gitToken"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" aria-disabled={busy || undefined}>
            {busy ? 'Saving…' : 'Save token'}
          </Button>
        </form>
      ) : null}
      {notice !== '' ? <p role="status">{notice}</p> : null}
    </section>
  );
}
