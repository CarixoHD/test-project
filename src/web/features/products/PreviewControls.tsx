import { useId, useState } from 'react';
import type { PreviewState, ProductState } from '../../../shared/state.ts';
import { ApiError, startPreview, stopPreview } from '../../state/api.ts';
import { Button } from '../../ui/index.ts';

export const NO_PREVIEW_REASON =
  'No preview configured: main needs `preview` in .vibecode/project.json.';

/**
 * Preview of the product's current main (PRD Preview, ARCHITECTURE §4.8). Starting waits for
 * the server's readiness poll, so progress is shown meanwhile. The running preview comes from
 * the store (preview.started / preview.stopped), so Open/Stop follow events, not the request.
 */
export function PreviewControls({
  product,
  preview,
}: {
  product: ProductState;
  preview?: PreviewState | undefined;
}) {
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const configured = product.project?.preview !== undefined;
  const blocked = !configured || busy !== null;

  async function run(kind: 'starting' | 'stopping') {
    if (busy !== null) return;
    setBusy(kind);
    setError(null);
    try {
      await (kind === 'starting' ? startPreview(product.id) : stopPreview(product.id));
    } catch (err) {
      const fallback =
        kind === 'starting' ? 'Could not start the preview.' : 'Could not stop the preview.';
      setError(err instanceof ApiError ? err.message : fallback);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="preview-controls" role="group" aria-label="Preview">
      <Button
        variant={preview === undefined ? 'primary' : 'secondary'}
        aria-disabled={blocked || undefined}
        aria-describedby={configured ? undefined : reasonId}
        onClick={() => {
          if (configured) void run('starting');
        }}
      >
        {preview === undefined ? 'Preview' : 'Restart preview'}
      </Button>
      {configured ? null : (
        <p id={reasonId} className="ui-field__hint">
          {NO_PREVIEW_REASON}
        </p>
      )}
      {busy === 'starting' ? (
        <p role="status" className="ui-field__hint">
          Starting the preview of main… this can take up to a minute.
        </p>
      ) : null}
      {preview !== undefined && busy !== 'starting' ? (
        <>
          <a
            className="ui-button ui-button--primary"
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open preview<span className="visually-hidden"> (opens in a new tab)</span>
          </a>
          <Button aria-disabled={busy !== null || undefined} onClick={() => void run('stopping')}>
            Stop preview
          </Button>
        </>
      ) : null}
      {error !== null ? (
        <p role="alert" className="ui-field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
