import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, login } from '../../state/api.ts';
import { Button, Field } from '../../ui/index.ts';

export interface LoginPageProps {
  onLoggedIn: () => void;
  /** Shown above the form when an earlier session ended (401 from the API). */
  notice?: string | null;
}

const RATE_LIMITED = 'Too many login attempts. Wait a minute, then try again.';

/** The only page shown while a password is set and this browser has no session. */
export function LoginPage({ onLoggedIn, notice = null }: LoginPageProps) {
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setAlert(null);
    if (password === '') {
      setFieldError('Enter your password.');
      input.current?.focus();
      return;
    }
    setBusy(true);
    setFieldError(null);
    try {
      await login(password);
      onLoggedIn();
      return;
    } catch (err) {
      setPassword('');
      if (err instanceof ApiError && err.status === 401) {
        setFieldError('Wrong password. Try again.');
      } else if (err instanceof ApiError && err.status === 429) {
        setAlert(RATE_LIMITED);
      } else {
        setAlert(err instanceof Error ? err.message : 'Login failed.');
      }
    } finally {
      setBusy(false);
    }
    input.current?.focus();
  }

  return (
    <main className="login" id="main">
      <form className="login__card" onSubmit={(e) => void submit(e)} noValidate>
        <h1>Log in to Vibecode</h1>
        {notice !== null ? <p className="login__notice">{notice}</p> : null}
        <Field label="Password" error={fieldError}>
          {(control) => (
            <input
              {...control}
              ref={input}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <p role="alert" className="ui-field__error login__alert">
          {alert}
        </p>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
    </main>
  );
}
