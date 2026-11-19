# 0009. Access control and secrets: loopback by default, scrypt password, signed cookie, Host check, redaction

Date: 2026-11-19 · Status: Accepted

## Context

The platform holds API keys and can execute code. By default only localhost may reach it. Remote access is allowed only behind a single owner password. Secrets must never leak into logs, repos or the UI.

## Options considered

- **In-house: scrypt (node:crypto) + HMAC-signed session cookie**: No native deps, a small and testable surface.
- **argon2id via native module**: Stronger KDF, but another native build dependency.
- **Auth library (lucia, better-auth)**: Built for multi-user; overkill for one password.

## Decision

assertBindAllowed refuses to start on a non-loopback VIBECODE_HOST unless a password hash exists. With no password, requests with a non-loopback Host header are rejected, which defends against DNS rebinding. The password is hashed with scrypt (N=2^15) and compared with timingSafeEqual, and logins are rate-limited. The session is an HMAC-SHA256-signed cookie (HttpOnly, SameSite=Strict, Secure over HTTPS, 30-day expiry). Mutations must be JSON, with an Origin check. Secrets live in the SQLite `secrets` table (DB file 0600, data dir 0700) and are never put in events, logs, container env or repos. The UI shows the last 4 characters. A Redactor registers every secret value and is applied in store.commit, the log writer and error paths. Git push tokens are passed through GIT_ASKPASS env and redacted. The docs recommend Tailscale or a TLS reverse proxy for remote use.

## Rationale

These choices meet the PRD's security requirements and security tests with no native dependencies beyond better-sqlite3. At-rest encryption with a key file in the same directory would add little protection, so it was skipped; file permissions are the boundary.

## Sources

- [Node crypto.scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
