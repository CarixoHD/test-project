# Prior art: how do clankit (milliesolem/clankit), OpenHands, Sweep, Devin-style systems, and Claude Code subagent/'ralph loop' workflows structure the orchestrator → implementer → reviewer → merge pipeline? Cover: issue/task state machines, retry with feedback, merge-conflict handling when parallel worktrees merge to main, durable job queues that survive restarts, and replanning after spec changes.

Date: 2026-11-19 · Confidence: medium

## Recommendation

Use one persistent SQLite (WAL) state store as the source of truth, with an explicit per-issue state machine. Don't adopt Temporal.

1. **States:** planned → ready (dependencies merged and no write-scope overlap with active issues) → implementing → checks_failed (fix loop) → in_review → changes_requested → (back to implementing) → merge_queued → merging → merged.
   - Terminal or side states: blocked, failed, cancelled (dependency failed), stale (spec changed), needs_human.
   - Write every transition as an append-only event row, and keep a current-state projection alongside it.
   - Make the transition function pure (state, event) → state, so it can be unit-tested exhaustively.

2. **Retries in two tiers, as clankit does:**
   - Tier 1: N fix attempts in the same session, feeding back the harness's own failing check output and the reviewer's blocking findings.
   - Tier 2: one redispatch to a fresh agent, with a previous_attempt brief.
   - Hard caps; after that, move the issue to needs_human.
   - Never accept "done" from the agent; the harness re-runs the checks.

3. **Merges:**
   - Reserve write scopes at dispatch.
   - Single-lane merge worker: rebase or cherry-pick in a throwaway integration worktree made from the current main, run the full checks, fast-forward, record base and head SHAs.
   - On conflict or regression, fail closed. Store the conflicting paths and output, then send a bounded repair to the original implementer, rebased on the new main.
   - After 2 failures, move to needs_human or split the issue.

4. **Durability:**
   - Run jobs as rows with lease and heartbeat columns. On startup, reclaim expired leases.
   - Make steps idempotent and record them only after they succeed.
   - Keep agent context disposable. Resume from the worktree, git and the event log, as Ralph and Anthropic's harness do, rather than by replaying the conversation.

5. **Replanning:**
   - Version the PRD.
   - On a spec change, have the orchestrator diff the spec, mark affected issues that aren't merged yet as stale (cancel running ones at a safe point), and create new or amended issues.
   - Merged work only changes through new follow-up issues.

## Findings

None of these systems describes the full orchestrator → implementer → reviewer → merge pipeline end to end. The pieces are well covered, though, and they point to the same design.

**clankit (milliesolem/clankit), read from source: `orchestration/task_tree.py`**
- Node statuses: running, waiting (has delegated, waiting on children), integrating, done, failed, cancelled (a dependency was not accepted).
- Report statuses: done, partial, blocked, failed. Outcomes add "error" (provider failure) and "checks failed".
- A node counts as accepted only if: there was no error, the report is done or partial, and every harness check passed. The harness runs the check commands itself; the agent's claim is not taken on trust.
- The scheduler runs a subtask only when all `depends_on` items are finished, no earlier unfinished subtask has an overlapping `write_scope`, and a `max-parallel` slot is free (default 4). A scope of None conflicts with everything. File tools enforce each agent's scope.
- Retry happens in two tiers:
  1. `fix-attempts` (default 1, max 5): the same agent gets a "[Harness]" message containing the failing command's output, and the checks run again.
  2. `redispatch`: one fresh agent, with a `previous_attempt` section in its brief (prior summary, open issues, failing checks). It is skipped if the agent reported blocked or failed with a real reason, or if `max-nodes` is reached.
- Integration: there are no worktrees in task-tree. All agents share one directory, and conflicts are prevented by scheduling disjoint write scopes. The parent gets "N of M accepted" plus the changed files from the harness's own records, and is told to treat reports as claims and re-run checks on the combined result.
- Review: an optional fresh-context review of a branch's integrated diff or of the root's final diff. Blocking findings go back to the author. The review-loop method defaults to `max-rounds`=2.
- Worktrees are used only in best-of-n: N worktrees, the harness tests each, and a selector applies the best one.
- Replanning: there is no explicit step. The parent can re-delegate, fix things itself, or report the work as unfinished. Children can only report `open_issues` or blocked.
- Persistence: there are session nodes, but the code I read does not show durable resume of children.

**OpenHands (Software Agent SDK V1)**
- Event-sourced. There is an append-only EventLog (one JSON file per event, with file locking) plus `base_state.json`.
- To resume, it reloads base_state and replays events, then detects unmatched ActionEvents (an action with no observation) to find work that was in flight.
- An execution status enum replaced the old AgentState. Pausing persists state.
- Known gap: issue #19502 (Nov 2026) reports that after a sandbox crash the agent restarts from the first message. Durable resume is still buggy even there.

