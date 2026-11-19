# What durable persistence and real-time transport fit a single-process self-hosted app? Compare SQLite (with Drizzle, Prisma or better-sqlite3) plus a job/queue layer against alternatives, and compare SSE with WebSockets for pushing issue, agent and log events to the browser in under 1s. Include event-sourcing or an event log that drives both the board and the 3D scene.

Date: 2026-11-19 · Confidence: high

## Recommendation

Use one SQLite file (WAL) through better-sqlite3 13.x with Drizzle (stable 0.4x, driver `drizzle-orm/better-sqlite3`). Do not use Prisma, and do not use node:sqlite yet: it is still at release candidate stability. Revisit node:sqlite when Node marks it stable and Drizzle 1.0 ships.

Make an append-only `events` table (global `seq`) the single source of truth. Update the issues and agents projection tables in the same transaction as each append. Keep a durable `jobs` table with leases and idempotency keys in the same database, and run startup recovery that re-queues or flags jobs whose lease expired. Use liteque only if the team would rather adopt a library.

Push events to the browser with SSE: `id` = seq, the server replays events after `Last-Event-ID`, heartbeat about every 15s, one multiplexed stream per tab. Send commands via REST.

Both the board and the 3D scene load a snapshot (`/api/state` + `lastSeq`) and then apply the same events through shared pure reducers. Send agent log lines to a separate table or file stream, with batched events in the main stream. Record all of this as one ADR.

## Findings

