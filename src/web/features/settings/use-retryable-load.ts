import { useCallback, useEffect, useState } from 'react';

export type Load<T> =
  { kind: 'loading' } | { kind: 'loaded'; view: T } | { kind: 'failed'; message: string };

export interface RetryableLoad<T> {
  load: Load<T>;
  /** Takes a view a successful mutation answered with. */
  setView: (view: T) => void;
  /** Fetches again after a failure; a no-op while a fetch is in flight. */
  retry: () => void;
}

/**
 * Runs `fetcher` on mount (and whenever it changes) and again on `retry()`. Each fetch is aborted
 * when it is superseded or the component unmounts, so no state is set afterwards. `fetcher` must
 * and `messageOf` must be stable (useCallback / module scope) or every render refetches.
 */
export function useRetryableLoad<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  messageOf: (err: unknown) => string,
): RetryableLoad<T> {
  const [load, setLoad] = useState<Load<T>>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    fetcher(ac.signal).then(
      (view) => {
        if (!ac.signal.aborted) setLoad({ kind: 'loaded', view });
      },
      (err: unknown) => {
        if (!ac.signal.aborted) setLoad({ kind: 'failed', message: messageOf(err) });
      },
    );
    return () => ac.abort();
    // `attempt` is a dependency only so that retry() reruns this effect.
  }, [fetcher, messageOf, attempt]);

  const setView = useCallback((view: T) => setLoad({ kind: 'loaded', view }), []);
  const retry = useCallback(() => {
    if (load.kind !== 'failed') return;
    setLoad({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, [load.kind]);

  return { load, setView, retry };
}
