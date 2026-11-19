# 0005. Persistence and real-time: SQLite (better-sqlite3 + Drizzle), events + projections, SSE with Last-Event-ID

Date: 2026-11-19 · Status: Accepted

## Context

All state must survive restarts. The UI must update within about 1 s. The board and the 3D scene must reflect the same events. There is a single process and a single user.

## Options considered

- **SQLite WAL via better-sqlite3 13 + drizzle-orm 0.45, events + projection tables**: Sync transactions; typed schema; checked-in migrations.
- **Pure event log, in-memory state rebuilt at boot (Candidate 1)**: Minimal schema, but boot replay grows and the DB grows without bound.
- **node:sqlite**: Still release-candidate stability; the API is still changing.
- **Postgres + pg-boss / Redis + BullMQ**: Adds a second service; overkill for one process.
- **WebSockets instead of SSE**: Bidirectional, but needs custom resume and heartbeat code; commands are plain REST anyway.

## Decision

Use one SQLite file with WAL, synchronous=NORMAL, busy_timeout=5000 and foreign_keys=ON, accessed through better-sqlite3 13.2 and drizzle-orm 0.45 (drizzle-kit 0.31 migrations checked in). store.commit() runs projection writes and event appends (global seq, zod-validated, redacted) in one sync transaction, then emits on an in-process bus. There is no job queue. GET /api/state returns the snapshot plus lastSeq, and GET /api/events is SSE with id=seq: it replays from Last-Event-ID, sends a 15 s heartbeat, uses one multiplexed stream per tab, and sets X-Accel-Buffering: no. Agent logs go to redacted NDJSON files, and the main stream only carries agent.activity batches (at most one per 250 ms). Activity events are pruned after 7 days.

## Rationale

This follows the research's high-confidence recommendation. Sync transactions make "update projection + append event" atomic and trivial. Projections give O(1) boot and simple reads, and the event log gives gap-free SSE resume and a shared reducer for board and scene. A snapshot≡replay test keeps the two from drifting. Keeping logs out of events bounds database growth.

## Sources

- [Research: persistence and real-time](docs/research/what-durable-persistence-and-real-time-transport-f.md)
- [WHATWG server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
