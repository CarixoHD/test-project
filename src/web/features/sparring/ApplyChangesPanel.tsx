import { useId, useState } from 'react';
import type { ProductId } from '../../../shared/ids.ts';
import type { PrdVersionMeta } from '../../../shared/state.ts';
import { ApiError, applyPrdChanges } from '../../state/api.ts';
import { useApp, useAppStore, type AppSnapshot } from '../../state/store.ts';
import { Button, Dialog } from '../../ui/index.ts';
import { hasUnappliedChanges } from './draft-author.ts';

const NO_VERSIONS: readonly PrdVersionMeta[] = [];

const formatTime = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * After handoff: whether the draft has changes since the latest PRD version, an 'Apply changes'
 * button with a confirm dialog (POST apply-prd), and the version history with each replan
 * summary. The new version and the summary arrive as events.
 */
export function ApplyChangesPanel({ productId }: { productId: ProductId }) {
  const draft = useApp((s: AppSnapshot) => s.state.prdDrafts[productId] ?? null);
  const versions = useApp((s: AppSnapshot) => s.state.prdVersions[productId] ?? NO_VERSIONS);
  const [confirming, setConfirming] = useState(false);
  const [isSending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const store = useAppStore();

  const latest = versions.at(-1)?.version ?? 0;
  const unapplied = hasUnappliedChanges(draft, versions);

  function open() {
    if (!unapplied) return;
    setError(null);
    setConfirming(true);
  }

  async function confirm() {
    if (isSending) return;
    setSending(true);
    setError(null);
    try {
      await applyPrdChanges(productId);
      setConfirming(false);
      // The PRD version can arrive late over SSE; read it from the server.
      void store.refresh?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not apply the changes.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="spec-apply" aria-label="PRD changes">
      <div className="spec-handoff">
        <div>
          {unapplied ? (
            <p className="spec-apply__status">
              <strong>Unapplied changes since v{latest}</strong>
            </p>
          ) : null}
          <p id={hintId} className="spec-handoff__hint">
            {unapplied
              ? 'Apply them to commit the draft as a new PRD version; the orchestrator then replans.'
              : `No unapplied changes: the draft is PRD v${String(latest)}. Keep sparring or edit the draft while the build runs.`}
          </p>
        </div>
        <Button
          variant="primary"
          aria-disabled={!unapplied || undefined}
          aria-describedby={hintId}
          onClick={open}
        >
          Apply changes
        </Button>
      </div>
      <h2 className="spec-apply__heading">Version history</h2>
      <ol className="spec-apply__versions" aria-label="PRD versions">
        {[...versions].reverse().map((v) => (
          <li key={v.version}>
            <span className="spec-apply__version">v{v.version}</span>{' '}
            <time dateTime={new Date(v.createdAt).toISOString()}>{formatTime(v.createdAt)}</time>
            <p className="spec-apply__summary">{describeVersion(v)}</p>
          </li>
        ))}
      </ol>
      <Dialog open={confirming} onClose={() => setConfirming(false)} title="Apply changes?">
        <p>
          The current draft becomes PRD version {latest + 1} and is committed to the repository as
          docs/PRD.md. The orchestrator then replans: it adds issues, edits or cancels open ones
          that no longer fit, and adds follow-up issues for merged work.
        </p>
        {error !== null ? (
          <p role="alert" className="ui-field__error">
            {error}
          </p>
        ) : null}
        <div className="spec-prd__actions">
          <Button
            variant="primary"
            aria-disabled={isSending || undefined}
            onClick={() => void confirm()}
          >
            Apply
          </Button>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      </Dialog>
    </section>
  );
}

function describeVersion(v: PrdVersionMeta): string {
  if (v.summary !== null) return v.summary;
  return v.version === 1 ? 'Handed off to the orchestrator.' : 'The orchestrator is replanning…';
}