**Sweep**
- GitHub-native state. The issue is the task. Sweep posts a plan as a comment, and editing or replying to it replans before coding starts.
- After that: a branch and a PR. Comments starting with "Sweep:" and failing GitHub Actions logs are fed back as retry input. It supports a "sweep: retry" command and REVERT. A retry limit was left as a TODO.

**Devin**
- "Managed Devins" (Mar 2026): a coordinator session scopes work and gives each child its own VM.
- The coordinator can message, pause or kill children mid-task and read their trajectories. The blog does not say how it resolves conflicts or retries; it just says it "resolves conflicts".
- Child sessions can nest (Aug 2026).
- Devin Bots (Nov 17 2026) are reported to split a goal into tickets, run sessions in parallel, merge PRs that pass CI, and escalate decisions to humans. That description comes from a third-party site, not Cognition, so it is unconfirmed.

**Ralph loop and Anthropic's long-running harness**
- Basic form: `while :; do cat PROMPT.md | claude; done`. Each pass has a fresh context, does one task, and the state lives in files and git.
- Anthropic's version: an initializer writes `feature_list.json` (each feature marked passing or failing), `claude-progress.txt` and `init.sh`. Each session reads the git log and progress file, picks the highest-priority failing feature, tests, commits and updates progress.
- The official plugin `/ralph-loop` uses `--max-iterations` and `--completion-promise`.
- Takeaway: durability comes from the spec, the task file and git. Agent memory is not durable.

**Merge queue for parallel worktrees (DEV posts, 2026)**
- Coding runs in parallel, but merging is single-lane:
  1. Rebase or cherry-pick into a disposable integration worktree made from main, never in the agent's own worktree.
  2. Run the full checks there.
  3. Fast-forward main only if they pass.
- On conflict it fails closed: no agent guesses at conflict markers. It keeps the worktree and records the conflicting paths, base SHA and conflict output, then sends a bounded repair task to the original agent or escalates.
- Stop auto-retrying after 2 failed rebases and ask for a smaller task.
- Record `baseSha` and `headSha` as immutable evidence. A pass on an old base does not count once main has moved.
- Example states: proposed → claimed → rebasing → validating → merged, plus needs_review, rejected, and needs_review → proposed.
- Path reservation at dispatch (claimed paths, serializing overlapping tasks) prevents most conflicts. The Claim Plane paper (arXiv 2607.21909) points out that semantic conflicts can happen without any textual overlap, so checks must run on the merged result.
- My addition (from my own knowledge, not these sources): `git merge-tree --write-tree` (git ≥ 2.38) can detect conflicts without a checkout.

**Durable queues**
- DBOS (a library on Postgres or SQLite): a workflow_status row marked PENDING plus per-step outputs. On restart it re-runs PENDING workflows and skips completed steps.
- Temporal: needs a server and deterministic workflow code. It is overkill for a single-host app.
- DIY with SQLite: write the log entry after a step succeeds, never before. The cost is at-least-once execution, so every step must be safe to run twice.
- A plain job queue retries the whole job and pays for the LLM work again. Checkpointing per step avoids that.

## Sources

- [clankit README](https://github.com/milliesolem/clankit)
- [clankit task_tree.py](https://raw.githubusercontent.com/milliesolem/clankit/main/src/clankit/orchestration/task_tree.py)
- [OpenHands SDK paper](https://arxiv.org/html/2511.03690v1)
- [OpenHands issue #19502 resume after crash](https://github.com/OpenHands/OpenHands/issues/19502)
- [OpenHands state.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/state.py)
- [Launch HN: Sweep](https://news.ycombinator.com/item?id=36987454)
- [Sweep issue #766](https://github.com/sweepai/sweep/issues/766)
- [Devin can now Manage Devins](https://cognition.com/blog/devin-can-now-manage-devins)
- [Devin Bots news (third-party)](https://automater.ai/news/devin-bots-cognition-persistent-coding-agents/)
- [Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Ralph Wiggum loop (The Register)](https://www.theregister.com/2026/01/27/ralph_wiggum_claude_loops/)
- [AI Coding Agent Merge Queue](https://dev.to/jackm-singularity/ai-coding-agent-merge-queue-ship-parallel-changes-without-hidden-conflicts-46c1)
- [Handling Git Merge Conflicts in Multi-Agent Worktrees](https://dev.to/raylabs/handling-git-merge-conflicts-in-multi-agent-worktrees-1em8)
- [Claim Plane paper](https://arxiv.org/pdf/2607.21909)
- [You Don't Need Temporal Yet](https://hackernoon.com/you-dont-need-temporal-yet-durable-execution-for-ai-agents-in-150-lines)
- [Durable execution comparison (Cadenya)](https://cadenya.com/other-content/durable-execution-for-ai-agents)
- [DBOS with Pydantic AI](https://ai.pydantic.dev/durable_execution/dbos/)
