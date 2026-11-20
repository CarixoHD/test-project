# Vibecode platform: Architecture

Status: v1 baseline (2026-11-19). The decisions behind it are recorded as ADRs in `docs/decisions/`.

## 1. Overview

Vibecode is a **single Node.js process** with **one SQLite file**. The owner self-hosts it. It drives AI agents that turn a PRD into a git repository full of working code.

```
 Browser (React SPA)                          Host process (Node 22, one process)
 ┌─────────────────────────┐   REST cmds   ┌──────────────────────────────────────────────┐
 │ Board · Spec · Inbox    │ ────────────▶ │ http (Hono) ─▶ commands ─▶ store.commit()    │
 │ AgentList · Scene3D     │ ◀──────────── │      SSE  ◀── bus ◀───────┘   (events +      │
 │ shared reducers         │  SSE events   │                               projections)   │
 └─────────────────────────┘               │ scheduler ─▶ pipeline ─▶ agents ─▶ llm        │
                                           │                 │          │                 │
                                           │                git      sandbox (docker CLI)│
                                           └──────────────────┼──────────┼─────────────────┘
                                                data/repos/<p>.git   per-attempt containers
```

Design rules:
- **Fixed pipeline, not a workflow engine.** Each attempt runs the same linear sequence: implement → check → review → merge. Issue states change through one pure transition function in `src/shared`.
- **Events + projections in one transaction.** Every state change appends rows to `events` and updates the projection tables in the same synchronous SQLite transaction. Then it publishes on an in-process bus. The browser loads a snapshot and then applies the same events with the **same shared reducer**.
- **Host owns git and secrets.** Containers only ever see a worktree. Their `.git` is masked, they get no Docker socket and no API keys. API-key agent loops run on the host. Tool calls (`run`, `write_file`, …) run inside the container through `docker exec`.
- **Every external dependency has a fake.** These are the LLM (`fake` provider), containers (`FakeContainerRuntime`) and the clock. CI and demo mode need no keys and no Docker.

## 2. Stack (exact pins live in package.json)

| Concern | Choice |
|---|---|
| Runtime | Node 22 (≥22.18). TypeScript 6.0 (`erasableSyntaxOnly`). The server runs `.ts` directly through Node type stripping, with no server build step. ESM only. |
| Package layout | One npm package with `src/shared`, `src/server` and `src/web`, plus `package-lock.json` |
| HTTP / SSE | Hono 4 + @hono/node-server (`streamSSE`) |
| Validation | zod 4 (API bodies, events, agent results, `.vibecode/project.json`) |
| Persistence | SQLite (WAL) via better-sqlite3 13 + drizzle-orm 0.45 (`drizzle-orm/better-sqlite3`). Migrations come from drizzle-kit 0.31 and are checked in. |
| LLM | Vercel AI SDK `ai` 7 + `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` and `@ai-sdk/openai-compatible`. The last one covers OpenRouter, Ollama and custom endpoints. The `fake` provider is built on `MockLanguageModelV4` from `ai/test`. |
| Subscription | Official `@anthropic-ai/claude-code` CLI, pinned (2.1.329 at time of writing), run headless inside the agent container |
| Containers | `docker` CLI through `execFile` with argv arrays. It follows the active Docker context on Linux, WSL2 and macOS. `docker buildx build` builds images. |
| Git | Host `git` ≥ 2.38 (needs `merge-tree --write-tree`) through `execFile` |
| Web | React 19, react-router 8, Vite 8, CSS Modules + CSS variables (no CSS framework) |
| 3D | three 0.187, @react-three/fiber 9.8.2 (≥9.8.2 required) and @react-three/drei 10. Lazy-loaded. Uses vendored CC0 Kenney GLB assets. |
| Tests | Vitest 5 (`unit` node project + `web` jsdom project + opt-in `docker` project), Testing Library, Playwright 1.65 |
| Lint/format | ESLint 9 flat config + typescript-eslint 8 + react-hooks + jsx-a11y, Prettier 3 |

## 3. Repository layout

```
src/
  shared/            pure TS: no I/O, no node:* imports. Imported by server AND web.
    ids.ts           ULID ids, branded types
    events.ts        Event union (zod), EVENT_VERSION, parseEvent()
    domain.ts        status/kind enums, IssueView, ProductSettings (shared by events, reduce, DTOs)
    agent-results.ts zod for SparResult, PlanResult, IssueOp, ImplResult, ReviewResult, ProjectConfig
    state.ts         ClientState type + reduce(state, event)  ← the one reducer
    issues.ts        issue state machine: transition(), isReady(), slotsFree()
    triggers.ts      orchestrator trigger selection (cursor over events)
    budget.ts        budgetLevel(), cost math priceUsage()
    scene.ts         SceneState + sceneReduce(scene, event) + sceneFromState(); scene-layout.ts: layoutPiece()
    dto.ts           REST request/response zod schemas
    models.ts        ModelRef, Role, provider ids
  server/
    main.ts          composition root: config → db → recovery → scheduler → http; closeOnSignals (SIGINT/SIGTERM)
    demo/            VIBECODE_DEMO=1 default fake scripts per role + the fake runtime's check rule
    config.ts        env parsing (zod) + bind policy
    db/              drizzle schema.ts, migrations/, open(path)
    store/           Store: commit(), queries, snapshot(), eventsSince(), bus
    http/            Hono app: routes/*, sse.ts, auth.ts, static.ts
    commands/        owner commands (createProduct, handoff, addIssue, pause, …)
    scheduler/       tick loop, slot accounting, merge lock
    pipeline/        attempt.ts, orchestrator.ts, sparring.ts, prompts/*.md
    agents/          runAgent(), api-backend.ts, claude-code-backend.ts, tools.ts
    llm/             registry.ts, fake.ts, prices.json, pricing.ts, capabilities.ts
    sandbox/         ContainerRuntime iface, docker-cli.ts, fake.ts, run-args.ts, preview.ts
    git/             git.ts (all git ops), merge.ts
    security/        secrets.ts, redact.ts, password.ts, session.ts
    recovery/        recover.ts (boot reconciliation)
    notify/          inbox rules (event → inbox item)
    util/exec.ts     the ONLY child_process wrapper (argv only, timeout, redaction)
    util/clock.ts, util/id-gen.ts  systemClock/FakeClock, monotonic ULID createIdGen(clock)/FakeIdGen
  web/
    main.tsx, App.tsx, routes/
    state/           store.ts (snapshot + EventSource + reduce), api.ts (typed fetch)
    features/        board/, issue/, sparring/, inbox/, agents/, settings/, products/
    scene/           ScenePanel.tsx, Scene3D.tsx (lazy), scene-model.ts (pure mapping), figures.ts (primitive figures/pieces; assets/ + LICENSE.md once GLBs are vendored)
    ui/              shared accessible primitives (Button, Dialog, Markdown, Tabs, …)
docker/              base.Dockerfile (vibecode/base), claude-code.Dockerfile
scripts/             dev.mjs, update-prices.mjs, set-password.ts
tests/
  e2e/               Playwright (demo mode: fake LLM + fake runtime)
  docker/            Vitest suite needing a real Docker daemon
docs/                PRD.md, ARCHITECTURE.md, decisions/, research/
```

## 4. Modules and interfaces

Each module exposes the interface below and hides everything else. Cross-module imports go through the module's `index.ts`.

### 4.1 shared (pure)
```ts
// events.ts — every event is {seq, ts, type, productId|null, entityId|null, v, data}
type Event = z.infer<typeof EventSchema>;          // discriminated union on `type`
// state.ts (per-domain reducers in state-product/-work/-account.ts; zod schema in state-schema.ts)
function reduce(s: ClientState, e: Event): ClientState;   // ignores unknown types (forward compat)
const emptyState: ClientState;
// ClientState: id-keyed records {products, prdDrafts, prdVersions (metadata only), sparMessages,
//   issues, attempts, agents (lastActivity = last line only), questions, inbox (read flag),
//   usage {byProduct, byIssue}: {apiUsd, apiUnpriced, subscriptionTokens, subscriptionCalls},
//   backendLimits (by backend), previews, settingsChangedAt (ts of the last settings.changed)}, lastSeq. prd.applied also rebases the draft.
// dto.ts
const StateResponseSchema;                                 // GET /api/state → {state: ClientState, lastSeq}
// SettingsResponseSchema / SettingsUpdateRequestSchema / SettingsUpdateResponseSchema (GET|PUT /api/settings)
// models.ts
function resolveModel(role, productModels: RoleModels, {roleDefaults, defaultModel}): ModelRef | undefined;
//   product.models[role] → roleDefaults[role] → defaultModel → undefined (caller: demo fake or 'Choose a model in Settings')
// KEYED_PROVIDER_IDS, ProviderConfigSchema (re-exported by server/llm)
// issues.ts
type IssueStatus = 'open'|'in_progress'|'in_review'|'completed'|'failed'|'cancelled';
function transition(issue: IssueView, ev: IssueTransitionEvent, cfg: {maxAttempts:number}):
  {ok:true; next: IssueView} | {ok:false; reason:string};
type IssueTransitionEvent =
  | {type:'start'} | {type:'checks_passed'} | {type:'merged'; mergedOrder:number; mergeSha:string}
  | {type:'attempt_failed'; reason:string; runAfter?:number}        // counted: +1 attempt; → open, or → failed on the last
  | {type:'interrupted'; reason?:InterruptReason; runAfter?:number}  // uncounted: → open (no reason: uncounted error)
  | {type:'cancel'} | {type:'rewrite'; body:string};                // rewrite: failed → open, attemptCount 0, rev+1
function isReady(issue, issuesById: Map|Record<IssueId, IssueView>, now): boolean;   // open, not held, deps completed, runAfter<=now
function slotsFree(running:number, maxParallel:number): number;    // max(0, maxParallel - running)
// triggers.ts
function pendingTriggers(events: Event[], cursor: number,
  opts?: {productId?: ProductId; questions?: Map|Record<QuestionId, {target}>}): Event[];
//   seq > cursor, seq order; TRIGGER_TYPES = product.handed_off, prd.applied, issue.failed, question.answered.
//   An answer counts only for an orchestrator question; the target comes from a question.asked in
//   `events`, else from `opts.questions` (e.g. ClientState.questions); unknown target → not a trigger.
// budget.ts
// Price: USD per 1M tokens {input, output, cacheRead?, cacheWrite?, reasoning?} + webSearch? USD per call.
// Usage buckets are disjoint: input excludes cache read/write, output excludes reasoning.
// Missing cache price → input price; missing reasoning price → output price; searches without a price → unpriced.
function priceUsage(u: Usage, p: Price|undefined): {usd:number; unpriced:false} | {usd:null; unpriced:true};
function budgetLevel(spentUsd:number, budgetUsd:number|null): 'ok'|'warn'|'exhausted'; // inclusive at 80 % / 100 %; null → ok
function priceKey(ref: ModelRef): string;           // 'provider/model', the key of PriceOverrides (settings)
// scene.ts
// One scene per product: SceneState {productId, pieces[], workers[], debris[], totalIssues, issueIds}.
// Arrays are canonically ordered (pieces by placedAt = mergedOrder, the rest by id).
function emptyScene(productId): SceneState;
function sceneReduce(s: SceneState, e: Event): SceneState;   // ignores other products and unknown types
function sceneFromState(state: ClientState, productId): SceneState;  // tested: ≡ replaying the events
// SCENE_EVENTS / NO_OP_SCENE_EVENTS: every catalogued type is in exactly one (tested).
// Mapping: issue.created/cancelled (or status_changed→cancelled) → totalIssues; issue.completed → piece,
//   all pieces relaid out when totalIssues changes; issue.failed (or status_changed→failed) → debris,
//   removed on rewritten/cancelled/status_changed to anything else; agent.spawned → worker
//   (orchestrator=foreman, implementer=builder, reviewer=inspector, sparring=drafter at desk, utility=none);
//   agent.state working/waiting_owner/rate_limited → working / "?" bubble / bench; question.asked with
//   agentId → bubble until question.answered; agent.exited → worker removed. backend.limited is a
//   no-op: the server emits agent.state rate_limited per affected agent.
// scene-layout.ts (re-exported by scene.ts)
function layoutPiece(index:number, totalIssues:number): {type:PieceType; pos:[number,number,number]; rotY:number};
//   W×W footprint, storeys bottom-up (floor slab, then 4·W walls/windows), roof = index totalIssues-1.
```

