// The browser Notification API, read through the global at call time so tests can stub it
// and a permission granted in another tab is seen without a reload.

export type NotificationAccess = NotificationPermission | 'unsupported';

const api = (): typeof Notification | undefined =>
  typeof Notification === 'undefined' ? undefined : Notification;

export function notificationAccess(): NotificationAccess {
  return api()?.permission ?? 'unsupported';
}

/** Asks the owner (needs a user gesture); resolves to the resulting access. */
export async function requestNotificationAccess(): Promise<NotificationAccess> {
  const N = api();
  if (N === undefined) return 'unsupported';
  return N.requestPermission();
}

/** Shows a notification when permission is granted; `onClick` runs when the owner clicks it. */
export function notify(title: string, body: string, onClick: () => void): void {
  const N = api();
  if (N?.permission !== 'granted') return;
  const n = new N(title, { body });
  n.onclick = () => {
    onClick();
    n.close();
  };
}
