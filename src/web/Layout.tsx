import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useAuth, type Auth } from './features/auth/index.ts';
import { InboxNavLink, InboxNotifier } from './features/inbox/index.ts';
import { useApp, type ConnectionStatus } from './state/store.ts';
import { Button } from './ui/index.ts';

const MAIN_ID = 'main';

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline, retrying…',
};

const NAV = [
  { to: '/', label: 'Products', end: true },
  { to: '/inbox', label: 'Inbox', end: false },
  { to: '/settings', label: 'Settings', end: false },
] as const;

/** Page chrome for every route: skip link, header nav, connection status, then `<main>`. */
export function Layout() {
  const status = useApp((s) => s.status);
  const auth = useAuth();
  return (
    <>
      <a className="skip-link" href={`#${MAIN_ID}`}>
        Skip to content
      </a>
      <header className="app-header">
        <NavLink to="/" className="app-header__brand" end>
          Vibecode
        </NavLink>
        <nav aria-label="Main" className="app-nav">
          <ul>
            {NAV.map((item) => (
              <li key={item.to}>
                {item.to === '/inbox' ? (
                  <InboxNavLink />
                ) : (
                  <NavLink to={item.to} end={item.end}>
                    {item.label}
                  </NavLink>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <p role="status" className={`connection connection--${status}`}>
          {STATUS_TEXT[status]}
        </p>
        {auth?.passwordSet === true ? <LogoutButton auth={auth} /> : null}
      </header>
      <InboxNotifier />
      <main id={MAIN_ID} tabIndex={-1} className="app-main">
        <Outlet />
      </main>
    </>
  );
}

function LogoutButton({ auth }: { auth: Auth }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      await auth.logout(); // unmounts the app on success
    } catch {
      setError('Logout failed; try again.');
      setBusy(false);
    }
  }
  return (
    <div className="app-header__logout">
      <Button disabled={busy} onClick={() => void onClick()}>
        Log out
      </Button>
      {error !== null ? <p role="alert">{error}</p> : null}
    </div>
  );
}