Legal issue transitions:

| from | to | trigger |
|---|---|---|
| open | in_progress | scheduler starts an attempt |
| in_progress | in_review | checks passed |
| in_progress, in_review | open | attempt failed with attempts left, interrupted (pause/restart/rate limit/question/issue changed) |
| in_review | completed | merged to main |
| in_progress, in_review | failed | last counted attempt failed |
| open, failed, in_progress, in_review | cancelled | owner or orchestrator cancels. A running attempt finishes its step and its result is discarded. |
| failed | open | orchestrator rewrites the issue (attempt count resets) |

### 4.2 server/store
The only writer to SQLite.
```ts
interface Store {
  commit(build: (tx: Tx) => EventDraft[]): Event[];  // one sync txn: projection writes + event appends; redacts payloads; then bus.emit
  snapshot(): {state: ClientState; lastSeq: number};  // built from projection tables
  eventsSince(seq: number, limit?: number): Event[];
  subscribe(fn: (e: Event) => void): () => void;
  q: Queries;                                         // typed read helpers (issues, attempts, usage totals …)
}
```
```ts
interface Tx { q: Queries; db: Db }   // db: same connection, inside the transaction; write only tables without events (settings, secrets)
interface Queries { product(id); issuesByProduct(productId) /* by number */; issue(id); attemptsByIssue(issueId) /* by n */;
                    attempt(id); productUsage(productId); issueUsage(issueId); inboxItem(id); agent(id) /* or null */;
                    question(id) /* or null */; questionsByIssue(issueId) /* oldest first */;
                    sparMessages(productId) /* seq order */; prdDraft(productId) /* or null */;
                    prdVersionMarkdown(productId, version) /* or null */;
                    setting(key) /* raw JSON or undefined; callers validate */, backendLimit(backend) /* BackendLimit | null */ }   // ClientState shapes; usage zero when none
type CommitHook = (committed: readonly Event[], tx: Tx) => EventDraft[];  // derived drafts, same transaction
createStore({db, clock, redactor, hooks?: CommitHook[]}): Store;  // main passes hooks: [inboxHook({ids})]     // db from db/open(path) (':memory:' in tests; file created 0600; WAL pragmas; migrations applied)
```
Commit order: `build(tx)` → for each draft: zod-validate, redact every string in `data`, re-validate, insert (seq = AUTOINCREMENT, ts = `clock.now()` once per commit), then **project** (`store/project*.ts`, the server twin of `reduce`). Commands do not write projection tables themselves: the projector derives them from the events, so they cannot drift. A throwing builder, an invalid draft or a projection constraint failure (e.g. FK to a missing product) rolls the whole commit back and notifies nobody. Subscribers run after the commit; nested `commit` inside a builder throws. Usage totals are running sums in `usage_totals`, updated per event with the shared `addUsage` (never SQL `SUM()`).
Hooks run inside the transaction after the builder's drafts are appended and projected (so `tx.q` sees them); their drafts are appended next, in the same commit, and are not fed back into hooks. A throwing hook rolls back the whole commit.

**notify/** (`inboxHook`, `inboxFor`, `markInboxRead`, `inboxRoutes`): `inboxFor(event, lookup, {timeZone?}) → InboxDraft|null` is pure. Rules: `question.asked` → question (issue link, or product link for orchestrator questions); `issue.failed` → failed; `budget.warned` → budget_warn; `product.paused{budget}` → budget_paused; `backend.limited` → rate_limited ("Claude Code rate limited until 14:05") or auth_required when `needsLogin` (global, link null); `product.phase_changed{complete}` → complete. Links are `/products/:id` or `/products/:id/issues/:issueId`. `inboxHook({ids})` is the store hook that turns them into `inbox.created`. `markInboxRead(store, id)` emits `inbox.read` once (idempotent) or returns `{ok:false, code:'not_found'}`; `inboxRoutes({store})` serves `POST /api/inbox/:id/read` for the HTTP app to mount.

`pruneActivity(db, before): number` (store/prune.ts) deletes `agent.activity` events with `ts < before` except each agent's newest one (the only line projections keep), so pruning never breaks the invariant below. Recovery calls it at boot with a 7-day cutoff (ADR 5); it appends no event.

**Invariant (tested):** `events.reduce(reduce, emptyState)` equals `snapshot().state` after any command sequence. Tests call `expectSnapshotMatchesReplay(store)` from `store/testing.ts`.

### 4.3 server/http
These are thin routes. Each one validates with zod, calls a command, and returns `{ok}` or a typed error. `createApp({store, ids, git, redactor, access?, clientKey?, settings?, sparring?, previews?, logsDir?, artifactsDir?, withMergeLock?, webRoot?, heartbeatMs?})` gets the command dependencies from the composition root (`main.ts`).

```
GET  /api/state                         → {state, lastSeq}
GET  /api/events                        SSE; id=seq; replays seq > Last-Event-ID; ':hb' every 15s
GET  /api/agents/:id/log?follow=1       full redacted agent log as JSON lines {ts, line}; follow → SSE (see below); 404 unknown agent
GET  /api/attempts/:id/diff | /check    artifacts as redacted text/plain (see below); 404 unknown attempt or artifact not written yet
POST /api/products                      {name, idea}       → 201 {id}
POST /api/products/:id/spar             {message}           → 202; reply arrives as event
PUT  /api/products/:id/prd-draft        {markdown}
POST /api/products/:id/handoff | apply-prd | pause | resume
PATCH /api/products/:id/settings        {budgetUsd?, maxParallel?, maxAttempts?, models?, gitRemote?}
POST /api/products/:id/issues           {title, body, dependsOn[]}
PATCH /api/issues/:id                   {title?, body?, dependsOn?, rev}   (409 on stale rev)
POST /api/issues/:id/cancel
POST /api/questions/:id/answer          {text}   → question.answered (+ issue.released when it holds its issue); 404 unknown, 409 already answered
POST /api/inbox/:id/read
POST|DELETE /api/products/:id/preview   POST → {url} once GET / answers (409 no preview config / failed start); DELETE (409 none running)
GET|PUT /api/settings                   providers, keys (write-only, masked on read), role defaults, price overrides
POST /api/backends/:backend/clear       backend.cleared when a limit exists (Settings "I've logged in"); idempotent; unknown provider → 400
POST /api/settings/password             {current?, next}
POST /api/login {password} · POST /api/logout · GET /api/session
```

**Access control** (`http/auth.ts`, ADR 9; `createApp({..., access?, clientKey?})`). `installAccessControl` runs before every route, the SPA included:
- No password (or no `access` wired): a `Host` header that is not loopback → 403 `forbidden` (DNS rebinding).
- Every POST/PUT/PATCH/DELETE: a Content-Type other than `application/json` → 415 `unsupported_media_type`; an `Origin` (when present) whose host is not the request `Host` → 403 `forbidden`. The web client sends `Content-Type: application/json` on every mutation, bodyless ones included.
- Password set: every `/api` path except `/api/login` and `/api/session` (SSE included) needs a valid `vibecode_session` cookie → else 401 `unauthorized`.
- Routes (mounted when `access` is given; DTOs `LoginRequestSchema`, `PasswordChangeRequestSchema`, `SessionResponseSchema` in `shared/dto.ts`): `POST /api/login` sets the cookie (401 wrong password, 409 no password set, 429 `rate_limited` after 5 attempts per minute per `clientKey`, by default the socket's remote address). `POST /api/logout` clears it. `GET /api/session` → `{passwordSet, authenticated}` (authenticated is always true without a password). `POST /api/settings/password` `{current?, next}`: `next` 12–1024 chars, and `current` is required and checked (rate-limited) once a password is set (400 when missing or wrong). It answers with a fresh session cookie, because the change ends every other session.
- `commands/access.ts`: `createAccess({store, secrets, clock})` → `{hasPassword(), checkPassword(pw), login(pw, client), changePassword(input, client), resetPassword(next), sessions}`. The scrypt hash is the `passwordHash` row of `settings`, read on every call, so a password set by `npm run set-password` (`scripts/set-password.ts`, which uses `resetPassword` and needs no current password) applies to a running server. Setting it rotates the session key and commits `settings.changed{sections:['password'], keys:[]}`.
- Boot (`main.ts`): `assertBindAllowed(config.host, access.hasPassword())` runs before recovery and listen.

**Agent log** (`routes/agents.ts`, mounted when `AppDeps.logsDir` is given; `main.ts` passes `data/logs`): the agent must exist (`store.q.agent`), else 404. Every stored line is parsed (`{ts, line}`; malformed lines dropped) and `line` passes through `redactor.redact` again on the way out, so secrets registered after the line was written are masked too. Plain → `application/x-ndjson`, empty before the first line. `?follow=1` → SSE: one unnamed message per line (`data: {ts, line}`), existing lines first, then new complete lines (a line without its newline yet is held back), woken by the agent's events and a `logPollMs` poll (default 500 ms), `:hb` heartbeats; once the agent has exited and its log is fully sent, `event: end` and the stream closes.

**Attempt artifacts** (`routes/attempts.ts`, mounted when `AppDeps.artifactsDir` is given; `main.ts` passes `data/artifacts`, the same directory `runAttempt` writes to): the attempt must exist (`store.q.attempt`), else 404, so only known ids reach the file system. `/diff` → `<attemptId>/diff.patch`; `/check` → `check.log`, followed by `\n--- Check on the merge with main ---\n` and `integration-check.log` when the merge was re-checked. Both are `text/plain`, pass through `redactor.redact` again on the way out, and are 404 while the file does not exist.

**Questions** (`routes/questions.ts`, `commands/questions.ts`, flow 8): `answerQuestion({store, ids}, questionId, text)` → `{ok:true, events}` | `{ok:false, code:'not_found'|'conflict'}`. ONE commit: `question.answered{answer}`, plus `issue.released{questionId}` when the question's issue is still held by it (the scheduler then picks it up again; `implementerPrompt` lists the issue's answered questions as "Q: … / A: …"). An answered orchestrator question is an orchestrator trigger (`shared/triggers.ts`), and `orchestratorPrompt` shows it with its question text. The body is `AnswerQuestionRequestSchema` (`shared/dto.ts`: `text` trimmed, 1–8000 chars).

**Product settings** (`routes/product-settings.ts`, `commands/product-settings.ts`): `PATCH /api/products/:id/settings` takes `ProductSettingsUpdateRequestSchema` (`shared/dto.ts`, strict, at least one field): `budgetUsd` null or > 0, `maxParallel` and `maxAttempts` integers 1–10, `models` a partial `Record<Role, ModelRef|null>` (null = back to the global default; other roles keep their override), `gitRemote` `{url}`|null. `updateProductSettings({store, ids}, productId, input)` → `{ok; events}` | `{ok:false; code:'invalid'|'not_found'; reason}` commits one `product.settings_changed` with the given fields (`models` = the merged map). In the same commit the budget is re-checked against the new value: a warned product back under 80 % gets `budgetWarned:false` on the event (the next crossing warns again), and `budgetDrafts` adds `budget.warned` / `product.paused{budget}` when the new budget is already 80 % / 100 % spent. Invalid → 400, unknown product → 404, else `{ok:true}`.

**Settings** (DTOs in `shared/dto.ts`; `commands/settings.ts`, `createAccountSettings({store, db, secrets})` → `{read, view, update, modelDeps}`; mounted when `AppDeps.settings` is given):
- `GET /api/settings` → `{providers: [{id, name, enabled, needsKey, baseURL|null}], providerConfig, keys: [{provider, last4|null}], roleDefaults, defaultModel|null, priceOverrides}`. Keys never appear in full; `last4` is null for keys shorter than 16 chars.
- `PUT /api/settings` `{providerConfig?: ProviderConfig, keys?: {<provider>: string|null}, roleDefaults?, defaultModel?: ModelRef|null, priceOverrides?}` (strict; at least one field). Sections present replace the stored value; `keys` set (≥ 8 chars, no whitespace) or clear one provider's key under `API_KEY_SECRETS`; `defaultModel: null` deletes it. Invalid → 400. One commit writes the rows and emits `settings.changed{sections, keys:[{provider, set}]}` (never values). Responds `{ok:true, ...view}`.
- `settings` rows: `providerConfig`, `roleDefaults`, `defaultModel`, `priceOverrides` (`SETTING_KEYS`; `settings.read()` supplies the account defaults to the shared `resolveModel` and the overrides to `price`), plus `settingsChangedAt` (projection of `settings.changed`).
- `modelDeps()` → `ModelDeps` with `getSecret = secrets.get` and a `providerConfig` getter over the stored config: both are read when `model()` runs.

### 4.4 server/scheduler
```ts
createScheduler({store, clock, runners: {runOrchestrator(productId, triggers, run), runAttempt(issueId, run)},
  isBackendBlocked?(productId, role) /* default: backendBlockedByLimits(store, clock) */,
  orchestratorNotBefore?(productId): epochMs, ids?, timer?, tickMs? /* 2000 */, onError?}): Scheduler