## Persistence (single Node process, self-hosted)
- **SQLite in WAL mode is the right fit.** It has no extra service, one file to back up, and synchronous writes. Recommended pragmas: journal_mode=WAL, synchronous=NORMAL (FULL for the event table if losing the last commit before a power cut is unacceptable), busy_timeout=5000, foreign_keys=ON.
- **better-sqlite3**: latest is v13.2.0, released 14 Nov (year not shown on the page; I assume 2026). It ships N-API prebuilt binaries, so one binary works across Node versions. Its synchronous API makes "append event + update projection" in a single transaction simple and fast. Risk: it is a native module and needs a build when no prebuilt binary exists for the platform.
- **node:sqlite** (built into Node): Stability 1.2 "release candidate" since v24.15.0 / v25.7.0. It is not marked stable. A secondary source says Node 26.11 renamed `DatabaseSync` to `Database`, so the API is still moving. Use it later, not now.
- **Drizzle**: `drizzle-orm/better-sqlite3` is long-established on the stable 0.4x line. The `node-sqlite` driver exists only in 1.0 pre-releases (beta.17 through rc.4), and drizzle-kit had a node:sqlite gap (issue #5471). Drizzle runs SQL-first, has a thin runtime, and works well with sync transactions. Moving to node:sqlite later only changes the driver; the sqlite-core schema stays the same.
- **Prisma**: it works with SQLite, but adds a generate step and a heavier client (driver adapters in newer versions). Its interactive transactions are async, which fits poorly with an append-then-project pattern in one sync transaction. Its migrations on SQLite are weaker. Not recommended here. (This assessment is from prior knowledge; I did not re-verify it this run.)
- **Alternatives**: Postgres plus pg-boss or graphile-worker gives LISTEN/NOTIFY and stronger concurrency, but adds a second service, which is overkill for one process. Redis/BullMQ adds an external dependency and its durability depends on configuration. Libraries that store state in plain JSON files have no transactions and are not durable.

## Job/queue layer
- **Options checked:**
  - liteque 0.10.0 (MIT, from karakeep): built on better-sqlite3 + drizzle. It has zod payloads, retries/backoff, priorities, delayed jobs, timeouts, and a polling Runner.
  - plainjob 0.0.14: inactive, no release for about a year or more.
  - QueueLite: new, has leases and idempotency keys, needs Node ≥22.14. Immature.
  - sidequest: multi-database with a dashboard. Heavier.
- **Recommendation: build a small in-house `jobs` table in the same database instead.** The scope is small (agent runs and issue work), and only one process needs to claim jobs. Suggested columns: id, kind, payload JSON, status (queued|running|done|failed), attempts, run_after, lease_until, idempotency_key UNIQUE.
  - Claim jobs with `UPDATE … SET status='running', lease_until=now+N WHERE id=(SELECT … ORDER BY run_after LIMIT 1) RETURNING *`.
  - On startup, put expired-lease or 'running' jobs back to 'queued' (or mark them 'interrupted' and emit an event). This handles restart recovery.
  - Because there is one process, an in-memory wakeup replaces polling: the enqueue call notifies the worker directly.
  - The benefit is that a job's state change and its domain event commit in the same transaction. A separate library would make that harder.
  - liteque is the fallback if a library is wanted.

## Event log (event sourcing, applied pragmatically)
- **One append-only `events` table:**
  - seq INTEGER PRIMARY KEY AUTOINCREMENT (gives a global order and doubles as the SSE id)
  - ts
  - type (e.g. issue.created, issue.status_changed, agent.spawned, agent.state_changed, agent.log, job.*)
  - aggregate_type, aggregate_id
  - payload JSON
  - schema version v
- **Projections:** current-state tables (issues, agents) are updated in the same transaction as the append. This is a "state + event log" design (outbox style), not pure rebuild-from-events. Reads stay simple, and projections can still be rebuilt by replaying events.
- **Logs:** high-volume agent log lines should go to a separate `log_lines` table or to files, with only coarse `agent.log` events (or batches of about 100ms) in the main stream. That keeps the main stream small. Add retention and compaction for logs.
- **Board and 3D scene use the same stream.** Each is a pure client-side reducer `(state, event) => state`. Both load a snapshot via `GET /api/state` (which returns `lastSeq`) and then subscribe from `lastSeq`. The 3D layer maps event types to animations (agent.spawned → avatar appears, issue.status_changed → move between columns or zones). Keep the reducers in a shared package so they can be unit-tested.
- **Fan-out:** after commit, an in-process EventEmitter/bus pushes the event to SSE clients. Since there is one process, no LISTEN/NOTIFY or Redis is needed. Expected latency is a few ms, well under the 1s target.

## Transport: SSE vs WebSockets
- **SSE (WHATWG spec):**
  - The `id:` field is resent by the browser as the `Last-Event-ID` header on automatic reconnect, and `retry:` sets the reconnect delay. Mapping id to events.seq therefore gives gap-free resume after a dropped connection or a server restart: the server replays `WHERE seq > Last-Event-ID`.
  - It is plain HTTP, so auth, proxies and compression work as usual, and there is no extra library.
  - The spec notes per-server connection limits. On HTTP/1.1, browsers allow about 6 connections per origin, so multiple tabs can run out. Fixes: one EventSource per tab, multiplexing all topics, and HTTP/2 behind a reverse proxy, or a SharedWorker.
  - Send a heartbeat comment (`:\n\n`) about every 15s to keep proxies from closing the connection. Disable buffering (`X-Accel-Buffering: no`) and response compression.
- **WebSockets:** bidirectional, but this app's client→server actions are ordinary REST commands. WebSockets would need custom code for reconnect, resume, backpressure and heartbeats, plus a library (ws/socket.io). It only pays off if the 3D scene needs high-rate client→server streaming, which it does not.
- **Verdict:** SSE for server→client pushes, REST POST for commands.

## Sources

- [Node.js v24 SQLite docs (stability/history)](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [Flavio Copes – Node built-ins (node:sqlite stability 1.2)](https://flaviocopes.com/node-builtins/)
- [Node SQLite in Node 26](https://cnayanajith.com/blog/node-sqlite)
- [better-sqlite3 releases](https://github.com/WiseLibs/better-sqlite3/releases)
- [Drizzle SQLite getting started](https://orm.drizzle.team/docs/get-started/sqlite-new)
- [Drizzle v1.0.0-rc.4 release](https://orm.drizzle.team/docs/latest-releases/drizzle-orm-v1rc4)
- [drizzle-kit node:sqlite issue #5471](https://github.com/drizzle-team/drizzle-orm/issues/5471)
- [liteque](https://github.com/karakeep-app/liteque/)
- [plainjob](https://www.npmjs.com/package/plainjob)
- [QueueLite](https://github.com/thebraz/QueueLite)
- [WHATWG HTML – Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
