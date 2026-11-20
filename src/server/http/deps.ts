import type { Context } from 'hono';
import type { IdGen } from '../../shared/ids.ts';
import type { Access, AccountSettings, Sparring } from '../commands/index.ts';
import type { Git } from '../git/index.ts';
import type { Previews } from '../sandbox/index.ts';
import type { Store } from '../store/index.ts';

/** What the HTTP layer needs from the composition root. */
export interface AppDeps {
  store: Store;
  ids: IdGen;
  git: Git;
  redactor: { redact(text: string): string };
  /**
   * Owner password and sessions; login/session/password routes exist only when given. Without
   * it the server behaves as with no password set (loopback Host only, JSON + Origin checks).
   */
  access?: Access | undefined;
  /** Client identity for the login rate limit; defaults to the socket's remote address. */
  clientKey?: ((c: Context) => string) | undefined;
  /** Account settings (GET|PUT /api/settings); those routes exist only when given. */
  settings?: AccountSettings | undefined;
  /** Sparring turns (POST /spar). Optional until main.ts wires the pipeline; absent → 500. */
  sparring?: Sparring | undefined;
  /** Preview of main (POST|DELETE /api/products/:id/preview); those routes exist only when given. */
  previews?: Previews | undefined;
  /** Directory with the built SPA. Served only when it exists. */
  webRoot?: string | undefined;
  /** SSE heartbeat interval; defaults to HEARTBEAT_MS. Tests shorten it. */
  heartbeatMs?: number | undefined;
}
