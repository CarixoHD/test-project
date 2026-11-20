import { Redactor } from './redact.ts';

export { Redactor, LAST4_MIN_LENGTH, MIN_SECRET_LENGTH, REDACTED } from './redact.ts';
export { createSecrets, type SecretInfo, type Secrets, type SecretsDeps } from './secrets.ts';

/** Process-wide redactor: every secret value is registered here when loaded or stored. */
export const redactor = new Redactor();