interface Scheduler { start(): void; stop(): Promise<void>; kick(): void;
  shouldStop(runId): boolean; withMergeLock<T>(productId, fn: () => Promise<T>): Promise<T>;
  liveRuns(): ReadonlyMap<RunId, {abort: AbortController, productId, kind: 'orchestrator'|'attempt', issueId?}>; }
RunHandle = {runId, signal /* aborted on stop() */, shouldStop()}
```
Issue `priority` is an integer; higher is more urgent (urgent > high > normal > low), ties by lower number. Runners are called synchronously; a run that settles does not re-tick by itself (its end events or the 2 s timer do), so a run that ends without committing cannot hot-loop. The orchestrator counts against `maxParallel`. The default backend check resolves the role's backend from `settings.models[role].provider` and treats a `backendLimits` entry as active while it needs login, has no `until`, or `until` is in the future.
It ticks on every bus event and every 2 s. A product is skipped if it is not `building`, if it is paused, or if its budget is exhausted. For each remaining product it does three things. (1) If `pendingTriggers` is non-empty and no orchestrator run is live, it starts one. (2) While running agents (orchestrator plus attempts) is below `maxParallel`, it starts `runAttempt` for the next ready issue, ordered by priority and then number. (3) It skips roles whose backend is rate-limited or needs login. Before that, a `building` product (paused or not) with no live runs, no pending triggers and at least one issue, every non-cancelled one `completed`, gets `product.phase_changed{complete}` (`scheduler/completion.ts`, re-checked inside the commit so it fires once; the inbox hook adds the `complete` item). Every store event wakes the tick, so an owner `issue.cancelled` of the last unfinished issue completes the product at once; a merge whose run is still live completes on the next timer tick. Live runs are kept in an in-memory `Map<runId, {abort, productId}>`. `shouldStop(runId)` returns true when the product is paused, the budget is exhausted, or the server is shutting down. It also owns `withMergeLock(productId, fn)`, a per-product async mutex.

### 4.5 server/pipeline
```ts
sparTurn(productId, ownerMessage): Promise<void>
runOrchestrator(productId, triggers: Event[], run: RunHandle): Promise<void>   // from createOrchestrator(deps), see below
runAttempt(deps: AttemptDeps, issueId, run: RunHandle): Promise<void>   // pipeline/attempt.ts, see below
// zod result schemas, enforced by the agent's `finish` tool or --json-schema:
SparResult   {reply, prdMarkdown?}
PlanResult   {issueOps: IssueOp[], questions: string[], summary, project?: ProjectConfig}
IssueOp      {op:'create', key, title, body, dependsOn:(key|id)[], priority?}
           | {op:'edit', id, title?, body?, dependsOn?} | {op:'cancel', id, reason}
           | {op:'rewrite', id, body}                  // failed → open, attempts reset
ImplResult   {summary, question?}
ReviewResult {approve: boolean, findings: string[]}
```
`server/commands` applies a plan (`commands/index.ts`):
```ts
type CommandDeps = {store: Store; ids: IdGen};
applyPlan(deps, productId, plan: PlanResult, consumedSeq, opts?: {project?: ProjectConfig; replan?: {version; summary}})
  : {ok:true; events; createdIds: Record<key, IssueId>} | {ok:false; reason};
// Ops are checked in order against a working copy of the product's issues: create keys unique (and not an
// existing id); dependsOn = plan keys or existing issue ids of the product; edit only open/failed (rev+1);
// cancel/rewrite via transition(); then no cycle across all issues. Invalid → nothing committed, cursor unchanged.
// Valid → ONE commit: issue.created (next per-product numbers, origin orchestrator, product prdVersion, priority ?? 0),
// issue.edited, issue.cancelled{by:'orchestrator'}, issue.rewritten, question.asked{target:'orchestrator'},
// product.phase_changed{building} when the product is complete and the plan creates or rewrites an issue
// (a cancel-only plan leaves it complete),
// orchestrator.cursor_advanced{cursor: consumedSeq} (refused if consumedSeq < current cursor).
// opts.project → product.settings_changed{project}; opts.replan → prd.summarized{version, summary} (stored on
// prd_versions) + inbox.created{kind:'replan', body: summary, link /products/:id}; all in the same commit (a refused plan commits neither; an invalid project is refused).
nextIssueNumber(issues); resolveDependsOn(refs, {keys, existingIds, cancelledIds}); findDependencyCycle(graph) → [a,…,a] | null
// resolveDependsOn refuses unknown refs and refs to cancelled issues (applyPlan passes its working copy,
// so cancel X then create Y ← X in one plan fails). Owner commands (flow 7), {ok:false; reason; code} on failure:
addIssue(deps, productId, {title, body, dependsOn, priority?}) → {ok; events; issueId; number}
//   origin owner, next number, prdVersion; a complete product → product.phase_changed{building} in the same commit
editIssue(deps, issueId, {title?, body?, dependsOn?, rev}) → {ok; events; rev}
//   open|failed|in_progress|in_review only (else conflict); rev ≠ current → conflict; rev+1; no cycles
cancelIssue(deps, issueId) → {ok; events}   // via transition(); completed/cancelled → conflict; by:'owner'
// codes: invalid → 400, not_found → 404, conflict → 409
createSparring({store, ids, sparTurn: SparTurnRunner, onError}): Sparring;   // flow 1, any phase
//   sendSparMessage(productId, {message}) → {ok; events; done} | 400/404/409: commits spar.message{owner}
//   and starts sparTurn; one turn per product (in-memory), a second while running → conflict (409).
//   isTurnRunning(productId); idle(). A throwing turn goes to onError and frees the product.
savePrdDraft(deps, productId, {markdown}) → {ok; events}   // prd.draft_saved{baseVersion: product.prdVersion}
handoff({store, ids, git}, productId): Promise<{ok; events}>   // flow 2; phase ≠ sparring or blank draft → conflict
//   git.commitFilesOnMain({docs/PRD.md: draft}) unless main already has exactly that text (a retry after a failed
//   store commit), then ONE commit: prd.applied{version 1, summary null}, product.handed_off{prdVersion 1},
//   product.phase_changed{building}; phase and draft are re-checked inside the commit. One handoff per product
//   at a time (in-memory) → conflict.
applyPrd({store, ids, git, withMergeLock?}, productId): Promise<{ok; version; events}>   // flow 6
//   phase ∉ {building, complete}, blank draft, or draft == latest version's markdown → conflict. Under withMergeLock:
//   git.commitFilesOnMain({docs/PRD.md: draft}) unless main already has that text, then ONE commit:
//   prd.applied{version N+1, summary null} (a trigger) + product.phase_changed{building} when complete; re-checked
//   inside the commit; one apply per product at a time (in-memory) → conflict. Spec tab: ApplyChangesPanel
//   ('Unapplied changes since vN' via hasUnappliedChanges(draft, versions), confirm dialog, version history).
// SparRequestSchema / SavePrdDraftRequestSchema in shared/dto.ts. Spar message ids: nextSparMessageId(deps).
pauseProduct({store, ids}, productId) → {ok; events}    // flow 5; product.paused{owner}; already paused → conflict
resumeProduct({store, ids}, productId) → {ok; events}   // product.resumed; not paused, or budget still exhausted → conflict
//   ('Budget exhausted: raise the budget in Settings')
checkBudget({store, ids}, productId) → {ok:true; level; spentUsd; unpriced; events} | {ok:false; code:'not_found'}
//   commands/budget.ts. API spend only (subscription never counts; unpriced usage is not counted, `unpriced` flags it).
//   >= 80 % and !budgetWarned → budget.warned{spentUsd, budgetUsd}; >= 100 % and not paused → product.paused{budget}.
//   budgetAfterUsage({store, ids}) is the agent-run afterUsage hook (wired in main.ts for every RecordedRunContext).
//   POST /api/products/:id/pause | resume → 200 {ok:true}. The scheduler reacts through the store bus.
createProduct({store, ids, git}, {name, idea}): Promise<{ok:true; id: ProductId} | {ok:false; reason}>;
// CreateProductRequestSchema (shared/dto.ts): trimmed name 1–80, idea 1–4000. git.initRepo(id) runs first,
// then ONE commit: product.created with DEFAULT_PRODUCT_SETTINGS (budget null, maxParallel 3, maxAttempts 3,
// models {}, gitRemote null); a failed initRepo throws and commits nothing.
```

The result schemas above are defined in `src/shared/agent-results.ts`. The pipeline imports them from there and does not redefine them.

Prompts live in `src/server/pipeline/prompts/<role>.md`. They are plain markdown templates with `{{var}}` substitution.

Pipeline helpers every agent run uses (`pipeline/index.ts`):
```ts
renderPrompt(name, vars: Record<string,string>, {dir?}): string  // prompts/<name>.md; single-pass {{var}} (values never re-expanded); missing var → throw
resolveModel(store, productId, role, {demo?}): {ok:true; model} | {ok:false; reason:'Choose a model in Settings'}
  // product.models[role] → settings roleDefaults[role] → settings defaultModel → {provider:'fake', model:'fake'} in demo mode
