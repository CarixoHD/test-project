import { NavLink, Outlet } from 'react-router';
import { useApp, type ConnectionStatus } from './state/store.ts';

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
                <NavLink to={item.to} end={item.end}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <p role="status" className={`connection connection--${status}`}>
          {STATUS_TEXT[status]}
        </p>
      </header>
      <main id={MAIN_ID} tabIndex={-1} className="app-main">
        <Outlet />
      </main>
    </>
  );
}
