import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

/** Error codes of expected failures and the HTTP status each maps to (CODING_STANDARDS §5). */
export const ERROR_STATUS = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unsupported_media_type: 415,
  rate_limited: 429,
} as const satisfies Record<string, ContentfulStatusCode>;
export type ErrorCode = keyof typeof ERROR_STATUS;

/** A domain function's `{ok:false, reason}` result; `code` defaults to `invalid` (400). */
export interface DomainFailure {
  ok: false;
  reason: string;
  code?: ErrorCode;
}

/** Body of every error response. */
export interface ErrorBody {
  error: { code: ErrorCode | 'internal'; message: string };
}

/** An expected failure on its way to the error middleware. */
export class HttpError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
  }
}

/** Routes call this with a failed domain result; the error middleware turns it into a response. */
export function fail(result: DomainFailure): never {
  throw new HttpError(result.code ?? 'invalid', result.reason);
}

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/** Registers the error middleware and the JSON 404 for unknown routes. */
export function installErrorHandling(app: Hono, redactor: { redact(text: string): string }): void {
  const send = (c: Context, code: ErrorBody['error']['code'], message: string) => {
    const status = code === 'internal' ? 500 : ERROR_STATUS[code];
    const body: ErrorBody = { error: { code, message: redactor.redact(message) } };
    return c.json(body, status);
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return send(c, err.code, err.message);
    if (err instanceof ZodError) return send(c, 'invalid', zodMessage(err));
    // Infrastructure fault or programmer error: log (redacted) and answer 500.
    console.error(redactor.redact(err.stack ?? err.message));
    return send(c, 'internal', `Internal error: ${err.message}`);
  });

  app.notFound((c) => send(c, 'not_found', `No route for ${c.req.method} ${c.req.path}`));
}
