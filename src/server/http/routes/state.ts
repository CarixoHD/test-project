import type { Hono } from 'hono';
import type { StateResponse } from '../../../shared/dto.ts';
import type { AppDeps } from '../deps.ts';

/** GET /api/state: the snapshot plus the seq it is consistent with (SSE resumes after it). */
export function registerStateRoutes(app: Hono, { store }: AppDeps): void {
  app.get('/api/state', (c) => {
    const body: StateResponse = store.snapshot();
    return c.json(body);
  });
}
