# 0011. Test-suite flake strategy: injectable password hasher, focused flake checks, one final full-suite stability gate

Date: 2026-11-20 · Status: Accepted

## Context

#123 failed twice because its check ran the whole suite 3 times. That can't pass while other known flakes are still open: auth.test.ts rate-limit (#125), AuthGate (#124), and slow jsdom tests (ApplyChanges 5.4 s per file, BuildTab 3.4 s for a single test under load). Every flake issue had the same full-suite check, so the issues deadlocked each other. The main driver of the server flakes is real scrypt at N=2^15 on every login in access.test.ts and auth.test.ts (~3.9 s for the rate-limit test even alone). verifyPassword only accepts the production N.

## Options considered

- **Precompute one hash per file**: Removes only the hashing cost. Each verify still runs N=2^15, so a rate-limit test with ~6 logins stays slow.
- **verify accepts any N recorded in the hash**: Lets a lower-cost stored hash pass in production. Small weakening, and a change to security semantics.
- **Injectable PasswordHasher in AccessDeps (chosen)**: password.ts exports createPasswordHasher({ N }) → { hash, verify }; verify enforces that hasher's own N. The production default is N=2^15. createAccess takes an optional `passwords` dep that defaults to the production hasher. Tests pass createPasswordHasher({ N: 2**10 }), which is real scrypt on the same code path at low cost. No env switch.
- **Raise global timeouts**: Hides real hangs and doesn't fix the cause. Rejected as a blanket fix.

## Decision

1) Add the injectable PasswordHasher seam. Use it in access.test.ts and auth.test.ts together, in one issue. 2) Each flake issue checks only its own file(s), with repeated focused runs and no full-suite loop. 3) One final issue, 'full suite stable', is blocked by all the flake fixes. It runs the full suite 3× and fixes any remaining flakes by root cause. For the jsdom web project only, it may set a project-level testTimeout of up to 15 s and a Testing Library asyncUtilTimeout of up to 3 s, if it documents which tests needed it. Those tests are CPU-bound renders under parallel load, not hangs. The unit project keeps the 5 s default.

## Rationale

This removes the cause (the crypto cost in tests) and still exercises real scrypt and the production N check (password.test.ts keeps testing N=2^15). It also breaks the deadlock: no single issue has to fix every flake to pass its check.
