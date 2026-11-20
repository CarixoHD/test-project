import { useId, useState } from 'react';
import type { PreviewState, ProductState } from '../../../shared/state.ts';
import { ApiError, pauseProduct, resumeProduct } from '../../state/api.ts';
import { Button, StatusBadge, type BadgeTone } from '../../ui/index.ts';
import { PreviewControls } from './PreviewControls.tsx';

/** The build's run state in words; colour only backs it up. */
export function pauseStatus(product: ProductState): { text: string; tone: BadgeTone } {
  if (!product.paused) return { text: 'Running', tone: 'progress' };
  if (product.pauseReason === 'budget') return { text: 'Paused: budget reached', tone: 'danger' };
  return { text: 'Paused by you', tone: 'warning' };
}

/**
 * Pause / Resume for the product's build (ARCHITECTURE §6 flow 5). The new state arrives as
 * events (product.paused / product.resumed), so the button label follows the store, not the
 * request. A refused request (e.g. resuming while the budget is exhausted) shows the reason.
 * Below them: the preview of main (`preview` is the product's running preview, if any).
 */
export function BuildControls({
  product,
  preview,
}: {
  product: ProductState;
  preview?: PreviewState | undefined;
}) {
  const [isSending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusId = useId();
  const status = pauseStatus(product);

  async function toggle() {
    if (isSending) return;
    setSending(true);
    setError(null);
    try {
      await (product.paused ? resumeProduct(product.id) : pauseProduct(product.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the build state.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="build-tab__slot build-controls" aria-label="Build controls">
      <p id={statusId} className="build-controls__status" role="status">
        Build: <StatusBadge tone={status.tone}>{status.text}</StatusBadge>
      </p>
      <Button
        variant={product.paused ? 'primary' : 'secondary'}
        aria-label={product.paused ? 'Resume build' : 'Pause build'}
        aria-describedby={statusId}
        aria-disabled={isSending || undefined}
        onClick={() => void toggle()}
      >
        {product.paused ? 'Resume' : 'Pause'}
      </Button>
      {error !== null ? (
        <p role="alert" className="ui-field__error">
          {error}
        </p>
      ) : null}
      <PreviewControls product={product} preview={preview} />
    </section>
  );
}
