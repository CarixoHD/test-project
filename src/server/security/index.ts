import { Redactor } from './redact.ts';

export { Redactor, LAST4_MIN_LENGTH, MIN_SECRET_LENGTH, REDACTED } from './redact.ts';
export { createSecrets, type SecretInfo, type Secrets, type SecretsDeps } from './secrets.ts';
export { hashPassword, verifyPassword } from './password.ts';
export {
  createSessions,
  newSessionKey,
  SESSION_COOKIE,
  SESSION_KEY_SECRET,
  SESSION_TTL_MS,
  sessionCookieOptions,
  type Sessions,
  type SessionsDeps,
} from './session.ts';
export { assertBindAllowed, isLoopbackHost, isLoopbackHostHeader } from './bind.ts';
export { createRateLimiter, type RateLimiter } from './rate-limit.ts';

/** Process-wide redactor: every secret value is registered here when loaded or stored. */
export const redactor = new Redactor();
