import { useEffect, useRef, useState } from 'react';
import type { IssueStatus } from '../../../shared/domain.ts';
import type { ProductId } from '../../../shared/ids.ts';
import { describeStatusChanges, diffStatuses, type IssuesById } from './board-model.ts';

/**
 * Text for a polite live region about issue status changes. Changes are collected for
 * `delayMs` after the first one and then announced together (latest status per issue), so a
 * burst of events yields one message instead of a flood. The state present when the snapshot
 * loads is history and is not announced.
 */
export function useStatusAnnouncer(
  issues: IssuesById,
  productId: ProductId,
  loaded: boolean,
  delayMs: number,
): string {
  const [message, setMessage] = useState('');
  const seen = useRef<IssuesById | null>(null);
  const pending = useRef(new Map<string, IssueStatus>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!loaded) return;
    const before = seen.current;
    seen.current = issues;
    if (before === null) return;
    for (const change of diffStatuses(before, issues, productId)) {
      pending.current.set(change.id, change.status);
    }
    if (pending.current.size === 0 || timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const changes = [...pending.current].map(([id, status]) => ({ id, status }));
      pending.current.clear();
      setMessage(describeStatusChanges(changes, seen.current ?? {}));
    }, delayMs);
  }, [issues, productId, loaded, delayMs]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  return message;
}