SETTING_KEYS = {roleDefaults, defaultModel, priceOverrides}; readRoleDefaults/readDefaultModel/readPriceOverrides(store)  // zod-validated; malformed → throw
runRecordedAgent<T>(ctx: {store, ids, clock, redactor, logsDir, setTimer?, afterUsage?: (e: usage.recorded) => void},
                    spec: Omit<AgentSpec<T>, 'agentId'|'clock'|'onActivity'|'onUsage'> & {productId, issueId?, attemptId?, waitsForOwner?: (result: T) => boolean})
  : Promise<{agentId; result: AgentResult<T>}>
sparTurn(deps: RecordedRunContext & {modelDeps, demo?, shouldStop?}, productId, ownerMessage): Promise<void>
  // runRecordedAgent(role sparring, SparResultSchema, tools [], no sandbox, SPAR_LIMITS) with prompts/sparring.md
  // (vars idea, transcript without the latest owner message, draft); prompt = ownerMessage. ok → ONE commit:
  // spar.message{agent, reply} + prd.draft_saved{prdMarkdown, baseVersion: prdVersion} when present.
  // No model / error / rate_limited / auth_required / stopped / thrown → spar.message{agent, actionable text}
  // + inbox.created{kind:'error', link /products/:id}.
usageCost(model, stepUsage, priceOverrides): billing/tokens/webSearches/calls/costUsd/unpriced/estCostUsd/source
```
- `runRecordedAgent` commits `agent.spawned`, appends every activity line to `logs/<agentId>.ndjson` (`{ts, line}`, redacted, file 0600) and ends it with `exited <outcome>[: message]`, emits `agent.activity` through `ActivityBatcher` (≤ 1 per 250 ms of `clock` time, last 5 held lines; a timer flushes held lines when the window ends; lines still held at exit stay in the log only), commits one `usage.recorded` per step (entity id from `IdGen` kind `usage`) then calls `afterUsage`, commits `agent.state{rate_limited, until}` on a rate-limited result and `agent.state{waiting_owner}` on an ok result that `waitsForOwner` (an implementer question), and always commits `agent.exited` in `finally` (outcome = result kind, or `error` when the run throws).
- A throwing recording callback (store, log file, `afterUsage`) stops the agent via `shouldStop` and is rethrown after the run; it is never turned into a model error.
- Orchestrator (`pipeline/orchestrator.ts`, flow 3): `createOrchestrator({...RecordedRunContext, git, runtime, modelDeps, withMergeLock, demo?, limits?, backoff?}) → {runOrchestrator, orchestratorNotBefore}`; the composition root passes `runOrchestrator` to the scheduler's runners and `orchestratorNotBefore` as its backoff hook. A run: worktree of main (branch `vibecode/<runId>`) → `ensureImage` → warm sandbox (`egress`) → `runRecordedAgent(role orchestrator, all tools, webSearch = capabilities(model).webSearch, schema PlanResult)` with `prompts/orchestrator.md` (PRD, every issue incl. completed/cancelled with status and last feedback, on replans `prompts/orchestrator-replan.md` with the previous (`q.prdVersionMarkdown`) and new PRD version and the replan rules (create, edit/cancel open issues, follow-ups for merged work, never revert), issues depending on cancelled ones, triggers, repository contract, sizing rules, a note when search is unavailable) → `commitAll` → reject changed paths outside `Dockerfile`, `.dockerignore`, `.vibecode/**`, `docs/**` (`git.changedPaths`) → validate `.vibecode/project.json` (ProjectConfig; the file is the source of truth, `PlanResult.project` is not used) → `ensureImage` on the new Dockerfile → under `withMergeLock`: `integrate` + `advanceMain`, then `applyPlan(…, max trigger seq, {project if changed, replan: {version: newest consumed `prd.applied` version, summary} when that version > 1})`. `finally` closes the sandbox and removes the worktree. A `stopped` agent is not a failure. Any other failure leaves the cursor alone; retries back off 30 s, 2 min (in memory, `OrchestratorBackoff`); the 3rd consecutive failure commits `inbox.created{kind:'error'}` and `orchestratorNotBefore` returns `Infinity` until a trigger newer than the failed run's arrives.
- Composition (`main.ts`): `start(config, webRoot?, {fakeScript?, clock?, schedulerTickMs?, …test hooks})` → `{address, store, app, close}`. Runtime: `selectRuntime(config, {script?})` (FakeContainerRuntime with `VIBECODE_FAKE_DOCKER=1`, else `DockerCliRuntime`, whose calls reject with `Docker is not running: …` when the CLI or daemon is missing). Sparring, orchestrator and `runAttempt` (`artifactsDir = <dataDir>/artifacts`, the scheduler's `withMergeLock`) read `modelDeps` from `settings.modelDeps()` on every run. `close()` stops the scheduler first, waits for sparring, then closes HTTP and the DB; `closeOnSignals(running)` calls it once on SIGINT/SIGTERM and exits. Demo mode (`demo/`): `demoFake(store)` is `ModelDeps.fake`; its `script`/`vars` getters are read when the registry builds the model (right after `agent.spawned`) and answer by the latest spawned agent's role: sparring asks two questions then returns a PRD draft; the orchestrator writes `.vibecode/project.json` (check `DEMO_CHECK = test -f docs/PRD.md`, answered with exit 0 by `DEMO_RUNTIME_SCRIPT` in the fake runtime) and plans 3 chained issues; the implementer writes `src/issue-<n>.md`; the reviewer approves. Integration test: `src/server/demo/pipeline.test.ts`.
- Attempt (`pipeline/attempt.ts`, flow 4 success path): `runAttempt({...RecordedRunContext, git, runtime, modelDeps, withMergeLock, artifactsDir, demo?, limits?: {implementer?, reviewer?}, checkTimeoutMs?}, issueId, run)`. Worktree `data/worktrees/<attemptId>` on branch `vibecode/<attemptId>` → ONE commit `issue.status_changed{→in_progress}` + `attempt.started{n, issueRev, baseSha, branch}` (skipped silently when `transition(start)` is illegal) → `product.project.check` required, else error `No check command configured (.vibecode/project.json)` → `attempt.step` implement: `ensureImage`, warm sandbox (`egress`, rw), implementer (all tools, `ImplResult`, `prompts/implementer.md`: issue, PRD, AGENTS.md if present, latest ended attempt's feedback, the issue's answered questions (Q&A), check command; `implementer-task.md`) → host `commitAll('#<n> <title>')` (empty → error `no changes`), `artifacts/<attemptId>/diff.patch` → `attempt.step` check: `runOnce(check, role check, network none)`, output → `check.log`, `cleanWorktree` → ONE commit `status_changed{→in_review}` + `attempt.step` review: fresh reviewer in its own sandbox (read-only, network none, tools read_file/list_dir/grep/run, `ReviewResult`, `prompts/reviewer.md` with issue, check output (last 200 lines), diff) → `attempt.step` merge, under `withMergeLock`: re-read issue (cancelled → `attempt.ended{discarded}`, issue untouched; title, body or dependsOn differ from the issue recorded at `attempt.started` → `interrupted{issue_changed}`, so a priority-only edit still merges; not in_review → error), `integrate`; `fast` → `advanceMain`; `merged` → check again on the integration worktree (`integration-check.log`), remove it, then `advanceMain` → ONE commit `issue.completed{attemptId, mergedOrder = max+1, mergeSha}` + `attempt.ended{merged}`. Counted failures (`failAttempt` in `attempt-events.ts`, ONE commit): `attempt.ended{status, counted:true, feedback}` with status `check_failed` (feedback: the check command, exit code and the last 200 lines of output; also for the re-check on the integration worktree), `rejected` (the findings; `review` stored), `conflict` (the conflicting paths), `error` for an empty diff (`no changes: …`) and for an agent `error` result (implementer or reviewer), plus `transition(attempt_failed, {maxAttempts: product.settings.maxAttempts})`: while attempts remain `issue.status_changed{→open, attemptCount}`, else `issue.failed{from, attemptCount, reason = feedback}` (an orchestrator trigger; its rewrite op resets attemptCount to 0). The next attempt's implementer prompt carries the latest ended attempt's feedback. Interruptions (flow 5, ADR 7; `interruptAttempt`, ONE commit): `attempt.ended{status:'interrupted', counted:false, interruptReason, feedback}` + the `interrupted` transition back to `open`. The agents' `shouldStop` is `run.shouldStop() || issue cancelled`, and it is checked again between steps (after the implementer, the check and the review), so a run stops after its current step. A stop (agent `stopped`, or a check/re-check aborted through `run.signal`) is `discarded` when the issue was cancelled, else interrupted with reason `budget` (budget exhausted), `paused` (product paused) or `shutdown` (scheduler stop). Agent `rate_limited` → reason `rate_limited`, `runAfter = until`, plus `backend.limited{backend, until, needsLogin:false}`; `auth_required` → reason `auth_required`, `runAfter = now + 60 s`, plus `backend.limited{until:null, needsLogin:true}`. `backend.limited` is committed only when it changes the projected limit (`store.q.backendLimit`: none, or a different until/needsLogin), so parallel attempts hitting one limit produce one event and one inbox item. An implementer question (`ImplResult.question`, flow 4.3; the implementer's run commits `agent.state{waiting_owner}` before it exits) is an interruption too, ONE commit: `attempt.ended{interrupted, interruptReason:'question', counted:false}` + the `interrupted` transition back to `open` + `question.asked{target:'issue', issueId, agentId, text}` + `issue.held{questionId}`, so `isReady` skips the issue until the answer releases it (a cancelled issue's question is discarded instead). Everything else (missing check command, model not configured, thrown error) is `attempt.ended{status:'error', counted:false, feedback}` plus the uncounted transition back to `open` with `runAfter = now + ERROR_RETRY_DELAY_MS` (60 s). `finally` closes sandboxes and removes the worktree and branch. A role resolved to `claude-code` (implementer, reviewer, and likewise the orchestrator) gets `ensureImage({…, claude: true})` and `SandboxSpec.claude`; its sandbox always uses `egress` (the CLI must reach Anthropic), so a Claude reviewer keeps its read-only mount but not network none. Commit helpers are in `attempt-events.ts`, prompts in `attempt-prompt.ts`; `readRepoFile` (`repo-file.ts`) is shared with the orchestrator.
- Usage: billing `api` uses OpenRouter's reported cost (`source:'provider'`) when present, else `priceUsage(price(model, overrides))` (`computed`; unknown → `unpriced`, costUsd null). Billing `subscription` (`capabilities(ref).subscription`, i.e. claude-code): `costUsd` null, `estCostUsd` = `StepUsage.reportedEstCostUsd` (the CLI's `total_cost_usd`) when present, else the same computation as an estimate (null when unknown), `source:'cli'`. `calls` = `StepUsage.calls` (default 1 per step).

### 4.6 server/agents
```ts
runAgent<T>(spec: {
  agentId: string; role: Role; model: ModelRef;  // ModelRef = {provider, model}; provider 'claude-code' selects the CLI backend
  instructions: string; prompt: string; schema: ZodType<T>;
  sandbox?: Sandbox; tools: ToolName[]; webSearch?: boolean;
  limits: {maxSteps: number; wallClockMs: number; stepTimeoutMs?: number /* default 10 min */};
  shouldStop: () => boolean;
  modelDeps: ModelDeps; clock: Clock;            // llm model() deps (secrets, provider config, fake script)
  onActivity?: (line: string) => void;           // redacted lines: tool calls, tool errors, assistant text
  onUsage?: (u: StepUsage) => void;              // per step: Usage buckets + step + providerMetadata (+ calls?, reportedEstCostUsd? for claude-code)
}): Promise<
  | {kind:'ok'; result:T} | {kind:'stopped'} | {kind:'rate_limited'; until:number; backend:string}
  | {kind:'auth_required'; backend:string} | {kind:'error'; message:string; transient:boolean}>
