import { GitTokenUpdateRequestSchema, type GitTokenView } from '../../shared/dto.ts';
import type { ProductId } from '../../shared/ids.ts';
import { gitTokenSecret, type Secrets } from '../security/index.ts';
import type { Store } from '../store/index.ts';

// Owner command: a product's git remote access token (ARCHITECTURE §4.3
// GET|PUT /api/products/:id/git-token). Write-only: it lives in `secrets` (registered with the
// redactor), never in events or state, and reads show at most its last 4 characters. Only the
// remote pusher (pipeline/remote-push.ts) reads the value, to hand it to git.push.

export type GitTokenResult =
  { ok: true; view: GitTokenView } | { ok: false; code: 'invalid' | 'not_found'; reason: string };

export interface GitTokens {
  view(productId: ProductId): GitTokenResult;
  /** `input` is validated with GitTokenUpdateRequestSchema; a string sets, null removes. */
  update(productId: ProductId, input: unknown): GitTokenResult;
}

export interface GitTokensDeps {
  store: Store;
  secrets: Pick<Secrets, 'set' | 'delete' | 'list'>;
}

const notFound = (productId: ProductId): GitTokenResult => ({
  ok: false,
  code: 'not_found',
  reason: `No product ${productId}`,
});

export function createGitTokens({ store, secrets }: GitTokensDeps): GitTokens {
  const viewOf = (productId: ProductId): GitTokenView => {
    const info = secrets.list().find((s) => s.key === gitTokenSecret(productId));
    return { set: info !== undefined, last4: info?.last4 ?? null };
  };
  return {
    view(productId) {
      if (store.q.product(productId) === null) return notFound(productId);
      return { ok: true, view: viewOf(productId) };
    },
    update(productId, input) {
      const parsed = GitTokenUpdateRequestSchema.safeParse(input);
      if (!parsed.success) {
        // Messages only: zod issues may carry the rejected value.
        const reason = parsed.error.issues.map((i) => i.message).join('; ');
        return { ok: false, code: 'invalid', reason };
      }
      if (store.q.product(productId) === null) return notFound(productId);
      const { token } = parsed.data;
      if (token === null) secrets.delete(gitTokenSecret(productId));
      else secrets.set(gitTokenSecret(productId), token);
      return { ok: true, view: viewOf(productId) };
    },
  };
}
