import { Redactor } from './redact.ts';

export { Redactor, MIN_SECRET_LENGTH, REDACTED } from './redact.ts';

/** Process-wide redactor: every secret value is registered here when loaded or stored. */
export const redactor = new Redactor();
