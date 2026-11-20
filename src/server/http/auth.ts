import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  LoginRequestSchema,
  PasswordChangeRequestSchema,
  type OkResponse,
  type SessionResponse,
} from '../../shared/dto.ts';
import type { Access } from '../commands/index.ts';
import { isLoopbackHostHeader, SESSION_COOKIE, sessionCookieOptions } from '../security/index.ts';
import { readJson } from './body.ts';
import { HttpError, fail } from './errors.ts';

// Access control (ADR 9, CODING_STANDARDS §7, ARCHITECTURE §4.3):
// - no password: only loopback Host headers are served (DNS rebinding);
// - password: every /api route except PUBLIC_API needs a valid session cookie;
// - always: mutations must be application/json and their Origin, when present, must match Host.

/** Identifies a client for the login rate limit. */
export type ClientKey = (c: Context) => string;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_API = new Set(['/api/login', '/api/session']);

/** The socket's remote address; one bucket for everyone when it is unknown. */
export const remoteAddress: ClientKey = (c) => {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

const hostOf = (c: Context): string => c.req.header('host') ?? new URL(c.req.url).host;

const isHttps = (c: Context): boolean =>
  new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';

const isJson = (contentType: string | undefined): boolean =>
  contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';

function sameOrigin(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false; // includes the opaque origin `null`
  }
}

function isAuthenticated(c: Context, access: Access | undefined): boolean {
  if (access === undefined || !access.hasPassword()) return true;
  const token = getCookie(c, SESSION_COOKIE);
  return token !== undefined && access.sessions.verify(token);
}

/** Registers the access-control middleware; runs before every route, the SPA included. */
export function installAccessControl(app: Hono, access: Access | undefined): void {
  app.use('*', async (c, next) => {
    const passwordSet = access?.hasPassword() ?? false;
    const host = hostOf(c);
    if (!passwordSet && !isLoopbackHostHeader(host)) {
      throw new HttpError(
        'forbidden',
        'Vibecode answers only on localhost until an owner password is set',
      );
    }
    if (MUTATING.has(c.req.method)) {
      if (!isJson(c.req.header('content-type'))) {
        throw new HttpError('unsupported_media_type', 'Requests that change data must be JSON');
      }
      const origin = c.req.header('origin');
      if (origin !== undefined && !sameOrigin(origin, host)) {
        throw new HttpError('forbidden', 'Cross-origin requests are not allowed');
      }
    }
    const path = c.req.path;
    const isApi = path === '/api' || path.startsWith('/api/');
    if (passwordSet && isApi && !PUBLIC_API.has(path) && !isAuthenticated(c, access)) {
      throw new HttpError('unauthorized', 'Log in first');
    }
    await next();
  });
}

/** POST /api/login, POST /api/logout, GET /api/session, POST /api/settings/password. */
export function registerAuthRoutes(app: Hono, access: Access, clientKey: ClientKey): void {
  const startSession = (c: Context) => {
    setCookie(c, SESSION_COOKIE, access.sessions.issue(), sessionCookieOptions(isHttps(c)));
  };

  app.get('/api/session', (c) => {
    const body: SessionResponse = {
      passwordSet: access.hasPassword(),
      authenticated: isAuthenticated(c, access),
    };
    return c.json(body);
  });

  app.post('/api/login', async (c) => {
    const { password } = LoginRequestSchema.parse(await readJson(c));
    const result = await access.login(password, clientKey(c));
    if (!result.ok) return fail(result);
    setCookie(c, SESSION_COOKIE, result.token, sessionCookieOptions(isHttps(c)));
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  app.post('/api/logout', (c) => {
    // End the session on the server too: a copied cookie must not outlive the logout.
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) access.sessions.revoke(token);
    deleteCookie(c, SESSION_COOKIE, sessionCookieOptions(isHttps(c)));
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  app.post('/api/settings/password', async (c) => {
    const input = PasswordChangeRequestSchema.parse(await readJson(c));
    const result = await access.changePassword(input, clientKey(c));
    if (!result.ok) return fail(result);
    // The change rotated the session key: every session ended, the caller gets a new one.
    startSession(c);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });
}
