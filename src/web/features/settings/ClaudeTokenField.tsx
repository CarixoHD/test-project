import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, getClaudeCodeToken, updateClaudeCodeToken } from '../../state/api.ts';
import { Button, Dialog, Field } from '../../ui/index.ts';
import { useRetryableLoad } from './use-retryable-load.ts';

/** Server messages never contain the token (the DTO's errors don't echo it). */
const messageOf = (err: unknown): string =>
  err instanceof ApiError ? err.message : 'Could not reach Vibecode. Try again.';

const HINT =
  'Run `claude setup-token` on any computer where Claude Code is installed, then paste the token here. It is stored only on this machine and is only given to the official Claude Code CLI.';

/**
 * The Claude subscription token (ADR 13), write-only: the typed value lives only in the password
 * input until it is saved; afterwards the page shows "Token set (…abcd)" and never the token.
 * Saving clears needs_login on the server, which reaches the status live via backendLimits.
 */
export function ClaudeTokenField() {
  const errorId = useId();
  const { load, setView, retry } = useRetryableLoad(getClaudeCodeToken, messageOf);
  const [draft, setDraft] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  /** Saving, replacing and removing swap the input and the masked token: keep focus inside. */
  const focusNext = useRef<'input' | 'replace' | null>(null);
  useEffect(() => {
    if (focusNext.current === null) return;
    (focusNext.current === 'input' ? inputRef : replaceRef).current?.focus();
    focusNext.current = null;
  });

  async function save(token: string | null): Promise<string | null> {
    setBusy(true);
    try {
      setView(await updateClaudeCodeToken(token));
      return null;
    } catch (err) {
      return messageOf(err);
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
      setError('Paste a token first.');
      inputRef.current?.focus();
      return;
    }
    const failed = await save(token);
    if (failed !== null) {
      setError(`Could not save the token: ${failed}`);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setDraft('');
    setReplacing(false);
    setNotice('Saved. Claude Code runs use this token.');
    focusNext.current = 'replace';
  }

  async function remove() {
    if (busy) return;
    const failed = await save(null);
    setConfirmingRemove(false);
    if (failed !== null) {
      setError(`Could not remove the token: ${failed}`);
      return;
    }
    setError(null);
    setNotice('Token removed. Claude Code runs use the terminal login, if any.');
    focusNext.current = 'input';
  }

  const stored = load.kind === 'loaded' && load.view.set ? load.view : null;
  const showEntry = load.kind === 'loaded' && (stored === null || replacing);
  return (
    <div className="settings-claude__token">
      <h3>Subscription token</h3>
      {load.kind === 'loading' ? <p>Loading…</p> : null}
      {load.kind === 'failed' ? (
        <div className="settings-provider__stored">
          <p role="alert" className="ui-field__error">
            Could not load the token status: {load.message}
          </p>
          <Button onClick={retry}>Try again</Button>
        </div>
      ) : null}
      {stored !== null && !replacing ? (
        <div className="settings-provider__stored">
          <p>{stored.last4 === null ? 'Token set' : `Token set (…${stored.last4})`}</p>
          <Button
            ref={replaceRef}
            aria-label="Replace token"
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
            aria-label="Remove token"
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
          <Field label="Subscription token" hint={HINT}>
            {(control) => (
              <input
                {...control}
                {...(error === null
                  ? {}
                  : {
                      'aria-invalid': true,
                      'aria-describedby': `${control['aria-describedby'] ?? ''} ${errorId}`.trim(),
                    })}
                ref={inputRef}
                name="claudeCodeToken"
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
              {busy ? 'Saving…' : 'Save token'}
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
      ) : null}
      {error !== null ? (
        <p id={errorId} role="alert" className="ui-field__error">
          {error}
        </p>
      ) : null}
      <p role="status" className="settings-notice">
        {notice}
      </p>
      <Dialog
        open={confirmingRemove}
        onClose={() => setConfirmingRemove(false)}
        title="Remove the Claude Code token?"
      >
        <p>
          Claude Code runs then use the terminal login, if there is one, and pause with “Needs
          login” otherwise.
        </p>
        <div className="settings-actions">
          <Button variant="danger" aria-disabled={busy || undefined} onClick={() => void remove()}>
            Remove token
          </Button>
          <Button onClick={() => setConfirmingRemove(false)}>Cancel</Button>
        </div>
      </Dialog>
    </div>
  );
}