```
- **ApiBackend.** This is our own step loop over AI SDK `streamText` with tools. The tools are `read_file, write_file, edit_file, list_dir, grep, run`, plus a `finish` tool whose input schema is `schema`. It checks `shouldStop()` between steps. Every tool executes through `sandbox.exec`. The loop runs on the host, so keys never enter a container. Tool output is truncated in the middle to 30k characters. Web search, when enabled, is the provider-native tool from `llm/capabilities.ts`.
  - Implemented in `agents/api-backend.ts` (the only agents file that imports `ai`). Each step is one `streamText` call with `maxRetries: 0` and an `abortSignal` that fires on `wallClockMs` (→ error, non-transient) or `stepTimeoutMs` (→ error, transient); the wall clock is also checked between steps. `maxSteps` without a valid `finish` → error. Invalid `finish` input goes back to the model as a tool error.
  - Errors: 429 → `rate_limited` (`until` from `retry-after`, else now + 60 s; `backend` = provider); 401/403 → non-transient error pointing to Settings; 5xx/network → transient error; `MissingProviderSetupError` → non-transient error with its message.
  - `webSearches` per step = max(provider-executed `web_search` tool results, Anthropic `usage.server_tool_use.web_search_requests`). Web search is added only when `spec.webSearch` and `capabilities(ref).webSearch` (OpenRouter via `ModelDeps.webSearch`).
- **ClaudeCodeBackend.** It runs `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools <role list> --permission-prompts none --strict-mcp-config --max-turns N --json-schema <schema> --model <m>` through `sandbox.exec`. The prompt goes on stdin. The environment has `CLAUDE_CONFIG_DIR=/home/agent/.claude` and `DISABLE_AUTOUPDATER=1`, and `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are never set. `--bare` is never used. The backend parses the NDJSON output:
  - `rate_limit_event.status=="rejected"` + `resetsAt` becomes `rate_limited`. If those are missing, it falls back to `api_retry.error=="rate_limit"` or to parsing the "resets …" text.
  - `authentication_failed` or "Login expired" becomes `auth_required`.
  - `result.modelUsage` becomes usage rows (billing `subscription`). `costUSD` is stored as an estimate only.
  - To stop, it sends SIGINT.
  - Implemented in `agents/claude-code-backend.ts` (`buildClaudeArgv(spec) → {argv, env}`, pure; `claudeExecArgv` wraps it as `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN CLAUDE_CONFIG_DIR=… DISABLE_AUTOUPDATER=1 claude …` and throws on `--bare` or any `ANTHROPIC_*` env) and `agents/claude-stream.ts` (pure NDJSON parser). `--allowedTools`: implementer `Read,Edit,Write,Glob,Grep,Bash`; orchestrator the same plus `WebSearch,WebFetch`; reviewer (and sparring/utility) `Read,Glob,Grep`. `--max-turns` = `limits.maxSteps`, `--json-schema` = `z.toJSONSchema(schema)`; stdin = instructions + prompt. Exec: `timeoutMs = wallClockMs` (timeout → non-transient error), `killSignal:'SIGINT'`; `shouldStop()` is checked before start, on every output line and every 250 ms (→ abort → `stopped`).
  - Outcome: a non-error `result` (subtype `success`) whose `structured_output` passes `schema` → ok (fails → non-transient error). Otherwise, in order: rejected `rate_limit_event` → `rate_limited` (`resetsAt` < 1e12 is read as epoch seconds, else ms); `authentication_failed` (api_retry/assistant `error`), `api_error_status` 401 or "Login expired" (result, assistant text or stderr) → `auth_required`; `rate_limit` errors, 429 or a "resets 3:45pm" / "resets Mon 12:00am" text (next occurrence in server local time) → `rate_limited` (no time → now + 15 min); no result → transient error with the stderr tail; other results → error, transient only for `api_error_status` ≥ 500. `backend` is `'claude-code'`.
  - Usage: one `StepUsage` per run from `result.modelUsage` summed over models (fallback `result.usage`): `output` excludes `thinkingTokens` (→ `reasoning`), `calls` = `num_turns`, `reportedEstCostUsd` = `total_cost_usd` (else Σ `costUSD`). Reported also for error and stopped runs that produced a result.
  - Fixtures: `agents/fixtures/{success,rate-limited,rate-limited-text,login-expired,error}.ndjson`, authored from the docs (not yet recorded from the real CLI).
- Both backends stream activity lines to `logs/<agentId>.ndjson` and emit batched `agent.activity` events, at most one every 250 ms, carrying the last few lines.

### 4.7 server/llm
```ts
model(ref: ModelRef, deps: ModelDeps): LanguageModel;
  // deps = {getSecret(key), providerConfig?: {openaiCompatible?: {baseURL}, openrouter?: {baseURL}},
  //         webSearch?: boolean /* openrouter → `<model>:online` */, fake?: {script, vars?}, fetch?}
  // keys (API_KEY_SECRETS: 'llm.<provider>.apiKey') are read via getSecret on every model() call, never cached
  // missing key / base URL / fake script → throws MissingProviderSetupError ('Add an Anthropic API key in Settings')
  // claude-code → throws (it runs through ClaudeCodeBackend)
capabilities(ref): {tools:boolean; webSearch:boolean; subscription:boolean};  // claude-code: subscription, CLI WebSearch
webSearchTool(ref): Tool | undefined;              // anthropic webSearch_20260318 | openai webSearch | google googleSearch | none (openrouter searches via :online)
WEB_SEARCH_TOOL_NAME = 'web_search';                // suggested ToolSet key
price(ref, overrides?): Price | undefined;          // overrides → fake/openai-compatible (ollama) = 0 → prices.json (models.dev snapshot); anthropic web search $10/1k
providerReportedCost(metadata: unknown): number | undefined; // providerMetadata.openrouter.usage.cost
PRICE_TABLE: {source, fetchedAt, providers};         // prices.json, regenerated by scripts/update-prices.mjs
fakeModel(script: FakeScript, {vars?, onCall?(prompt)}): LanguageModel;  // MockLanguageModelV4 from `ai/test` (ai 7.0.x); onCall sees each call's prompt (tests)
```
Unknown models are `unpriced` and are never counted as $0. If OpenRouter's `usage.cost` is present in provider metadata, it is used instead of our computed cost. OpenRouter goes through `@ai-sdk/openai-compatible` with `usage: {include: true}` in the request body and a metadata extractor that copies `usage.cost` (generate and stream).

A `FakeScript` is JSON: a list of turns, one per model call (doGenerate or doStream):
`{text?, toolCalls?: [{name, input}], usage?: {input, output, cacheRead, cacheWrite, reasoning}, error?: {status: 429, retryAfterSeconds?} | {status: 401 | 403 | 503}, webSearches?: [{query}], hang?: true}`.
`webSearches` streams provider-executed `web_search` tool calls and results; `hang` never answers until the call's abortSignal fires.
`{{path}}` placeholders in `text` and in string values of tool `input` are filled from `vars` (an unknown variable throws). An `error` turn throws an `APICallError` (429 and 503 are retryable, 429 with a `retry-after` header; 401 and 403 are not). An exhausted script throws.

Only `src/server/llm` and `src/server/agents/api-backend.ts` may import `ai` or `@ai-sdk/*` (ESLint enforces this).

### 4.8 server/sandbox
```ts
interface ContainerRuntime {
  available(): Promise<boolean>;
  ensureImage(p: {productId: string; contextDir: string; claude?: boolean}): Promise<string>; // tag = vibecode/p-<id>:<sha256(Dockerfile+imageInputs)>, or vibecode/base;
                                                      // claude: derived Claude Code image FROM it (vibecode/claude-code over the base, else vibecode/p-<id>-claude:<sha256(product tag + claude-code.Dockerfile)>)
  open(spec: SandboxSpec): Promise<Sandbox>;          // warm container: `sleep infinity`
  runOnce(spec: SandboxSpec, argv: string[], o: ExecOpts): Promise<ExecResult>;  // checks
  runDetached(spec: SandboxSpec, argv: string[]): Promise<{name: string}>;  // previews: `docker run --detach` running argv, spec.publishPort published on 127.0.0.1 only
  publishedPort(name: string, port: number): Promise<number>;  // the 127.0.0.1 host port docker picked for container `port` (`docker port`)
  listManaged(): Promise<{name: string; labels: Record<string,string>}[]>;
  remove(name: string): Promise<void>;
}
interface Sandbox { name: string; exec(argv: string[], o: ExecOpts): Promise<ExecResult>; close(): Promise<void>; }
type SandboxSpec = {runId; productId; role:'agent'|'check'|'preview'; image; worktree: string; readOnly: boolean;
                    network:'none'|'egress'|'preview'; claude?: boolean; publishPort?: number};
type ExecOpts = {stdin?; timeoutMs; signal?: AbortSignal; killSignal?: 'SIGINT'|'SIGTERM' /* delivered to the process inside the container on abort */;
                 onLine?(line, stream)};
function buildRunArgs(spec: SandboxSpec, host: {uid:number; gid:number; dataDir:string}): string[];  // pure, unit-tested
```
`buildRunArgs` always emits these flags:
- `--init`, `--user uid:gid`, `--cap-drop ALL`, `--security-opt no-new-privileges:true` and `--read-only`
- `--tmpfs /tmp` and `--tmpfs /home/agent` (with size limits)
- `--memory 4g --memory-swap 4g --cpus 2 --pids-limit 512`
- `--restart no`, `--label vibecode.managed=1` plus `vibecode.product`, `vibecode.run` and `vibecode.role`, and `--name vibecode-<runId>`
- exactly one bind: the worktree at `/workspace` (`:ro` for reviewers and previews), with `data/empty` mounted read-only over `/workspace/.git`
- the named volume `vibecode-claude-config` at `/home/agent/.claude`, but only when `claude` is set

`DockerCliRuntime` (`sandbox/docker-cli.ts`, selected when `VIBECODE_FAKE_DOCKER` is unset) calls the docker CLI only through `util/exec`. `open` runs `docker run --detach … sleep infinity`; `Sandbox.exec` runs `docker exec -i -w /workspace` (stdin, timeout, abort → SIGINT, `onLine` streaming); `runOnce` runs `docker run --rm -i` and force-removes the container after a timeout or abort; `runDetached` runs `docker run --detach <buildRunArgs> <argv>` (same confinement and network setup as `open`; previews publish `127.0.0.1::<port>`); `listManaged` filters on `label=vibecode.managed=1`; `remove` is `rm --force` (a missing container is fine). `publishedPort(name, port)` parses `docker port <name> <port>/tcp`. It also has `ensureNetworks()` (creates `vibecode-egress` with `com.docker.network.bridge.enable_icc=false` and `vibecode-preview`; called before any container joins one).  `ensureImage` tags `vibecode/p-<lowercased id>:<sha256 of the Dockerfile plus each imageInputs path and content>`, reuses an existing image and otherwise runs `docker buildx build --load`. Without a Dockerfile it uses `vibecode/base`, built on first use from `docker/base.Dockerfile` (or `npm run docker:base`). Before `buildRunArgs`, `open`/`runOnce` resolve the worktree with `realpath` and refuse it unless it lies inside `realpath(<dataDir>/worktrees)` (Docker follows symlinks in bind sources), and they create `<dataDir>/empty` as an empty regular file. A missing CLI or stopped daemon becomes `Docker is not running: start Docker Desktop or the docker service`.
- **Claude image (ADR 4).** `ensureImage({…, claude: true})` first ensures the product image, then builds `docker/claude-code.Dockerfile` with `--build-arg BASE_IMAGE=<product image>`: the pinned `@anthropic-ai/claude-code` with its own Node, `CLAUDE_CONFIG_DIR=/home/agent/.claude`, `DISABLE_AUTOUPDATER=1`, user 1000. Over `vibecode/base` the result is `vibecode/claude-code` (the login image; `npm run docker:claude-code`).
- **Stop signals in the container.** A signal to the host `docker exec` client is not forwarded into the container (no TTY). An exec with `killSignal` therefore runs `sh -c 'echo $$ > "$1"; shift; exec "$@"' sh /tmp/vibecode-exec-<uuid>.pid <argv>`; on abort a second `docker exec <c> sh -c 'kill -s "$1" "$(cat "$2")"' sh INT <pidfile>` delivers the signal to the process, and after `killGraceMs` (default 5 s) the same with `KILL` plus SIGKILL to the client. Execs without `killSignal` are unchanged (abort → SIGINT to the client).

