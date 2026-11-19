# 0002. Stack: TypeScript on Node 22 (type stripping), Hono, React 19 + Vite, single npm package

Date: 2026-11-19 · Status: Accepted

## Context

We need one language across server and browser so the event reducers can be shared. The sandbox and target hosts provide Node 22. AI SDK v7 requires Node 22 and ESM. Tooling must give fast unit tests, typecheck and lint.

## Options considered

- **TypeScript/Node 22, single npm package, Hono, React+Vite**: Shared reducers; Node 22.18+ runs .ts natively (no server build); Hono has app.request() for tests and built-in streamSSE.
- **TypeScript, pnpm monorepo, Fastify**: Cleaner package boundaries but workspace tooling overhead; Fastify needs manual SSE.
- **Python (FastAPI + LiteLLM) backend + TS frontend**: Two languages, no shared reducer; LiteLLM had two 2026 supply-chain compromises.

## Decision

TypeScript 6.0.x (strict, erasableSyntaxOnly, verbatimModuleSyntax, .ts import extensions) on Node >=22.18. The server runs from source via Node's built-in type stripping. The project is one npm package (package-lock) with src/shared, src/server and src/web, and ESLint import restrictions enforce the boundaries. The server uses Hono 4 and @hono/node-server, with zod 4 for validation. The web app uses React 19.3, react-router 8, Vite 8 and CSS Modules. Tests use Vitest 5 (projects: unit/node, web/jsdom, docker opt-in), Testing Library and Playwright 1.65. Lint uses ESLint 9 flat config, typescript-eslint 8, react-hooks, jsx-a11y and Prettier 3. Pin TypeScript to 6.0: TS 7 (native) is outside typescript-eslint's supported range (<6.1). Pin ESLint to 9: eslint-plugin-jsx-a11y 6.10 does not declare ESLint 10.

## Rationale

One language lets server and browser share the reducers, the issue state machine and the DTO schemas, which are the core test surface. Node type stripping (verified in the sandbox on Node 22.23) removes the server build and tsx from the loop. The single package keeps commands identical for every implementer. The version pins were checked against the npm registry on 2026-11-19, including peer ranges: typescript-eslint peer typescript <6.1.0, jsx-a11y peer eslint ≤9, vitest 5 peer vite ≤8, and R3F 9.8.2 peer react <19.4.

## Sources

- [Research: stack and LLM abstraction](docs/research/which-stack-and-llm-abstraction-best-fit-a-self-ho.md)
- [Node.js type stripping](https://nodejs.org/api/typescript.html)
- [Hono streaming helper](https://hono.dev/docs/helpers/streaming)
