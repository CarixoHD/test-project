# AGENTS.md: implementer manual

Read this first. Then read `docs/ARCHITECTURE.md` (module interfaces and flows) and `CODING_STANDARDS.md` (what review enforces). The product spec is in `docs/PRD.md`, and the decisions are in `docs/decisions/`.

## What this is
Vibecode runs as one Node 22 process with one SQLite file. Owner commands come in over REST, and events go out over SSE. A scheduler drives AI agents (sparring, orchestrator, implementer, reviewer). They work in Docker containers on git worktrees, and passing work is merged to each product's `main`.

## Layout
```
src/shared/   pure TS shared by server + web (events, reduce, issue state machine, scene reducer, DTOs)
src/server/   Node: db/ store/ http/ commands/ scheduler/ pipeline/ agents/ llm/ sandbox/ git/ security/ recovery/ notify/ util/
src/web/      React SPA: state/ features/ scene/ ui/
docker/       vibecode/base and vibecode/claude-code images
scripts/      dev.mjs, update-prices.mjs, set-password.ts
tests/e2e/    Playwright (demo mode)      tests/docker/  needs a real Docker daemon
```
Unit tests sit next to the code: `foo.ts` → `foo.test.ts`, and `Board.tsx` → `Board.test.tsx`.

## Commands (run from the repo root)
| Task | Command |
|---|---|
| Install | `npm ci` |
| Dev (demo mode, fake LLM + fake Docker) | `npm run dev` (UI on `$PORT`, API on `$PORT+1`) |
| All unit/integration tests | `npm test` |
| One test file | `npx vitest run src/shared/issues.test.ts` |
| One test by name | `npx vitest run -t "retries with feedback"` |
| Watch | `npx vitest` |
| Typecheck | `npm run typecheck` |
| Lint (ESLint + Prettier check) | `npm run lint` |
| Auto-format / fix | `npm run format` then `npx eslint --fix .` |
| DB migration after editing `src/server/db/schema.ts` | `npm run db:generate` (commit the generated SQL) |
| Browser E2E (needs `npx playwright install chromium`) | `npm run test:e2e` |
| Docker suite (needs Docker) | `npm run test:docker` |
| Production | `npm run build && npm start` |

Before you finish, run `npm run typecheck && npm run lint && npm test`. All three must pass. If you touched a UI flow that Playwright covers, also run `npm run test:e2e` when browsers are available.

## How to work
1. **Test first.** Write a failing test that captures the behaviour, make it pass, then refactor. Bugs get a regression test.
2. **Stay in your issue.** If you find other work, note it in your final report. Don't do it.
3. **Respect module boundaries.** Import other modules through their `index.ts`. Change a public interface only when your issue needs it, and update `docs/ARCHITECTURE.md` in the same change.
4. **Keep shared code pure.** `src/shared` must not import `node:*`, the server, the web code or anything with I/O. Lint enforces this.
5. **Use the fakes in tests.** Never call real LLM providers or the network in `npm test`. Use the fakes:
   - LLM: `fakeModel(script)` from `src/server/llm`
   - containers: `FakeContainerRuntime` from `src/server/sandbox`
   - time and ids: inject the `Clock` / `IdGen`
   - git: real `git` in a `mkdtemp` dir is fine and preferred
6. **Write state only through the store.** All state changes go through `store.commit()`, which updates the projection tables AND appends events in one transaction. Never write SQL outside `src/server/store` and `src/server/db`.
7. **Every new event type** needs three things:
   - a zod schema in `src/shared/events.ts`
   - a case in `reduce` (and in `sceneReduce` if it is visible)
   - coverage in the snapshot≡replay test
8. **Spawn processes only through `src/server/util/exec.ts`.** Use argv arrays and no shell strings. `docker` is only called from `src/server/sandbox`, and `git` only from `src/server/git`.

## Conventions (short version; details in CODING_STANDARDS.md)
- TypeScript strict, ESM. Relative imports end in `.ts`/`.tsx`, because the server runs on Node type stripping. Erasable syntax only: no `enum`, no `namespace`, no constructor parameter properties. Use `as const` objects and union types.
- Files: `kebab-case.ts`. React components: `PascalCase.tsx`. Types and components: `PascalCase`. Functions and vars: `camelCase`. Constants: `UPPER_SNAKE`.
- Validate every external input with zod: HTTP bodies, env, agent results and `.vibecode/project.json`.
- Errors: domain functions return `{ok:false, reason}` results. Throw only for programmer errors and infrastructure failures. HTTP maps results to 400/404/409.
- Never log or emit secrets. Pass text through `redactor.redact` on the way to logs, events and error messages.
- Ids are ULIDs from `IdGen`. Timestamps are epoch ms from `Clock`.
- UI: semantic HTML, keyboard reachable, visible focus, and labels on every control. The 3D view is never the only place where information appears.
- Prompts for agents live in `src/server/pipeline/prompts/*.md`, not inline strings.

## Environment
- Node ≥ 22.18 (runs `.ts` natively) and git ≥ 2.38. Docker is optional for `npm test`.
- Env vars: `VIBECODE_DATA_DIR`, `VIBECODE_HOST` (default 127.0.0.1), `VIBECODE_PORT` (default 4317), `VIBECODE_DEMO=1`, `VIBECODE_FAKE_DOCKER=1`.
- Never commit `.data/`, `data/`, `.env*` or API keys.

## Definition of done
- Acceptance criteria of the issue are met and covered by tests.
- typecheck, lint and test all pass on your branch.
- Your final report says what changed and lists any follow-up work you noticed.
