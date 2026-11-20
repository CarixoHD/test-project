import { Hono } from 'hono';
import type { InboxId } from '../../shared/ids.ts';
import { InboxIdSchema } from '../../shared/ids.ts';
import type { Store } from '../store/index.ts';

export type MarkReadResult = { ok: true } | { ok: false; reason: string; code: 'not_found' };

/** Owner command: marks an inbox item read. Idempotent: an already-read item emits nothing. */
export function markInboxRead(store: Store, id: InboxId): MarkReadResult {
  let result: MarkReadResult = { ok: true };
  store.commit((tx) => {
    const item = tx.q.inboxItem(id);
    if (item === null) {
      result = { ok: false, reason: `Inbox item ${id} not found`, code: 'not_found' };
      return [];
    }
    if (item.read) return [];
    return [{ type: 'inbox.read', productId: item.productId, entityId: id, v: 1, data: {} }];
  });
  return result;
}

/** `POST /api/inbox/:id/read`; mounted by the HTTP app (paths are absolute). */
export function inboxRoutes({ store }: { store: Store }): Hono {
  const app = new Hono();
  app.post('/api/inbox/:id/read', (c) => {
    const id = InboxIdSchema.parse(c.req.param('id'));
    const result = markInboxRead(store, id);
    if (!result.ok) return c.json({ error: { code: result.code, message: result.reason } }, 404);
    return c.json({ ok: true });
  });
  return app;
}
