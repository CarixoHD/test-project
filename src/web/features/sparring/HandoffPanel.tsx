import { useId, useState } from 'react';
import type { ProductId } from '../../../shared/ids.ts';
import { ApiError, handoffProduct } from '../../state/api.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { Button, Dialog } from '../../ui/index.ts';

/**
 * Hands the PRD draft to the orchestrator after a confirm dialog. Disabled (but still
 * focusable, with the reason as its description) while the draft is empty. The phase change
 * arrives as events; the product header then shows Building.
 */
export function HandoffPanel({ productId }: { productId: ProductId }) {
  const draftIsEmpty = useApp(
    (s: AppSnapshot) => (s.state.prdDrafts[productId]?.markdown ?? '').trim() === '',
  );
  const [confirming, setConfirming] = useState(false);
  const [isSending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();

  function open() {
    if (draftIsEmpty) return;
    setError(null);
    setConfirming(true);
  }

  async function confirm() {
    if (isSending) return;
    setSending(true);
    setError(null);
    try {
      await handoffProduct(productId);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not hand off the PRD.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="spec-handoff" aria-label="Handoff">
      <p id={hintId} className="spec-handoff__hint">
        {draftIsEmpty
          ? 'The PRD draft is empty. Spar with the agent or write the draft before handing off.'
          : 'When the PRD is ready, hand it off: the orchestrator plans the build from it.'}
      </p>
      <Button
        variant="primary"
        aria-disabled={draftIsEmpty || undefined}
        aria-describedby={hintId}
        onClick={open}
      >
        Hand off to orchestrator
      </Button>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Hand off to orchestrator?"
      >
        <p>
          The current draft becomes PRD version 1 and is committed to the repository as docs/PRD.md.
          The orchestrator then plans the build. You can keep sparring and apply changes later.
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
            Hand off
          </Button>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      </Dialog>
    </section>
  );
}
