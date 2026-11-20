import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { InboxItem, QuestionState } from '../../../shared/state.ts';
import { ApiError, markInboxRead } from '../../state/api.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { Button } from '../../ui/index.ts';
import { formatInboxTime, KIND_TEXT, questionForItem, sortedItems } from './inbox-model.ts';
import {
  notificationAccess,
  requestNotificationAccess,
  type NotificationAccess,
} from './notifications.ts';
import { QuestionAnswer } from './QuestionAnswer.tsx';

const selectInbox = (s: AppSnapshot) => s.state.inbox;
const selectQuestions = (s: AppSnapshot) => s.state.questions;

const errorText = (err: unknown): string =>
  err instanceof ApiError ? err.message : 'Marking the item read failed; try again.';

/** `/inbox`: agent questions, failures, budget and backend alerts, newest first. */
export function InboxPage() {
  const inbox = useApp(selectInbox);
  const questions = useApp(selectQuestions);
  const items = useMemo(() => sortedItems(inbox), [inbox]);
  const unread = items.filter((i) => !i.read);
  const [error, setError] = useState<string | null>(null);

  function markRead(item: InboxItem): void {
    if (item.read) return;
    markInboxRead(item.id).catch((err: unknown) => setError(errorText(err)));
  }

  async function markAllRead(): Promise<void> {
    setError(null);
    const results = await Promise.allSettled(unread.map((i) => markInboxRead(i.id)));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed !== undefined) setError(errorText(failed.reason));
  }

  return (
    <>
      <h1>Inbox</h1>
      <NotificationSettings />
      <div className="inbox__toolbar">
        <p>{unread.length === 0 ? 'All caught up.' : `${String(unread.length)} unread`}</p>
        <Button disabled={unread.length === 0} onClick={() => void markAllRead()}>
          Mark all read
        </Button>
      </div>
      {error !== null ? <p role="alert">{error}</p> : null}
      {items.length === 0 ? (
        <p>Nothing here yet.</p>
      ) : (
        <ul className="inbox" aria-label="Inbox items">
          {items.map((item) => (
            <InboxEntry
              key={item.id}
              item={item}
              question={questionForItem(item, questions)}
              onRead={() => markRead(item)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function InboxEntry({
  item,
  question,
  onRead,
}: {
  item: InboxItem;
  question: QuestionState | undefined;
  onRead: () => void;
}) {
  return (
    <li className={`inbox-item${item.read ? '' : ' inbox-item--unread'}`}>
      <p className="inbox-item__meta">
        <span className="inbox-item__kind">{KIND_TEXT[item.kind]}</span>
        {' · '}
        <time dateTime={new Date(item.createdAt).toISOString()}>
          {formatInboxTime(item.createdAt)}
        </time>
        {' · '}
        {item.read ? <span>Read</span> : <strong className="inbox-item__unread">Unread</strong>}
      </p>
      <h2 className="inbox-item__title">
        {item.link === null ? (
          item.title
        ) : (
          <Link to={item.link} onClick={onRead}>
            {item.title}
          </Link>
        )}
      </h2>
      {item.body !== '' ? <p className="inbox-item__body">{item.body}</p> : null}
      {question !== undefined ? <QuestionAnswer question={question} onAnswered={onRead} /> : null}
      {!item.read ? (
        <Button aria-label={`Mark read: ${item.title}`} onClick={onRead}>
          Mark read
        </Button>
      ) : null}
    </li>
  );
}

const ACCESS_TEXT: Record<Exclude<NotificationAccess, 'default'>, string> = {
  granted: 'Browser notifications are on.',
  denied: 'Notifications are blocked for this site; allow them in the browser settings.',
  unsupported: 'This browser does not support notifications.',
};

function NotificationSettings() {
  const [access, setAccess] = useState<NotificationAccess>(notificationAccess);

  async function enable(): Promise<void> {
    setAccess(await requestNotificationAccess());
  }

  return (
    <section className="inbox__notifications" aria-label="Browser notifications">
      {access === 'default' ? (
        <>
          <p>Get a browser notification when something new arrives in your inbox.</p>
          <Button onClick={() => void enable()}>Enable notifications</Button>
        </>
      ) : (
        <p>{ACCESS_TEXT[access]}</p>
      )}
    </section>
  );
}
