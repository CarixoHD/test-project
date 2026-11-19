# Vibecode platform — Product Requirements

## Problem

Building software with LLMs ("vibecoding") today means babysitting a chat window: the human writes prompts, copies context around, decides how to split work, and checks every result by hand. There is no single place where an idea goes from a rough description to a finished, tested product while the human stays informed but out of the loop. Existing agent tooling is mostly CLI-based, locked to one LLM provider, and gives little visible feedback on what the agents are doing.

## Solution

A web application where the user creates a **product** and is taken through a pipeline of AI agents:

1. **Sparring**: the user chats with an LLM that interviews them and writes a detailed product spec (PRD).
2. **Orchestration**: an orchestrator agent takes over, researches, makes and records decisions (following state of the art or improving on it), and splits the work into **issues**.
3. **Implementation**: sub-agents pick up issues and build them; finished issues move to "completed".

The UI shows issues live (open → in progress → completed) and lets the user add issues/features manually. Agents are visualized as small 3D figures constructing a building that represents the product — a fun, ambient view of progress.

The platform is LLM-agnostic: the user chooses provider/model, including using a Claude subscription for Claude models.

Inspiration: https://github.com/milliesolem/clankit and the workflow in https://www.youtube.com/watch?v=-QFHIoCo-Ko.

## Users

- **Owner (only user)**: a single person who self-hosts the platform (local machine or own server) and uses it to turn product ideas into working software built by AI agents, watching progress and steering by adding issues. No other accounts or roles in v1.

## User Stories

1. As the owner, I want to create a new product with a name and a short idea, so that I can start turning it into software.
2. As the owner, I want to spar with an LLM that interviews me one question at a time and writes a PRD, so that the agents have a detailed spec to build from.
3. As the owner, I want to see and edit the PRD as it is written, so that I can correct it directly.
4. As the owner, I want to hand the product off to an orchestrator when the PRD is ready, so that building starts without me.
5. As the owner, I want the orchestrator to research, record architecture decisions and split the work into small issues on its own, so that I don't have to plan the work.
6. As the owner, I want implementer agents to build issues test-first in isolated containers, a separate reviewer agent to check each change, and the platform to run the tests and merge passing work to main automatically, so that the product gets built without my approval at each step.
7. As the owner, I want to be asked a question only when an agent is blocked or a decision would change the spec, so that I am interrupted as little as possible.
8. As the owner, I want to pause and resume a product's build, so that I can stop spending tokens or step in.
9. As the owner, I want to see issues appear and move through their states (open → in progress → in review → completed / failed) in real time, so that I know what is happening.
10. As the owner, I want to manually add, edit or cancel issues and features at any time, so that I can steer the build.
11. As the owner, I want to watch agents as small 3D figures constructing a building that represents my product, so that progress is fun and visible at a glance.
12. As the owner, I want to choose the LLM provider and model the agents use, so that I am not locked into one vendor.
13. As the owner, I want to use my Claude subscription for Claude models, so that I don't have to pay separately for API usage.
14. As the owner, I want the building to grow by one visible piece each time an issue is merged, so that the scene reflects real progress.
15. As the owner, I want each running agent shown as a worker figure whose look matches its role (foreman = orchestrator, builder = implementer, inspector = reviewer), so that I can tell who is doing what.
16. As the owner, I want to click a worker figure to see its current issue and live activity log, so that I can inspect what an agent is doing.
17. As the owner, I want to collapse the 3D view, so that I can save resources or focus on the issue board.
18. As the owner, I want to set a USD budget per product, get a warning at 80% and have the build auto-pause at 100%, so that an unattended run can't overspend.
19. As the owner, I want to set the maximum number of agents running in parallel (default 3), so that I control load and spend.
20. As the owner, I want to see token usage and cost per issue and per product (and token or call counts for subscription usage), so that I understand where money goes.
21. As the owner, I want to build any product that runs in a Linux container (web app, API, CLI, script), so that I'm not limited to one kind of software.
22. As the owner, I want a Preview button that runs the current main of a web-app product and opens it in my browser, so that I can try what has been built.
23. As the owner, I want a failing issue to be retried automatically with the failure feedback (configurable attempt limit, default 3) and then handed back to the orchestrator to split, rewrite or escalate, so that the build recovers without me.
24. As the owner, I want to view every attempt's log, diff and review on an issue, so that I can understand why it failed.
25. As the owner, I want work in progress to resume after the platform restarts, so that a crash or reboot doesn't lose the build.
26. As the owner, I want to reopen sparring after handoff while the build keeps running, so that I can evolve the spec without restarting the product.
27. As the owner, I want to click "Apply changes" after amending the PRD so that the orchestrator re-plans (adds new issues, edits or cancels open ones that no longer fit, and creates follow-up issues for already-merged work that must change), so that the build follows the updated spec.
28. As the owner, I want to access the platform only from localhost by default, and optionally from other devices behind a single password, so that my keys and machine are protected.
29. As the owner, I want browser notifications and an in-app Inbox for questions, failures, budget warnings and completion, so that I notice when I'm needed without watching the screen.

