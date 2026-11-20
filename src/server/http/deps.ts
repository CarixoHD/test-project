import type { Store } from '../store/index.ts';

/** What the HTTP layer needs from the composition root. */
export interface AppDeps {
  store: Store;
  redactor: { redact(text: string): string };
  /** Directory with the built SPA. Served only when it exists. */
  webRoot?: string | undefined;
  /** SSE heartbeat interval; defaults to HEARTBEAT_MS. Tests shorten it. */
  heartbeatMs?: number | undefined;
}
