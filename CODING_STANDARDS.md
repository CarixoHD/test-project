# Coding standards (enforced in review)

Reviewers reject changes that break a **MUST**. A **SHOULD** needs a written reason to skip.

## 1. General
- MUST keep each change inside its issue's scope. Unrelated refactors go in a follow-up note.
- MUST keep typecheck, lint and tests green. Never disable a lint rule inline without a comment saying why.
- MUST NOT add a dependency without a reason in the PR summary. Pin exact versions (`--save-exact`).
- SHOULD keep functions under ~60 lines and files under ~400 lines, and split by responsibility.
- SHOULD prefer deep modules: a small exported surface (`index.ts`) that hides the internals.

## 2. TypeScript
- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax`, `erasableSyntaxOnly`.
- MUST NOT use `any`. Use `unknown` and narrow it with zod or type guards. MUST NOT use non-null `!` except in tests.
- MUST use erasable syntax only: no `enum`, no `namespace`, no parameter properties. Use `as const` and string unions.
- Relative imports MUST include the extension (`./foo.ts`). Use `import type` for type-only imports.
- SHOULD use discriminated unions for results and states, with an exhaustive `switch` and an `assertNever` default.

## 3. Naming
- Files: `kebab-case.ts`. React components: `PascalCase.tsx`. Tests: `<file>.test.ts(x)`.
- Types, interfaces and components: `PascalCase`. Functions and variables: `camelCase`. Module-level constants: `UPPER_SNAKE_CASE`.
- Event types: `noun.past_tense_verb` (`issue.created`, `attempt.ended`). Commands are imperative verbs (`cancelIssue`).
- Booleans read as predicates: `isReady`, `hasPassword`, `shouldStop`.
- DB columns: `snake_case`. TS fields: `camelCase`. Drizzle maps between them.

## 4. Architecture rules
- `src/shared` MUST be pure. No `node:*`, no `fetch`, no `Date.now()` or `Math.random()`: time and ids are passed in. It MUST NOT import from `src/server` or `src/web`.
- `src/web` MUST NOT import `src/server`. Talk to the server through `src/web/state/api.ts` using DTOs from `src/shared/dto.ts`.
- All writes MUST go through `store.commit()`, so projections and events change in the same transaction. Every new event type MUST have a zod schema, a `reduce` case and coverage in the snapshot≡replay test.
- Child processes MUST go through `src/server/util/exec.ts` with argv arrays. No `shell: true` and no string interpolation into commands. `docker` is called only from `src/server/sandbox`, and `git` only from `src/server/git`.
- Every git invocation MUST carry `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, which the git module adds.
- Agent prompts live in `src/server/pipeline/prompts/*.md`.
- Pipeline steps MUST be safe to run again after a crash. Record the outcome only after the step succeeds.

## 5. Error handling
- Expected failures (validation, illegal transition, not found, stale `rev`) MUST be returned as `{ok:false, reason}` and mapped by HTTP to 400/404/409 with the body `{error:{code, message}}`.
- Throw only for programmer errors or infrastructure faults (DB, Docker, git). Catch them at the boundary: the HTTP error middleware, or the pipeline run wrapper, which records `attempt.ended{status:'error'}` plus an inbox item.
- MUST NOT swallow errors. Every `catch` either handles the error meaningfully or rethrows with context (`new Error(msg, {cause})`).
- Every external call (LLM, docker, git, fetch) MUST have a timeout and MUST honour `AbortSignal` or `shouldStop`.
- Error messages shown to the owner MUST be actionable ("Docker is not running: start Docker Desktop") and redacted.

## 6. Testing
- Work test-first. Every behaviour change comes with a test that fails without it. Every bug fix comes with a regression test.
- MUST NOT weaken, skip (`.skip`, `.only`, `todo`) or delete tests to make them pass. MUST NOT hard-code expected outputs into production code.
- `npm test` MUST run offline: no real LLM, no network and no Docker. Use `fakeModel`, `FakeContainerRuntime`, an injected `Clock`/`IdGen`, `:memory:` SQLite, and real git in `mkdtemp`.
- Test through public interfaces (module `index.ts`, HTTP via `app.request()`, components via Testing Library queries by role and name). Don't assert on private internals.
- Pure state logic (transitions, reducers, budget, pricing) MUST have table-driven tests, including the illegal cases.
- Tests MUST be deterministic: no sleeps (use fake timers or the injected clock), no ordering dependence, and temp dirs cleaned up in `afterEach`.
- Tests that need Docker live in `tests/docker/`. Tests that need a browser live in `tests/e2e/`. They MUST fail loudly when the dependency is missing, never pass silently.

## 7. Security (non-negotiable)
- The server MUST bind to `127.0.0.1` unless a password hash exists (`assertBindAllowed`). With no password, requests whose `Host` is not loopback MUST be rejected, which guards against DNS rebinding.
- When a password is set, every `/api` route except login and session requires a valid signed session cookie (HttpOnly, SameSite=Strict, Secure when served over HTTPS). Mutating requests MUST be JSON, and their `Origin`, when present, MUST match the server's own origin.
- Passwords are hashed with scrypt from `node:crypto` and compared with `timingSafeEqual`. Login attempts are rate-limited.
- Secrets (API keys, git tokens, the session key) live only in the `secrets` table. They MUST NOT appear in events, logs, error messages, product repos, container env or HTTP responses (masked to the last 4 characters). All text bound for logs or events passes through `redactor.redact`.
- Containers MUST be created via `buildRunArgs`. Never mount `docker.sock` or any path outside `data/worktrees`. Keep `.git` masked, `--cap-drop ALL`, `no-new-privileges`, a read-only rootfs, resource limits, and the non-root host uid:gid. Checks run with network `none`. Published ports bind `127.0.0.1` only.
- Claude Code: drive only the unmodified CLI. MUST NOT read, copy or store anything from the `vibecode-claude-config` volume. MUST NOT set `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` for it, and MUST NOT use `--bare`.
- Treat all worktree content and agent output as untrusted data. Validate with zod, never `eval`, never interpolate it into shell or SQL (use Drizzle parameters), and render it in the UI as text (no `dangerouslySetInnerHTML`; markdown goes through a sanitising renderer).
- File paths from agents MUST be relative, normalised, and confined to `/workspace`.

## 8. Accessibility and UI
- MUST use semantic elements (`button`, `nav`, `main`, `table`/lists, headings in order) and a label for every form control. Icon-only buttons need an `aria-label`.
- Everything MUST work by keyboard: logical tab order, a visible `:focus-visible` style, Esc closes dialogs, and focus is trapped in and returned from dialogs.
- Contrast MUST meet WCAG 2.2 AA (4.5:1 for text, 3:1 for UI components). Colour MUST NOT be the only signal; issue status also has a text label.
- Live updates use a polite `aria-live` region for inbox and status announcements, without flooding: no per-log-line announcements.
- The 3D view MUST be decorative relative to the board and agent list (same info available elsewhere), MUST respect `prefers-reduced-motion`, and MUST stop rendering when collapsed (`frameloop="never"`).
- English UI strings only. Keep them in components (no i18n framework in v1).

## 9. Performance
- The SSE event-to-UI path MUST stay under 1 s. Don't put agent log lines in the main stream; batch `agent.activity` at most every 250 ms.
- Server request handlers SHOULD avoid N+1 queries. Use a single query per view via `store.q`.
- The 3D scene SHOULD stay under 60 draw calls: InstancedMesh per piece type, DPR capped at 1.5, no postprocessing.
