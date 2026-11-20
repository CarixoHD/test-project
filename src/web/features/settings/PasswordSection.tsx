import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../../shared/dto.ts';
import { ApiError, changePassword, getSession } from '../../state/api.ts';
import { Button, Field } from '../../ui/index.ts';
import { useAuth } from '../auth/index.ts';

type FieldName = 'current' | 'next' | 'confirm';
type Draft = Record<FieldName, string>;
type Errors = Partial<Record<FieldName, string>>;

const EMPTY: Draft = { current: '', next: '', confirm: '' };
const ORDER: readonly FieldName[] = ['current', 'next', 'confirm'];

function validate(draft: Draft, passwordSet: boolean): Errors {
  const errors: Errors = {};
  if (passwordSet && draft.current === '') errors.current = 'Enter your current password.';
  if (draft.next.length < PASSWORD_MIN_LENGTH) {
    errors.next = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  } else if (draft.next.length > PASSWORD_MAX_LENGTH) {
    errors.next = `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  } else if (draft.confirm !== draft.next) {
    errors.confirm = 'The passwords do not match.';
  }
  return errors;
}

/** Set the first owner password, or change it (current, new, confirm). */
export function PasswordSection() {
  const headingId = useId();
  const auth = useAuth();
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const inputs = useRef<Partial<Record<FieldName, HTMLInputElement | null>>>({});

  useEffect(() => {
    const abort = new AbortController();
    getSession(abort.signal).then(
      (s) => setPasswordSet(s.passwordSet),
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setLoadError(
          err instanceof ApiError ? err.message : 'Could not check whether a password is set.',
        );
      },
    );
    return () => abort.abort();
  }, []);

  function showErrors(next: Errors) {
    setErrors(next);
    const first = ORDER.find((f) => next[f] !== undefined);
    if (first !== undefined) inputs.current[first]?.focus();
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || passwordSet === null) return;
    setAlert(null);
    setNotice('');
    const invalid = validate(draft, passwordSet);
    if (Object.keys(invalid).length > 0) {
      showErrors(invalid);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await changePassword(
        passwordSet ? { current: draft.current, next: draft.next } : { next: draft.next },
      );
      setDraft(EMPTY);
      setNotice(
        passwordSet
          ? 'Password changed. Every other browser has been logged out.'
          : 'Password set. Log in with it from now on.',
      );
      setPasswordSet(true);
      auth?.passwordChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setAlert('Too many attempts. Wait a minute, then try again.');
      } else if (err instanceof ApiError && err.status === 400) {
        // The server names the field: "The current password is wrong/required", else `next`.
        showErrors(/current/i.test(err.message) ? { current: err.message } : { next: err.message });
      } else {
        setAlert(err instanceof Error ? err.message : 'Could not save the password.');
      }
    } finally {
      setBusy(false);
    }
  }

  const input = (name: FieldName, label: string, autoComplete: string) => (
    <Field label={label} error={errors[name] ?? null}>
      {(control) => (
        <input
          {...control}
          ref={(el) => {
            inputs.current[name] = el;
          }}
          type="password"
          autoComplete={autoComplete}
          value={draft[name]}
          onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))}
        />
      )}
    </Field>
  );

  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h2 id={headingId}>Password</h2>
      <p className="settings-section__intro">
        Without a password Vibecode answers only on this computer (localhost). Reaching it from
        another device, by binding to another address with <code>VIBECODE_HOST</code>, requires a
        password. Even then, do not expose it to the internet directly: use Tailscale, or a reverse
        proxy that adds TLS (HTTPS).
      </p>
      {loadError !== null ? (
        <p role="alert" className="ui-field__error">
          {loadError}
        </p>
      ) : passwordSet === null ? (
        <p role="status">Checking the password…</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} noValidate>
          <p>{passwordSet ? 'A password is set.' : 'No password is set.'}</p>
          {passwordSet ? input('current', 'Current password', 'current-password') : null}
          {input('next', 'New password', 'new-password')}
          {input('confirm', 'Confirm new password', 'new-password')}
          <p role="alert" className="ui-field__error login__alert">
            {alert}
          </p>
          <div className="settings-actions">
            <Button type="submit" variant="primary" aria-disabled={busy || undefined}>
              {passwordSet ? 'Change password' : 'Set password'}
            </Button>
          </div>
          <p role="status" className="settings-notice">
            {notice}
          </p>
        </form>
      )}
    </section>
  );
}
