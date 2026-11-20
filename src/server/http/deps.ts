import type { IdGen, ProductId } from '../../shared/ids.ts';
import type { AccountSettings, Sparring } from '../commands/index.ts';
import type { Git } from '../git/index.ts';
import type { Previews } from '../sandbox/index.ts';
import type { Store } from '../store/index.ts';

/** What the HTTP layer needs from the composition root. */
export interface AppDeps {
  store: Store;
  ids: IdGen;
  git: Git;
  redactor: { redact(text: string): string };
  /** Account settings (GET|PUT /api/settings); those routes exist only when given. */
  settings?: AccountSettings | undefined;
  /** The scheduler's per-product merge lock; apply-prd commits docs/PRD.md under it. */
  withMergeLock?: (<T>(productId: ProductId, fn: () => Promise<T>) => Promise<T>) | undefined;
  /** Sparring turns (POST /spar). Optional until main.ts wires the pipeline; absent → 500. */
  sparring?: Sparring | undefined;
  /** Preview of main (POST|DELETE /api/products/:id/preview); those routes exist only when given. */
  previews?: Previews | undefined;
  /** `data/logs` (agent logs, GET /api/agents/:id/log); that route exists only when given. */
  logsDir?: string | undefined;
  /** How often a followed agent log is re-read; defaults to LOG_POLL_MS. Tests shorten it. */
  logPollMs?: number | undefined;
  /** Directory with the built SPA. Served only when it exists. */
  webRoot?: string | undefined;
  /** SSE heartbeat interval; defaults to HEARTBEAT_MS. Tests shorten it. */
  heartbeatMs?: number | undefined;
}