It throws if a mount source contains `docker.sock` or is outside `data/worktrees`. The `none` network gets no networking. `egress` is the `vibecode-egress` bridge with ICC disabled. `preview` is the `vibecode-preview` bridge, and its port is published as `127.0.0.1::<port>`. `FakeContainerRuntime` runs nothing; `runArgs(name)` returns the `buildRunArgs` output of a container it started (for assertions). It applies `write_file`/`read_file` to the worktree directly (with path confinement) and answers `run` from a script.

Preview (`preview.ts`): `createPreviews({store, ids, clock, git, runtime, redactor, dataDir, fetch?, sleep?, log?}) → {startPreview(productId) → {ok, url} | {ok:false, code, reason}; stopPreview(productId); stopAll()}`. Start: 404 unknown product, 409 without `project.preview`; stops the running preview first (one per product), then a detached worktree of main (`data/worktrees/<runId>`), `ensureImage`, `runDetached` with role `preview`, read-only mount, network `preview`, `publishPort: project.preview.port` and argv `project.preview.command`. The URL is `http://127.0.0.1:<runtime.publishedPort(container, project.preview.port)>/`; it polls that URL with `GET` (any status < 500) every 500 ms for up to 60 s (injected fetch, clock and sleep), then commits `preview.started{url, container}`. A timeout or start failure removes the container (`vibecode-<runId>`, even if `run` failed) and worktree and returns a 409 with an actionable reason; a failed `remove` there is logged as a redacted warning via `log` (default `console.warn`), not swallowed. Stop removes container and worktree and commits `preview.stopped` (409 when none runs); a preview known only from the store (after a restart) is found via its container name. Start and stop of one product are serialised. `main.ts` calls `stopAll()` on shutdown: it waits for queued and in-flight (polling) starts of every product, then stops every preview this process started, logging removal failures; starts requested after it began get a 409. `FakeContainerRuntime.runDetached` serves a small HTML page on an ephemeral 127.0.0.1 port (demo mode) until `remove`; its `publishedPort` returns that port.

### 4.9 server/git
All git commands run on the host with `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.file.allow=never` (`GIT_SAFETY_FLAGS`, always first in argv), a timeout, `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_NOSYSTEM=1`, inherited `GIT_DIR`-style variables removed, and the fixed `AGENT_IDENTITY` as author and committer. Product repositories are bare: `data/repos/<productId>.git`. Product and run ids must be safe path segments (`[A-Za-z0-9][A-Za-z0-9_-]*`); repo paths must be relative, normalised and outside `.git`.
```ts
gitVersionOk(deps?): Promise<boolean>                      // host git >= 2.38
createGit({dataDir, exec?, timeoutMs?}): Git               // exec injectable so tests can observe argv
initRepo(productId): Promise<void>                         // bare repo + initial commit (README, docs/PRD.md); no-op if main exists
addWorktree(productId, runId, ref='main', {detached?}): Promise<{dir; branch: string|null; baseSha}>
                                                           // dir = data/worktrees/<runId>, branch = vibecode/<runId> (null when detached)
commitAll(dir, message): Promise<{sha:string|null; diff:string}>   // null when nothing changed
changedPaths(dir, fromRef): Promise<string[]>                       // diff --name-only -z --no-renames fromRef..HEAD, sorted
cleanWorktree(dir): Promise<void>                          // reset --hard + clean -ffdx (after checks)
mainSha(productId): Promise<string>; readFileAtMain(productId, path): Promise<string|null>
integrate(productId, branch, baseSha, message): Promise<
  | {kind:'fast'; tree; commitSha}                         // main == baseSha
  | {kind:'merged'; commitSha; dir}                        // merge-tree clean; dir = integration worktree to re-check
  | {kind:'conflict'; paths:string[]}>
advanceMain(productId, commitSha, expectedOld): Promise<void>     // update-ref with old-value guard; throws MainMovedError if main != expectedOld
commitFilesOnMain(productId, files: Record<string,string>, msg): Promise<string>  // PRD.md on handoff/apply; plumbing with a temp index, one commit, update-ref with old-value guard
push(productId, remote): Promise<void>                    // token via GIT_ASKPASS env; redacted
removeWorktree(dir): Promise<void>                        // only under data/worktrees; also deletes its vibecode/* branch; no-op if dir is gone
pruneWorktrees(productId): Promise<void>
clearWorktrees(): Promise<void>                           // recovery: every data/worktrees/* (worktree remove, else rm), then prune
                                                           // + delete leftover vibecode/* branches in every repo; main/other branches kept
listRepos(): Promise<string[]>                            // ids of `<id>.git` dirs in data/repos with a safe id, sorted
removeRepo(productId): Promise<void>                      // rm -rf data/repos/<id>.git (recovery: orphan repos); no-op if gone
```
Main history has **one commit per merged issue**: `commit-tree <merged tree> -p main -m "#<n> <title>"`. `integrate` never moves main; the caller advances it under the merge lock. The `merged` integration worktree is detached at `data/worktrees/integrate-<commitSha>`; the caller removes it with `removeWorktree`. Conflict paths are sorted and de-duplicated (`merge-tree -z --name-only`).

### 4.10 server/security
```ts
createSecrets({db, clock, redactor}): Secrets           // boot: registers every stored value with redactor
secrets.get(key) / secrets.set(key, value) / secrets.delete(key) / secrets.list(): {key; last4|null}[]
                                                           // SQLite `secrets` table; DB file 0600, data dir 0700; set registers the value;
                                                           // delete keeps it registered; last4 null under 16 chars
redactor.register(value); redactor.redact(text)            // all secret values ≥ 8 chars; applied in store.commit, log writer, errors
                                                           // literal, longest first; ≥16 chars → `***`+last4, 8–15 chars → `[REDACTED]`
redactor.safeBoundary(text)                                // where continued/cut text may be split without splitting a secret
hashPassword(pw) / verifyPassword(pw, hash): Promise       // node:crypto scrypt N=2^15 r=8 p=1, 16-byte salt, timingSafeEqual;
                                                           // stored `scrypt$N$r$p$salt$hash` (base64url)
createSessions({key: () => string, clock}) → {issue(), verify(token)}
                                                           // `<expMs>.<nonce>.<HMAC-SHA256>`, 30-day expiry; key in secrets
                                                           // `sessionKey` (SESSION_KEY_SECRET), rotated on password change
sessionCookieOptions(secure)                               // HttpOnly, SameSite=Strict, Path=/, Max-Age 30 d, Secure over HTTPS
assertBindAllowed(host, hasPassword)                       // throws (actionable message) unless loopback or password set
isLoopbackHost(host) / isLoopbackHostHeader(header)        // localhost, 127.0.0.0/8, ::1
createRateLimiter({limit, windowMs, clock}).attempt(client) // in-memory sliding window; false = over the limit
```

**server/util/exec.ts** is the only importer of `node:child_process` (ESLint enforces this):
```ts
type ExecOptions = {cwd?; env? /* merged over process.env; undefined removes */; input?; timeoutMs /* required */;
                    signal?: AbortSignal; killSignal? /* default SIGTERM; SIGINT for Claude Code */;
                    killGraceMs? /* then SIGKILL, default 5000 */; maxBuffer? /* default 10 MiB */};
exec(cmd, argv, o: ExecOptions): Promise<{code; signal; stdout; stderr; timedOut; aborted; truncated}>;  // non-zero exit is not an error
spawnStream(cmd, argv, o: ExecOptions & {onLine(line, stream)}): Promise<{code; signal; timedOut; aborted}>;
```
Never a shell. The child runs in its own process group, and timeout or abort signals the whole group. Because of that, signals sent to the server (Ctrl-C, SIGHUP, a crash) do not reach running children, which can outlive the server as orphans. Captured output, streamed lines and `ExecError` messages (start failures) pass through `redactor`. When output is cut (at `maxBuffer`, or into pieces of an over-long streamed line), the cut uses `redactor.safeBoundary`, so no part of a secret leaks.

### 4.11 server/recovery
`recover({store, db, git, runtime, clock, log?}): Promise<RecoveryReport>` runs once at boot in `main.ts`, before the scheduler starts:
- It removes every container labelled `vibecode.managed=1`. When `runtime.listManaged()` rejects with `DOCKER_NOT_RUNNING` it logs a warning, skips this step and carries on; any other rejection fails boot.
- It deletes `data/worktrees/*` (including detached `integrate-<sha>` worktrees), runs `git worktree prune` for every repo and deletes leftover `vibecode/*` branches (`git.clearWorktrees()`).
- It deletes orphan repos: `data/repos/<ULID>.git` with no product of that id (a crash between repo creation and `product.created`). Nothing else under `data/repos` is touched.
- In ONE commit:
  for each `running` attempt it records `attempt.ended{status:'interrupted', interruptReason:'restart', counted:false}`; it resets `in_progress` and `in_review` issues to `open` (the shared `interrupted` transition, attemptCount unchanged); for every agent that was still live it records `agent.exited{outcome:'restart'}`; and it records `preview.stopped` for every stale preview.
