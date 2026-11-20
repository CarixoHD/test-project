import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { AttemptIdSchema } from '../../../shared/ids.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';

/** Heading between the attempt's check output and the re-check on the merge with main. */
export const RECHECK_HEADING = '--- Check on the merge with main ---';

/** Contents of a file, or null when it does not exist. */
async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * GET /api/attempts/:id/diff → `diff.patch`; GET /api/attempts/:id/check → `check.log`, then
 * `integration-check.log` under RECHECK_HEADING when the merge was re-checked. Plain text,
 * redacted again on the way out. Unknown attempt or artifact not written yet → 404.
 */
export function registerAttemptRoutes(
  app: Hono,
  { store, redactor }: AppDeps,
  artifactsDir: string,
): void {
  /** The attempt's artifact directory; only ids the store knows reach the file system. */
  const dirOf = (raw: string): string => {
    const id = AttemptIdSchema.parse(raw);
    if (store.q.attempt(id) === null) throw new HttpError('not_found', `No attempt ${raw}`);
    return path.join(artifactsDir, id);
  };
  const text = (c: Context, body: string) =>
    c.body(redactor.redact(body), 200, { 'Content-Type': 'text/plain; charset=utf-8' });

  app.get('/api/attempts/:id/diff', async (c) => {
    const diff = await readOptional(path.join(dirOf(c.req.param('id')), 'diff.patch'));
    if (diff === null) throw new HttpError('not_found', 'This attempt has no diff yet');
    return text(c, diff);
  });

  app.get('/api/attempts/:id/check', async (c) => {
    const dir = dirOf(c.req.param('id'));
    const check = await readOptional(path.join(dir, 'check.log'));
    if (check === null) throw new HttpError('not_found', 'The check has not run for this attempt');
    const recheck = await readOptional(path.join(dir, 'integration-check.log'));
    return text(c, recheck === null ? check : `${check}\n${RECHECK_HEADING}\n${recheck}`);
  });
}
