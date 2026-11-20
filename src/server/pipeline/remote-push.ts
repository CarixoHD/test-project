import type { Event } from '../../shared/events.ts';
import { validateGitRemoteUrl } from '../../shared/git-remote.ts';
import type { IdGen, ProductId } from '../../shared/ids.ts';
import type { Git } from '../git/index.ts';
import { gitTokenSecret, type Secrets } from '../security/index.ts';
import type { Store } from '../store/index.ts';

// Optional push of main to the product's git remote (PRD 'Code location', ARCHITECTURE §6
// flow 4 step 7). A store subscriber: after a merge (issue.completed), a PRD commit
// (prd.applied) or a newly configured remote it pushes asynchronously, outside the merge lock,
// one push at a time per product (requests during a push coalesce into one more push). A
// failure never touches the issue; it becomes an inbox error the owner can act on.

export interface RemotePusherDeps {
  store: Store;
  ids: IdGen;
  git: Pick<Git, 'push'>;
  secrets: Pick<Secrets, 'get'>;
  redactor: { redact(text: string): string };
}

export interface RemotePusher {
  /** Queue a push of the product's main (no-op when it has no remote). */
  request(productId: ProductId): void;
  /** Resolves when no push is running or queued (tests, shutdown). */
  idle(): Promise<void>;
  /** Unsubscribes from the store; running pushes finish. */
  stop(): void;
}

export const PUSH_FAILED_TITLE = 'Push to the git remote failed';
export const INVALID_REMOTE_TITLE = 'Git remote URL is not allowed';

/** Events after which main may have moved (or the remote just became known). */
function wantsPush(e: Event): boolean {
  switch (e.type) {
    case 'issue.completed':
    case 'prd.applied':
      return true;
    case 'product.settings_changed':
      return e.data.gitRemote !== undefined && e.data.gitRemote !== null;
    default:
      return false;
  }
}

export function startRemotePusher(deps: RemotePusherDeps): RemotePusher {
  const { store, ids, git, secrets, redactor } = deps;
  const running = new Map<ProductId, Promise<void>>();
  const again = new Set<ProductId>();
  /** The last reported failure per product: an identical one is not reported again. */
  const lastError = new Map<ProductId, string>();

  const report = (productId: ProductId, title: string, body: string): void => {
    if (lastError.get(productId) === body) return;
    lastError.set(productId, body);
    store.commit(() => [
      {
        type: 'inbox.created',
        productId,
        entityId: ids.next('inbox'),
        v: 1,
        data: { kind: 'error', title, body, link: `/products/${productId}/settings` },
      },
    ]);
  };

  const pushOnce = async (productId: ProductId): Promise<void> => {
    const product = store.q.product(productId);
    const remote = product?.settings.gitRemote ?? null;
    if (product === null || remote === null) return;
    const name = product.name;
    // Stored URLs may predate the URL rule (#97): check again, and never hand a bad one to git.
    // The URL itself is left out of the message (it may carry credentials).
    const valid = validateGitRemoteUrl(remote.url);
    if (!valid.ok) {
      report(
        productId,
        INVALID_REMOTE_TITLE,
        `Main of ${name} was not pushed: the stored git remote URL is not allowed. ` +
          `${valid.reason} Fix the remote URL in the product's Settings tab.`,
      );
      return;
    }
    try {
      await git.push(productId, { url: remote.url, token: secrets.get(gitTokenSecret(productId)) ?? null });
      lastError.delete(productId);
    } catch (err) {
      const reason = redactor.redact(err instanceof Error ? err.message : String(err));
      report(
        productId,
        PUSH_FAILED_TITLE,
        `Pushing main of ${name} to ${redactor.redact(remote.url)} failed: ${reason}\n` +
          "Check the remote URL and the access token in the product's Settings tab. " +
          'The build goes on; the next merge pushes again.',
      );
    }
  };

  const run = async (productId: ProductId): Promise<void> => {
    try {
      // Leave the committing subscriber first: the push never runs inside a store notification.
      await Promise.resolve();
      for (;;) {
        again.delete(productId);
        try {
          await pushOnce(productId);
        } catch (err) {
          // Only a store failure lands here; nothing to report it through but the log.
          console.error(redactor.redact(`git push of ${productId} failed: ${String(err)}`));
        }
        if (!again.has(productId)) break;
      }
    } finally {
      // Same microtask as the last `again` check: no request can slip in between.
      running.delete(productId);
    }
  };

  const request = (productId: ProductId): void => {
    if (running.has(productId)) {
      again.add(productId);
      return;
    }
    running.set(productId, run(productId));
  };

  const unsubscribe = store.subscribe((e) => {
    if (e.productId !== null && wantsPush(e)) request(e.productId);
  });

  return {
    request,
    async idle() {
      while (running.size > 0) await Promise.all(running.values());
    },
    stop: unsubscribe,
  };
}