- It prunes `agent.activity` events older than 7 days (`pruneActivity`, keeps each agent's newest).

### 4.12 web
- `state/`: the browser's live copy of `ClientState`. It applies events with the shared `reduce`, so the server and the UI read an event the same way.
  ```ts
  type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';
  interface AppSnapshot { state: ClientState; lastSeq: number; status: ConnectionStatus; loaded: boolean; error: string | null }
  interface AppStore { getSnapshot(): AppSnapshot; subscribe(listener): () => void; start(): () => void /* returns stop */ }
  createAppStore({eventsUrl='/api/events', retryDelayMs=3000}?): AppStore   // store.ts
  <AppStoreProvider store={store}>                                         // AppStoreProvider.tsx: start() on mount, stop on unmount
  useApp(selector: (s: AppSnapshot) => T): T                               // store.ts; useSyncExternalStore; throws outside the provider
  getState(signal?): Promise<StateResponse>                                // api.ts; GET /api/state, zod-validated, failures → ApiError
  sendSparMessage(productId, message, signal?): Promise<OkResponse>        // api.ts; POST /api/products/:id/spar (reply arrives as events)
  savePrdDraft(productId, markdown, signal?): Promise<OkResponse>          // api.ts; PUT /api/products/:id/prd-draft
  handoffProduct(productId, signal?): Promise<OkResponse>                  // api.ts; POST /api/products/:id/handoff
  applyPrdChanges(productId, signal?): Promise<OkResponse>                 // api.ts; POST /api/products/:id/apply-prd
  addIssue(productId, AddIssueRequest, signal?): Promise<AddIssueResponse>  // api.ts; POST /api/products/:id/issues
  editIssue(issueId, EditIssueRequest, signal?): Promise<EditIssueResponse> // api.ts; PATCH /api/issues/:id (stale rev → ApiError status 409)
  cancelIssue(issueId, signal?): Promise<OkResponse>                       // api.ts; POST /api/issues/:id/cancel
  getSession(signal?) / login(password) / logout() / changePassword({current?, next}) // api.ts; auth routes (§4.3)
  onUnauthorized(listener): () => void                                     // api.ts; called on every 401 except a wrong password at login
  recheckSession(): Promise<'authenticated'|'unauthenticated'|'unknown'>   // api.ts; GET /api/session for EventSource errors; notifies onUnauthorized
  getAttemptArtifact(attemptId, 'diff'|'check', signal?): Promise<string|null> // api.ts; GET /api/attempts/:id/diff|check as text; null on 404
  ```
- `features/auth/index.ts`: `<AuthGate>` (wraps `<App>` in `main.tsx`) checks `GET /api/session` on load and renders the app only when no password is set or the browser is authenticated; otherwise only `<LoginPage>` (labelled password field, wrong-password error, rate-limit alert). Any `onUnauthorized` (a 401 from any API call, or a stream whose session re-check failed) returns to Login with "Your session has ended", which unmounts the store. `useAuth()` → `{passwordSet, logout(), passwordChanged()} | null` drives the header's Log out button and the Settings password section. EventSource cannot read the HTTP status, so the events store (on a `CLOSED` stream) and `useAgentLog` (on any error) call `recheckSession()` and stop retrying when the session is gone.
- `features/agents/index.ts`: `<AgentList product>` (Build tab: the product's live agents, `endedAt === null`, oldest first, each with role label "Foreman (orchestrator)" / "Builder (implementer)" / "Inspector (reviewer)" / "Drafter (sparring)" / "Helper (utility)", provider/model, state text ("Working", "Waiting for owner", "Rate limited until 14:05"), issue link, last activity line, and a "Show log" button) and `<AgentPanel agent issue? open onClose>` (Dialog: role, provider/model, issue, state, live log; reused by the 3D view). The log comes from `useAgentLog(agentId)` (EventSource on `/api/agents/:id/log?follow=1`; starts over on every (re)connect because the server resends the whole log; closes on `end`; keeps the last `MAX_LOG_LINES`). Lines render as plain text; auto-scroll follows the end and pauses while the owner has scrolled up ("Jump to latest" resumes). Shared wording: `roleLabel`, `agentStateText`, `liveAgents`.
- `features/issues/index.ts`: owner issue dialogs shared by the board and the issue detail page. `<AddIssueDialog productId open onClose>`, `<EditIssueDialog issue open onClose>` (sends the rev the form was loaded from; on 409 shows `STALE_REV_MESSAGE` with the live issue's latest values and a "Reload latest version" button), `<CancelIssueDialog issue open onClose>` (confirmation), plus `isEditable(issue)` / `isCancellable(issue)`. Results arrive as events, so dialogs only close on success.
  - `IssuePage` (`/products/:id/issues/:issueId`): title, status, priority, dependencies (links), attempts used, cost (`issueCostText`), failure reason, held question, sanitised markdown body (`ui/Markdown`), Edit/Cancel through the dialogs above, and `AttemptList`: every attempt newest first with status, counted or not, step, started/ended and feedback, plus `Tabs` Log (each of the attempt's agents via `LiveLog` from `features/agents`), Diff (`DiffView`: +/- lines styled and marked "Added:"/"Removed:" for screen readers), Check output (with the exit code) and Review (verdict and findings). Only the open tab renders, so hidden tabs neither stream logs nor fetch; artifacts are refetched as the attempt's step/status advances.
  - `createAppStore` holds the snapshot and the connection, with no React involved. `start()` connects, and the function it returns disconnects. It can be started again after a stop.
  - `AppStoreProvider` puts one store in context and keeps it connected while it is mounted.
  - `useApp(selector)` returns a slice of `AppSnapshot` and re-renders when that slice changes. The selector must return existing objects, not build new ones each call.
  - `ConnectionStatus`:
    - `connecting`: no live connection yet in this session (first load).
    - `live`: a snapshot is loaded and the event stream is open.
    - `reconnecting`: the store was live before but the stream or snapshot is being restored.
    - `offline`: the `GET /api/state` load failed. `error` holds a message for the owner, and loads are retried with exponential backoff (`retryDelayMs · 2^(n-1)`, capped at 30 s). The status stays `offline` until a snapshot loads.
  - `loaded` becomes true after the first successful snapshot. `error` is cleared on success.
- Sync protocol (`connect()`):
  1. Close any previous stream and request, and bump a generation counter so their late callbacks are ignored.
  2. Open `EventSource(eventsUrl)` first, then fetch `GET /api/state`. Until the snapshot arrives, decoded events are buffered. When the request is sent the buffer is cleared, because the snapshot includes everything committed before then.
  3. On the snapshot, set `state` and `lastSeq` from `{state, lastSeq}`, then apply the buffered events. From then on, apply each event as it arrives. Every event with `seq <= lastSeq` is skipped as a duplicate. Each remaining event goes through `reduce`, and `lastSeq` advances.
  4. Stream errors: the browser's own `EventSource` retry is used. If the browser gave up (`readyState === CLOSED`, e.g. a non-200 answer), the store reopens the stream after `retryDelayMs · failures`. A successful `open` resets the failure count. After `MAX_STREAM_FAILURES` (3) consecutive errors, events may have been missed, so the store runs `connect()` again and rebuilds from a fresh snapshot.
  - Events of a type unknown to this client (a newer server) are dropped silently. Malformed payloads are logged with `console.error` and dropped. The next snapshot reload repairs any gap.
- SSE wire format (`GET /api/events`): every event is an unnamed message, with no `event:` field, so it reaches `onmessage`. `id:` is the event `seq` and `data:` is the `Event` JSON. Comment lines `:hb` are heartbeats, which the client ignores.
- Routes:
  - `/` products
  - `/products/:id` with the `Build` tab (board, agent list, cost bar, pause/resume, preview, collapsible Scene3D), the `Spec` tab (chat, PRD editor, handoff/apply) and the `Settings` tab
  - `/products/:id/issues/:issueId` issue detail, with attempts and their log, diff, check and review
  - `/inbox`
  - `/settings`
- Browser `Notification` fires on `inbox.created` once the owner has granted permission. This belongs to the inbox feature (`features/inbox`, #33), not to the store.
- Scene3D is `React.lazy`. It renders `sceneReduce` output, with one InstancedMesh per piece type and `SkeletonUtils.clone` for each worker. When collapsed or off-screen it keeps `frameloop="never"` and stays mounted. Clicking a worker opens the same `AgentPanel` that the agent list uses.
  - `ScenePanel` (`scene/ScenePanel.tsx`): a heading button with `aria-expanded` collapses the view; the choice is kept in `localStorage['vibecode.scene.collapsed']`. The scene chunk loads on the first expand and then stays mounted. `frameloop` comes from `sceneFrameloop({expanded, onScreen, reducedMotion})`: `never` when collapsed or off-screen (IntersectionObserver), `demand` with `prefers-reduced-motion` (no animations), else `always`. The canvas is `aria-hidden`; a note says the board and agent list carry the same information. The scene is `sceneFromState` of the live client state (≡ replaying `sceneReduce`), memoised so events without a scene effect don't re-render it.
  - `scene-model.ts` (pure, unit-tested): `instanceCounts`/`piecesByType`, `workerPlacements` (look by figure, spot at the site/desk/bench), `debrisPlacements`, `Scene3DProps {scene, frameloop, reducedMotion}`.
  - Render stats for the E2E smoke test: `window.__vibecodeScene = {drawCalls, triangles, frames, workers, pieces}`, set in dev/test builds, or in production when `localStorage['vibecode.debug.sceneStats'] === '1'` (`SCENE_STATS_FLAG`).

## 5. Data model (SQLite, `data/vibecode.db`)

```
events(seq INTEGER PK AUTOINCREMENT, ts INTEGER, type TEXT, product_id TEXT, entity_id TEXT, v INTEGER, data TEXT)  idx(product_id, seq), idx(entity_id, seq)
products(id PK, name, idea, phase 'sparring'|'building'|'complete', paused INT, pause_reason 'owner'|'budget'|NULL,
         budget_usd REAL NULL, budget_warned INT, max_parallel INT=3, max_attempts INT=3, models JSON, git_remote JSON NULL,
         prd_version INT=0, orchestrator_cursor INT=0, project JSON NULL /* last valid .vibecode/project.json */, created_at)
prd_versions(product_id, version, markdown, summary NULL, created_at)  PK(product_id, version)
prd_drafts(product_id PK, markdown, base_version, updated_at)
spar_messages(id PK, product_id, role 'owner'|'agent', text, created_at, seq /* event seq: arrival order */)
issues(id PK, product_id, number, title, body, status, rev, priority, origin 'orchestrator'|'owner', prd_version,
       attempt_count, held_question_id NULL, run_after INT, merged_order INT NULL, merge_sha NULL, failure_reason NULL,
       cancel_reason NULL /* server-only */, created_at, updated_at)
issue_deps(issue_id, depends_on_id, position /* order of dependsOn */)  PK(issue_id, depends_on_id)
attempts(id PK, issue_id, product_id, n, issue_rev, base_sha, branch, head_sha NULL,
         status 'running'|'merged'|'check_failed'|'rejected'|'conflict'|'error'|'interrupted'|'discarded',
         counted INT, step 'implement'|'check'|'review'|'merge', feedback NULL, review JSON NULL, check_exit NULL, interrupt_reason NULL, started_at, ended_at NULL)
agents(id PK, product_id, role, provider, model, issue_id NULL, attempt_id NULL,
       state 'working'|'waiting_owner'|'rate_limited'|'exited', until INT NULL, last_activity NULL, started_at, ended_at NULL)
usage(id PK, product_id, issue_id NULL, attempt_id NULL, agent_id, role, provider, model, billing 'api'|'subscription',
      input, output, cache_read, cache_write, reasoning, web_searches, calls, cost_usd REAL NULL, unpriced INT,
      est_cost_usd REAL NULL, source 'computed'|'provider'|'cli', ts)
questions(id PK, product_id, issue_id NULL, agent_id NULL, target 'orchestrator'|'issue', text, answer NULL, created_at, answered_at NULL)
inbox(id PK, product_id NULL, kind 'question'|'failed'|'budget_warn'|'budget_paused'|'rate_limited'|'auth_required'|'replan'|'complete'|'error',
      title, body, link, read_at NULL, created_at)
backend_limits(backend PK /* e.g. 'claude-code', 'anthropic' */, until INT NULL, needs_login INT, reason)
usage_totals(scope 'product'|'issue', scope_id, api_usd REAL, api_unpriced INT, sub_input, sub_output, sub_cache_read, sub_cache_write,
             sub_reasoning, sub_calls)  PK(scope, scope_id)   -- running totals, added in commit order (snapshot ≡ replay)
previews(product_id PK, container, url, started_at)
settings(key PK, value JSON)      -- host-independent prefs, role defaults, provider configs (no secrets), price overrides, passwordHash
secrets(key PK, value, updated_at) -- api keys, git tokens, session HMAC key; never in events, never sent to the client in full
```
On-disk layout under `VIBECODE_DATA_DIR`:
- `repos/<id>.git` holds each product's repository.
- `worktrees/<runId>/` holds ephemeral worktrees.
- `logs/<agentId>.ndjson` holds redacted agent logs.
- `artifacts/<attemptId>/{diff.patch,check.log}` holds attempt artifacts.
- `empty` is the `.git` mask file.

Event types (each has a zod schema in `shared/events.ts`, with `v:1`):
- `product.created|settings_changed|handed_off|paused|resumed|phase_changed`
- `spar.message`, `prd.draft_saved`, `prd.applied`, `prd.summarized` (`{version, summary}`: the replan summary of that version)
- `orchestrator.cursor_advanced`
- `issue.created|edited|status_changed|held|released|cancelled|completed|failed|rewritten`
- `attempt.started|step|ended`
- `agent.spawned|state|activity|exited`
- `usage.recorded`, `budget.warned`
- `question.asked|answered`
- `inbox.created|read`
- `backend.limited|cleared`
- `settings.changed` (global; `{sections, keys: [{provider, set}]}`, never values; reduced to `ClientState.settingsChangedAt`)
- `preview.started|stopped`

`agent.activity` is batched and not reduced into the snapshot, apart from the last line. Events older than 7 days are pruned.

Product repository contract, which the orchestrator writes:
- `Dockerfile`. The base must be Debian/glibc. Dependencies install **outside `/workspace`**: Node at `/node_modules` (resolved from `/workspace` by walking up the directory tree), Python in `/opt/venv` on PATH.
- `.vibecode/project.json` with this shape: `{check: string[] /* argv run in /workspace, network none */, imageInputs: string[] /* lockfiles */, preview?: {command: string[], port: number}}`
- `docs/PRD.md` and `docs/adr/NNNN-*.md`

## 6. Key flows

1. **Create → spar.** `POST /products` runs `initRepo` and emits `product.created`. Each `spar` call runs one `runAgent(role sparring)`. The API backend runs it without a sandbox; Claude Code runs it in a container (derived Claude image, config volume, egress) on an empty scratch worktree `data/worktrees/<runId>` that is removed afterwards (`SparringDeps.runtime` + `dataDir`). The result appends `spar.message` and, if present, `prd.draft_saved`.
2. **Handoff.** The draft becomes `prd_versions` v1. `commitFilesOnMain(docs/PRD.md)` runs, then `prd.applied` and `product.handed_off` are emitted with phase `building`. That event is now a pending trigger.
3. **Orchestrator run.** It takes one slot. The run uses a worktree of main and a warm sandbox (`egress`), and has web search enabled. The agent may only change `Dockerfile`, `.dockerignore`, `.vibecode/**` and `docs/**`; the host rejects the run otherwise. The host commits and integrates under the merge lock (no review; image build is checked). It then validates the `PlanResult`: dependency keys must resolve, there must be no cycles, and edits and cancels are only allowed in legal states. Next it emits `issue.*` events, `question.asked` and, for replans, `inbox.created{replan}`. Finally it emits `orchestrator.cursor_advanced` to the highest trigger seq it consumed, all in one commit. If the run fails, the cursor does not move, and a retry happens after a backoff (at most 3, then `inbox{error}`).
4. **Attempt** (`runAttempt`):
   1. Emit `issue → in_progress` and `attempt.started{baseSha=main}`, then add a worktree on branch `attempt/<id>`.
   2. Implement. `ensureImage` runs, then a warm sandbox starts (`egress`, rw). The implementer gets the issue, the PRD, `AGENTS.md` (if any) and the previous attempt's feedback, and returns `ImplResult`.
   3. If `ImplResult` has a question, emit `question.asked`, `issue.held` and an interrupted attempt (not counted).
   4. The host runs `commitAll`. An empty diff fails the attempt with "no changes".
   5. Check. `ensureImage` is rebuilt if `imageInputs` changed. `runOnce(check, network none)` runs, the output is saved, and `cleanWorktree` follows. A non-zero exit records `check_failed` with feedback (the last 200 lines).
   6. Review. Emit `issue → in_review`. A new agent with a fresh context runs with a read-only mount, network `none`, and the tools `read_file, list_dir, grep, run`. It is given the diff, the issue and the check output, and returns `ReviewResult`. A rejection records `rejected` with the findings as feedback.
   7. Merge, under the merge lock. First the host re-reads the issue. If it was cancelled, the attempt is `discarded`. If its `rev` changed, the attempt is `interrupted{issue_changed}` (not counted). Otherwise it runs `integrate`. On `fast` it advances main. On `merged` it runs the check on the integration worktree and advances main if that passes. On `conflict` it records `conflict` with the paths as feedback. On success it emits `issue.completed{mergedOrder, mergeSha}` and, if a remote is configured, pushes asynchronously.
   8. In `finally`, close the containers and remove the worktree and branch.
   9. Failure handling. A counted failure increments `attempt_count`. If attempts are left, the issue goes back to `open` and the next attempt gets the feedback. Otherwise it emits `issue.failed`, which becomes an orchestrator trigger, `inbox{failed}` and scene debris.
5. **Pause, budget and rate limits.**
   - `shouldStop()` makes each run finish its current step and return `stopped`. The attempt becomes `interrupted` (not counted) and the issue returns to `open`.
   - After every `usage.recorded` (the `afterUsage` hook → `checkBudget`) and after every settings change, `budgetLevel` is computed over API spend. At 80% it emits `budget.warned` and `inbox` once. At 100% it emits `product.paused{budget}` and `inbox`. Resume is refused (409) while the budget is still exhausted. Raising the budget so spend is back under 80% clears the warning (`product.settings_changed{budgetWarned:false}`).
   - A `rate_limited` result emits `backend.limited{until}`, which applies to the whole account, and the agent state goes to `rate_limited`, which the scene shows as the bench. The scheduler skips that backend until `until`.
6. **Apply changes.** The owner edits the draft while the build continues. `apply-prd` creates version N+1, commits `docs/PRD.md` and emits `prd.applied`, which becomes a trigger. The orchestrator gets both PRD versions plus all issues. It may create, edit or cancel open issues, and it creates follow-ups for merged work. Its summary is stored on that version (`prd.summarized`) and goes to the inbox, in the same commit as the plan.
7. **Owner issue ops.** Add, edit and cancel go through `shared/issues.transition` guards. An edit bumps `rev`, which makes any in-flight attempt discard itself at merge time.
8. **Questions.** Answering emits `question.answered`. For an issue question it emits `issue.released`, and the next attempt gets the Q&A in its prompt. For an orchestrator question the answer becomes a trigger.
9. **Completion.** When every non-cancelled issue is `completed` and no triggers or runs remain, it emits `product.phase_changed{complete}` and `inbox{complete}`. Any new issue or applied PRD sets the phase back to `building`.
10. **Restart.** This is `recover()` (§4.11), followed by the scheduler, which starts again from projections and triggers.

## 7. Testing strategy

| Layer | Tool | What |
|---|---|---|
| shared | Vitest (`unit`) | transition table (every from×to), isReady/deps, triggers, budget, pricing, `reduce` and `sceneReduce` replays, layoutPiece |
| server units | Vitest (`unit`) | store with `:memory:` DB + real migrations; `buildRunArgs` security assertions (no docker.sock, `.git` mask, cap-drop, no secret env); redactor; bind policy; password/session; ClaudeCode NDJSON parser against fixture files in `src/server/agents/fixtures/`; git module against real git in tmp dirs |
| server integration | Vitest (`unit`) | full pipeline with `fake` LLM + `FakeContainerRuntime` + real git. It covers create → spar → handoff → plan (3 issues with deps) → attempts → merge (`main` has 3 commits). It also covers retry with feedback, failed → orchestrator rewrite, pause/resume, budget auto-pause, rate-limit backoff, restart recovery, cancel during an attempt, apply-PRD replan, and snapshot ≡ replayed events. HTTP is tested through `app.request()`. |
| web | Vitest (`web`, jsdom) + Testing Library | board columns update from events, issue forms, inbox badge, settings masking, AgentPanel; axe-free a11y queries by role and name |
| browser E2E | Playwright (`npm run test:e2e`) | server in demo mode on a temp data dir: live board updates, add/edit/cancel issue, inbox, settings and password, one Scene3D render smoke (canvas present, draw calls under 60) |
| docker E2E | Vitest (`npm run test:docker`) | real Docker: fake agents commit in containers, checks run with network none, merge to main, preview serves on 127.0.0.1, containers have no docker.sock, recovery removes orphans |

Rules: no test needs network, API keys or a Claude subscription. Time is injected (`Clock`), as are ids (`IdGen`) where order matters. `npm test` must finish in under 60 s.

## 8. Scaffold contract (first issue)

The harness runs these commands on every change, so the scaffold issue MUST define exactly these `package.json` scripts:

| Script | Command |
|---|---|
| `typecheck` | `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.web.json` |
| `lint` | `eslint . && prettier --check .` |
| `format` | `prettier --write .` |
| `test` | `vitest run --project unit --project web` |
| `test:e2e` | `playwright test` |
| `test:docker` | `vitest run --project docker` |
| `dev` | `node scripts/dev.mjs`. It reads `$PORT` (default 5173), starts the API with `node --watch src/server/main.ts` on 127.0.0.1:`$PORT+1` with `VIBECODE_DEMO=1 VIBECODE_FAKE_DOCKER=1 VIBECODE_DATA_DIR=.data/dev`, and starts Vite on 0.0.0.0:`$PORT` with `/api` proxied (SSE buffering off). |
| `build` | `vite build` (SPA → `dist/web`; the server is not built) |
| `start` | `node src/server/main.ts` |
| `db:generate` | `drizzle-kit generate` |

Additional requirements:
- `"type": "module"` and `"engines": {"node": ">=22.18"}`.
- Exact version pins.
- A committed `package-lock.json`.
- `npm test` must pass on a fresh `npm ci` with no Docker and no network.

## 9. Running locally

Requires Node ≥ 22.18, git ≥ 2.38, and Docker Engine or Desktop (only for real builds and the docker suite).

```
npm ci
npm run dev           # Vite on $PORT (0.0.0.0, dev only) + API on 127.0.0.1:$PORT+1, demo mode, data in .data/dev
npm run build && npm start   # production: serves SPA + API on VIBECODE_HOST:VIBECODE_PORT (127.0.0.1:4317)
```
Environment variables:
- `VIBECODE_DATA_DIR` defaults to `~/.local/share/vibecode`.
- `VIBECODE_HOST` must be loopback unless a password is set.
- `VIBECODE_PORT`
- `VIBECODE_DEMO=1` uses the fake LLM.
- `VIBECODE_FAKE_DOCKER=1` uses the fake runtime.

Platform notes:
- WSL2: run inside the distro, keep the data dir on ext4 (not `/mnt/c`), and enable systemd.
- macOS: Docker Desktop or OrbStack, selected through the docker context.
- Remote access: set a password, then use Tailscale or a TLS reverse proxy.

Claude subscription setup (once): `docker volume create vibecode-claude-config`, then run the login command shown on the Settings page (`docker run -it --rm -v vibecode-claude-config:/home/agent/.claude vibecode/claude-code claude auth login`). Vibecode never reads that volume.
