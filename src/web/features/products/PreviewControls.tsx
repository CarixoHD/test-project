import { useCallback, useId, useRef, useState } from 'react';
import type { IssueStatus } from '../../../shared/domain.ts';
import type { ClientState, PreviewState, ProductState } from '../../../shared/state.ts';
import { addIssue, ApiError, startPreview, stopPreview } from '../../state/api.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { Button } from '../../ui/index.ts';

export const NO_PREVIEW_REASON =
  "Preview isn't set up yet: the agents haven't told the platform how to start this app. " +
  'Only web apps and APIs can be previewed.';

export const SETUP_PREVIEW_TITLE = 'Configure Preview';
/** "High" in the board's priority choices. */
export const SETUP_PREVIEW_PRIORITY = 1;
export const SETUP_PREVIEW_BODY = [
  'The owner wants to preview this product, but `.vibecode/project.json` has no `preview` entry.',
  '',
  'Add `"preview": {"command": [...], "port": N}` to `.vibecode/project.json`:',
  '- `command` is the argv that starts the app (no shell string), run from `/workspace` with the dependencies installed in the image.',
  '- The server must listen on `0.0.0.0:N` (not 127.0.0.1) so the platform can reach it.',
  '',
  'Make sure the `check` command still passes. If this product is not a web app or API, say so in your report instead.',
].join('\n');

const FINAL_STATUSES: readonly IssueStatus[] = ['completed', 'failed', 'cancelled'];

/** The product's unfinished "Configure Preview" issue, if any (an existing object: stable). */
function findSetupIssue(state: ClientState, productId: string) {
  for (const issue of Object.values(state.issues)) {
    if (
      issue.productId === productId &&
      issue.title === SETUP_PREVIEW_TITLE &&
      !FINAL_STATUSES.includes(issue.status)
    ) {
      return issue;
    }
  }
  return null;
}

function findIssueByNumber(state: ClientState, productId: string, num: number | null) {
  if (num === null) return null;
  for (const issue of Object.values(state.issues)) {
    if (issue.productId === productId && issue.number === num) return issue;
  }
  return null;
}

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
  const [queued, setQueued] = useState<number | null>(null);
  const [requesting, setRequesting] = useState(false);
  // A ref, not state: a second click in the same tick must not send a second request.
  const requestingRef = useRef(false);
  const reasonId = useId();
  const configured = product.project?.preview !== undefined;
  const setupIssue = useApp(
    useCallback((s: AppSnapshot) => findSetupIssue(s.state, product.id), [product.id]),
  );
  const queuedIssue = useApp(
    useCallback(
      (s: AppSnapshot) => findIssueByNumber(s.state, product.id, queued),
      [product.id, queued],
    ),
  );
  // Our queued issue counts as pending until its card arrives and then reaches a final status.
  const queuedPending =
    queued !== null && (queuedIssue === null || !FINAL_STATUSES.includes(queuedIssue.status));
  const pendingNumber = setupIssue?.number ?? (queuedPending ? queued : null);
  const canSetUp = !configured && !requesting && pendingNumber === null;
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

  async function setUpPreview() {
    if (requestingRef.current) return;
    requestingRef.current = true;
    setRequesting(true);
    setError(null);
    try {
      const res = await addIssue(product.id, {
        title: SETUP_PREVIEW_TITLE,
        body: SETUP_PREVIEW_BODY,
        priority: SETUP_PREVIEW_PRIORITY,
        dependsOn: [],
      });
      setQueued(res.number);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not queue the Preview setup.');
    } finally {
      requestingRef.current = false;
      setRequesting(false);
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
      {!configured && pendingNumber !== null ? (
        <p role="status" className="ui-field__hint">
          Queued as #{pendingNumber}
        </p>
      ) : null}
      {canSetUp ? <Button onClick={() => void setUpPreview()}>Set up Preview</Button> : null}
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
