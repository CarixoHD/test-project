import { NavLink } from 'react-router';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { inboxNavLabel, unreadCount } from './inbox-model.ts';

const selectUnread = (s: AppSnapshot) => unreadCount(s.state.inbox);

/** The main-nav Inbox link with its live unread badge ("Inbox, 3 unread" for screen readers). */
export function InboxNavLink() {
  const unread = useApp(selectUnread);
  return (
    <NavLink to="/inbox" aria-label={inboxNavLabel(unread)}>
      Inbox
      {unread > 0 ? (
        <span className="app-nav__badge" aria-hidden="true">
          {unread}
        </span>
      ) : null}
    </NavLink>
  );
}
