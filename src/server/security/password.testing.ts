import { createPasswordHasher } from './password.ts';

/** Tests only (ADR 11): scrypt at N=2^10 so logins cost milliseconds. Never use in production. */
export const fastPasswordHasher = createPasswordHasher({ N: 2 ** 10 });