## Implementation Decisions

- **Deployment**: self-hosted, single user. No sign-up, no multi-tenancy, no user/role management. Runs on the owner's machine or own server.
- **Code location**: each product is a local git repository managed by the platform. Optional per-product setting to push `main` to a GitHub (or other git) remote.
- **Execution isolation**: each implementing agent works in its own git worktree inside a Docker container (no direct command execution on the host). Docker is a host requirement.
- **Integration**: finished, reviewed work is merged to the product's `main` branch by the platform.
- **Autonomy**: after handoff the pipeline runs fully autonomously: orchestrator → implementers (test-first) → fresh-context reviewer → harness runs acceptance checks → auto-merge. No approval gates. Agents escalate to the owner only when blocked or when a decision would change the PRD; escalations appear as questions in the UI. The owner can pause or resume at any time and can add, edit or cancel issues.
- **Post-handoff spec changes**:
  - The owner can reopen sparring at any time, and the build keeps running meanwhile. PRD edits are held as a draft until the owner clicks "Apply changes".
  - On apply, the PRD is versioned and the orchestrator re-plans. It adds issues, and edits or cancels `open` issues that no longer fit. Issues already in progress finish their current attempt; if their issue is cancelled or changed, the result is discarded or reworked. Merged work is never reverted automatically; it gets follow-up issues instead.
  - The re-plan summary is posted to the Inbox.
- **LLM providers (agnostic)**: pluggable provider backends, selectable per agent role (sparring, orchestrator, implementer, reviewer, utility), with a global default.
  - API-key backends: Anthropic API, OpenAI, Google Gemini, OpenRouter, and any OpenAI-compatible endpoint (e.g. Ollama or other local servers).
  - **Claude Code (subscription) backend**: the platform drives the official Claude Code CLI (headless) inside the agent's container, logged in with the owner's Claude Pro/Max subscription. The platform must **never** extract or reuse subscription OAuth tokens to call the Anthropic API directly or through the Agent SDK. Anthropic's Consumer Terms forbid this since Feb 2026, and it risks an account ban.
  - Subscription rate or usage limits must be handled gracefully: the agent waits or backs off and the issue is retried, and the owner sees a "rate limited until …" status.
  - API keys are stored locally and never sent anywhere except the provider.
- **Buildable products (v1)**: anything that builds and runs in a Linux Docker container (web apps, APIs, CLIs, scripts, libraries). The orchestrator chooses or creates the product's container image (a Dockerfile in the repo) and the acceptance-check command.
- **Preview**: for web-app products, a "Preview" button builds and starts the current `main` in a container and opens it in the owner's browser on a local port. One preview at a time per product, with a Stop button.
- **Failure handling**:
  - When acceptance checks fail or the reviewer rejects a change, the implementer retries with the failure output and review feedback. Attempts per issue default to 3 and are configurable per product.
  - After the last attempt the issue becomes `failed`. The orchestrator then splits it, rewrites it, or escalates to the owner. Other issues continue in parallel.
  - Every attempt's log, diff and review are kept and viewable on the issue.
  - On platform restart, `in progress` / `in review` issues reset to `open` and are picked up again. Their worktrees are discarded.
- **Issue states**: `open` → `in progress` → `in review` → `completed`, or `failed` / `cancelled`. Issues can depend on other issues, and an issue only starts when its dependencies are completed.

## Testing Decisions

