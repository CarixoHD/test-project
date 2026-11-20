import { useEffect, useState } from 'react';
import { getAttemptArtifact, type AttemptArtifact } from '../../state/api.ts';

export type ArtifactResult =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; text: string };

/**
 * Loads one attempt artifact. `version` changes as the attempt advances, so an artifact
 * written later in the run (e.g. the check output) is fetched again.
 */
export function useAttemptArtifact(
  attemptId: string,
  kind: AttemptArtifact,
  version: string,
): ArtifactResult {
  const [result, setResult] = useState<{ key: string; value: ArtifactResult } | null>(null);
  const key = `${attemptId}/${kind}/${version}`;
  const current = result?.key === key ? result.value : null;
  const needed = current === null;

  useEffect(() => {
    if (!needed) return;
    const abort = new AbortController();
    const settle = (value: ArtifactResult) => {
      if (!abort.signal.aborted) setResult({ key, value });
    };
    getAttemptArtifact(attemptId, kind, abort.signal).then(
      (text) => settle(text === null ? { status: 'missing' } : { status: 'ready', text }),
      (err: unknown) =>
        settle({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
    return () => abort.abort();
  }, [needed, key, attemptId, kind]);

  return current ?? { status: 'loading' };
}
