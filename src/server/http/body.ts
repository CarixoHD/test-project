import type { Context } from 'hono';
import { fail } from './errors.ts';

/**
 * Reads the request body as JSON. Malformed JSON is the client's fault, so it becomes a 400
 * `invalid` instead of a 500. Every route reads its body through this; validate the result with zod.
 */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    return fail({ ok: false, reason: 'The request body must be valid JSON' });
  }
}
