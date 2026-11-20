import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, getSession, logout, onUnauthorized } from '../../state/api.ts';
import { Button } from '../../ui/index.ts';
import { AuthContext, type Auth } from './auth-context.ts';
import { LoginPage } from './LoginPage.tsx';

type Phase =
  | { kind: 'checking' }
  | { kind: 'failed'; message: string }
  | { kind: 'login'; notice: string | null }
  | { kind: 'in'; passwordSet: boolean };

const SESSION_ENDED = 'Your session has ended. Log in again.';

/**
 * Checks GET /api/session on load and renders `children` (the app) only for an authenticated
 * browser; otherwise only the Login page. Any 401 from the API, including one detected for an
 * EventSource, returns to Login (ADR 9).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });

  const check = useCallback(async (signal?: AbortSignal) => {
    setPhase({ kind: 'checking' });
    try {
      const session = await getSession(signal);
      setPhase(
        session.passwordSet && !session.authenticated
          ? { kind: 'login', notice: null }
          : { kind: 'in', passwordSet: session.passwordSet },
      );
    } catch (err) {
      if (signal?.aborted === true) return;
      const message =
        err instanceof ApiError ? err.message : 'Cannot reach the Vibecode server; is it running?';
      setPhase({ kind: 'failed', message });
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void check(abort.signal);
    return () => abort.abort();
  }, [check]);

  useEffect(
    () =>
      onUnauthorized(() => {
        setPhase((prev) =>
          prev.kind === 'login' ? prev : { kind: 'login', notice: SESSION_ENDED },
        );
      }),
    [],
  );

  const auth = useMemo<Auth | null>(
    () =>
      phase.kind === 'in'
        ? {
            passwordSet: phase.passwordSet,
            logout: async () => {
              await logout();
              setPhase({ kind: 'login', notice: null });
            },
            passwordChanged: () => setPhase({ kind: 'in', passwordSet: true }),
          }
        : null,
    [phase],
  );

  switch (phase.kind) {
    case 'checking':
      return (
        <main className="login" id="main">
          <p role="status">Checking your session…</p>
        </main>
      );
    case 'failed':
      return (
        <main className="login" id="main">
          <div className="login__card">
            <p role="alert" className="ui-field__error">
              {phase.message}
            </p>
            <Button variant="primary" onClick={() => void check()}>
              Try again
            </Button>
          </div>
        </main>
      );
    case 'login':
      return (
        <LoginPage
          notice={phase.notice}
          onLoggedIn={() => setPhase({ kind: 'in', passwordSet: true })}
        />
      );
    case 'in':
      return <AuthContext value={auth}>{children}</AuthContext>;
  }
}
