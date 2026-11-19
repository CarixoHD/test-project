# 0001. Overall architecture: fixed-pipeline monolith with an event log and shared reducers

Date: 2026-11-19 · Status: Accepted

## Context

Three designers proposed architectures for a self-hosted, single-user platform. It runs AI agents (sparring → orchestrator → implementers → reviewer → merge) in Docker containers and shows live progress on a board and in a 3D view. The design has to support parallel implementation by agents, fast offline tests, restart recovery and strong isolation.

## Options considered

- **Candidate 1: One Process, One Log**: Single package. Two tables: an append-only events log and secrets. In-memory state is rebuilt by replaying the log at boot through one reducer shared with the browser. No ORM, job queue, Docker SDK or MCP. Docker CLI via execFile. Structured agent results through a finish tool or --json-schema. An event cursor drives the orchestrator. Downsides: boot replay and the database grow without bound because logs and diffs sit in events, and egress is open.
- **Candidate 2: Hexagonal modular monolith with event spine**: pnpm monorepo with about 12 ports (LlmProvider, AgentRuntime, ToolKit, ContainerRuntime, Vcs, PriceSource, NotificationChannel, SecretStore, PreviewTarget, AccessPolicy…), a data-driven transition table that emits effects into a durable jobs table run by StageHandlers, and role and stage registries. Very extensible, but heavy indirection, at-least-once idempotency burden, and an MCP bridge needed for Claude Code platform tools.
- **Candidate 3: Hot-path monolith**: Fixed pipeline: implement → check → review → merge. One warm container per attempt, driven by docker exec. A single merge lane with a fast-forward fast path and merge-tree. Projection tables plus events in one transaction. Logs live in NDJSON files outside the event stream. Restart resets issues to open as the PRD says. Uses Fastify, dockerode, Drizzle and a jobs table used only for crash detection.
- **Chosen: Candidate 3 base + Candidate 1 simplifications + two seams from Candidate 2**: Candidate 3's fixed pipeline, warm containers, merge lane, projection tables and file logs. From Candidate 1: a single npm package, the docker CLI instead of dockerode, structured agent results (no MCP or platform tools), the orchestrator event cursor instead of a jobs table, Hono, and scrypt. From Candidate 2: only the ContainerRuntime and agent-backend seams, both with fakes.

## Decision

Build a single Node 22 process (one npm package: src/shared, src/server, src/web) with one SQLite file. All writes go through store.commit(), which updates the projection tables and appends to an `events` table (global seq) in one synchronous transaction, then publishes on an in-process bus to SSE. Browser and server share a pure `reduce(state, event)`, and a test asserts that the snapshot equals the replayed events. The pipeline is hard-coded (runAttempt: worktree → warm sandbox → implementer → host commit → checks with network none → fresh reviewer → per-product merge lane). Issue states change through a pure transition function. There is no job queue: open issues are the queue, and orchestrator work is selected by a cursor over trigger events. Restart recovery resets in-flight work to open and reaps containers and worktrees by label. Agent logs and diffs live in files, not in events. Interfaces with fakes exist only where tests and demo mode need them: the LLM (fake provider), ContainerRuntime (FakeContainerRuntime) and the agent backend (API loop vs Claude Code CLI).

## Rationale

The PRD wants one fixed pipeline, a single user, restart-to-open semantics and fast feedback. Candidate 3 matches that directly and is the easiest to read and test exhaustively. Candidate 1's simplifications remove whole subsystems we do not need. Without a jobs table, an ORM-free Docker layer and MCP, implementers have fewer concepts to learn. Structured final results work the same way for the AI SDK loop and for `claude -p --json-schema`. Candidate 1's pure event-log storage was rejected because it replays at boot and grows without bound. Candidate 2's generality (registries, effect jobs, 12 ports) costs indirection on every issue, and it would mostly serve features that are out of scope for v1. We keep only the seams that have a second real implementation today (the fakes). The single-package layout avoids workspace tooling friction for parallel implementers.

## Sources

- [Research: prior art (clankit, OpenHands, merge queues)](docs/research/prior-art-how-do-clankit-milliesolem-clankit-openh.md)
- [Research: persistence and real-time transport](docs/research/what-durable-persistence-and-real-time-transport-f.md)
- [clankit](https://github.com/milliesolem/clankit)
