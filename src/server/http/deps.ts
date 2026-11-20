import type { IdGen } from '../../shared/ids.ts';
import type { AccountSettings } from '../commands/index.ts';
import type { Store } from '../store/index.ts';

/** What the HTTP layer needs from the composition root. */
export interface AppDeps {
  store: Store;
  ids: IdGen;
  redactor: { redact(text: string): string };
  /** Account settings (GET|PUT /api/settings); those routes exist only when given. */
  settings?: AccountSettings | undefined;
  /** Directory with the built SPA. Served only when it exists. */
  webRoot?: string | undefined;
  /** SSE heartbeat interval; defaults to HEARTBEAT_MS. Tests shorten it. */
  heartbeatMs?: number | undefined;
}
