# 0007. Pipeline semantics: attempt-level retries with feedback, single-lane squash merge, orchestrator by event cursor

Date: 2026-11-19 · Status: Accepted

## Context

Issues must run in parallel (default 3), retry with failure feedback (default 3 attempts), merge autonomously to main, recover from restarts, react to owner edits and cancels, and replan on PRD changes.

## Options considered

- **Fresh-context attempts + single-lane merge with fast path (chosen)**: Each attempt is a new agent with the previous feedback; merge lane per product; conflicts count as failed attempts.
- **clankit two-tier (same-session fix loop + redispatch)**: Cheaper fixes, but resuming sessions is backend-specific and does not survive restarts.
- **Write-scope reservation at dispatch**: Prevents conflicts, but agents must predict paths; deferred, and the orchestrator expresses overlap as deps.
- **Generic jobs table with effects (Candidate 2)**: Durable at-least-once, but every handler must be idempotent and the flow is harder to read.

## Decision

An attempt runs implement → host commit → check (network none) → fresh-context review → merge under a per-product async mutex. Merge works like this:
- If main equals baseSha, it commits the attempt tree as one commit on main without re-checking.
- Otherwise `git merge-tree --write-tree` runs. If the merge is clean, checks run in an integration worktree, then main advances via commit-tree (one squash commit per issue) with an update-ref old-value guard.
- On conflict, the attempt is a failed attempt and the conflicting paths are its feedback.
Counted failures are check_failed, rejected, conflict, empty diff and agent error. Interruptions are not counted: pause, budget, rate limit, restart, owner question, and a change to the issue's rev. Before merging, the run re-reads the issue: a cancelled issue makes the attempt discarded, and a changed rev makes it interrupted. After max attempts the issue goes to failed, which triggers the orchestrator (rewrite, split, or a question to the owner). Orchestrator runs are triggered by events newer than products.orchestrator_cursor: handed_off, prd.applied, issue.failed and answered orchestrator questions. The run's issue ops and the cursor advance commit in one transaction, and a failed run leaves the cursor where it was. Orchestrator file changes are restricted to Dockerfile, .dockerignore, .vibecode/** and docs/**. The orchestrator returns a structured PlanResult; it has no platform tools.

## Rationale

This matches the PRD's restart rule (reset to open) and keeps all agent context disposable, so durability comes from git plus the database, as in the Ralph and Anthropic harness findings. Fresh contexts work the same way on both backends. The fast path avoids re-checks when main has not moved, and checks always run on the exact tree that lands on main. Squash commits give one commit per issue, so git history matches the board and the building pieces (success criterion 3). The cursor gives exactly-once orchestrator triggering without a queue.

## Sources

- [Research: prior art and merge queues](docs/research/prior-art-how-do-clankit-milliesolem-clankit-openh.md)
- [git merge-tree --write-tree](https://git-scm.com/docs/git-merge-tree)