- The platform itself is built test-first. Unit tests cover the pipeline state machine (issue states, retries, dependencies, pause/resume, budget auto-pause, restart recovery), cost calculation, and provider adapters.
- Provider adapters are tested against a **fake/mock LLM provider** that returns scripted responses, so CI never needs real API keys or a Claude subscription. The same fake provider powers a demo mode.
- End-to-end test: create a product → scripted sparring → handoff → fake orchestrator creates 2–3 issues → fake implementers produce trivial commits in containers → checks pass → merge to main → UI shows the issues completed and the building pieces added.
- Browser E2E tests cover the issue board's real-time updates, manual issue add/edit/cancel, the Inbox, and settings (providers, budget, parallelism, password).
- The 3D view is tested at the event-mapping level (event → scene state), not pixel-by-pixel. There is one smoke test that the scene renders.
- Security tests: refuses remote bind without a password; secrets are redacted from logs; containers have no Docker socket.

## Non-functional Requirements

- **Cost control**: per-product USD budget for API-key spend. Warning at 80%; automatic pause at 100% (running agents finish their current step, then stop). Costs are computed from provider token usage and a model price table. Subscription (Claude Code) usage is tracked in tokens or calls, not USD.
- **Concurrency**: configurable maximum number of parallel agents per product, default 3.
- **Real-time**: issue state changes and agent activity reach the UI within about 1 second, without a page reload.
- **Security / access**:
  - The server binds to `127.0.0.1` by default.
  - An optional single owner password (hashed and stored locally) can be set. Remote binding (`0.0.0.0`) is only allowed when the password is set. The docs recommend Tailscale or a TLS reverse proxy for remote use.
  - API keys and git credentials are stored locally, are never shown in full in the UI after entry, are never written into product repos, and are redacted from logs.
  - Agent containers get no host Docker socket and no host filesystem access beyond their worktree.
- **Notifications**: browser notifications plus an in-app Inbox (unread badge) for agent questions/escalations, failed issues, budget warnings or auto-pause, rate-limit pauses and "product complete". Inbox items link to the relevant issue or product.
- **Durability**: all state (products, PRDs, issues, attempts, logs, costs, settings) persists locally and survives restarts.
- **Performance**: the 3D view should run smoothly (target 60 fps on a typical laptop with integrated GPU) with up to about 10 workers and a building of about 100 pieces, and can be collapsed to stop rendering.
- **Accessibility**: everything shown in the 3D view is also available in the issue board and agent list. The 3D view is never the only place to see information. Keyboard navigable, with sufficient contrast.
- **Language**: English UI only for v1.
- **Browsers**: latest Chrome, Firefox, Safari and Edge on desktop.

## Out of Scope

- Multiple users, accounts, roles, or hosted SaaS operation.
- Building mobile apps or native desktop apps (v1).
- Extracting or reusing Claude subscription OAuth tokens outside the official Claude Code CLI.
- Approval gates before merges (the pipeline is autonomous; the owner steers via issues and pause).
- Phone push notifications (ntfy/Telegram); a later optional webhook.
- Deploying built products to production hosting (v1 stops at local repo, optional git push and local preview).
- UI translations (English only).
- Mobile-optimized UI for the platform itself.

## Open Questions

- **Exact Claude Code headless usage**: the orchestrator should check the current Claude Code docs and terms for driving the CLI non-interactively under a personal subscription, and record the findings in an ADR.
- **Orchestrator research tools**: which web search/fetch capability agents use (provider-native tools vs a search API key). The orchestrator decides.

## Further Notes

**Success criteria (v1)**
1. **Official acceptance demo**: a small todo web app goes from idea through sparring, handoff and building to a working Preview of `main`. It should have roughly 10–20 issues and no manual code edits by the owner.
2. At least 80% of the demo's issues are merged without escalation to the owner.
3. Cost and progress shown in the UI match the actual provider usage and the git history.

**3D construction view (event mapping)**
- Scene: low-poly construction site, one building per product, shown next to the issue board (collapsible).
- Issue merged → a new building piece (floor, wall section, window, roof part) is added, with a short placement animation. The building's size scales with the total number of issues, so it is "complete" when all issues are done.
- Agent started → a worker figure spawns. Its role is shown by colour or hat: foreman (orchestrator), builder (implementer), inspector (reviewer), and an optional drafter at a desk (sparring).
- Agent working → the figure walks to the building and plays a work animation. Agent finished or exited → the figure leaves.
- Issue failed → a small debris pile appears near the site until the issue is retried or cancelled.
- Agent blocked or waiting for the owner → the figure shows a "?" bubble. Rate limited → the figure sits on a break bench.
- Clicking a figure opens a panel with its role, model, current issue and live log.
- The view is purely a visualization of real events. It never controls agents.
