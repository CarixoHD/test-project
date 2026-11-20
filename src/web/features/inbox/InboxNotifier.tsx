import { useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { AppStoreContext } from '../../state/store.ts';
import { notify } from './notifications.ts';

/**
 * Mounted once in the layout. For each live `inbox.created` (never for the snapshot load) it
 * announces the item in a polite live region and, once the owner has granted permission, shows a
 * browser notification that focuses the app and opens the item's link when clicked.
 */
export function InboxNotifier() {
  const store = useContext(AppStoreContext);
  const navigate = useNavigate();
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (store === null) return undefined;
    return store.onLiveEvent((e) => {
      if (e.type !== 'inbox.created') return;
      const { title, body, link } = e.data;
      setMessage(`New in your inbox: ${title}`);
      notify(title, body, () => {
        window.focus();
        if (link !== null) void navigate(link);
      });
    });
  }, [store, navigate]);

  return (
    <p className="visually-hidden" aria-live="polite" data-testid="inbox-announcer">
      {message}
    </p>
  );
}
