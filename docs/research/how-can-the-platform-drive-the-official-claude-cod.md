# How can the platform drive the official Claude Code CLI headlessly inside a Docker container under a personal Pro/Max subscription in a ToS-compliant way (current docs/terms as of late 2026)? Cover: `claude -p` / stream-json output format, login/credential persistence in a container without extracting OAuth tokens, how rate/usage-limit errors and reset times surface, what token/usage data the CLI reports, and permission/tool flags for unattended runs.

Date: 2026-11-19 · Confidence: high

## Recommendation

Build the subscription backend as a single-owner design. It only drives the official, unmodified `claude` CLI as a subprocess, and Vibecode never touches the credentials.

1. **Image:** pin `@anthropic-ai/claude-code`, set `DISABLE_AUTOUPDATER=1`, run as a non-root user, add an egress firewall, and put a named volume at `/home/<user>/.claude` with `CLAUDE_CONFIG_DIR` set to that path.
2. **Login:** a one-time interactive step where the owner runs `docker exec -it … claude auth login`. Vibecode must never read, copy or store `.credentials.json` or tokens. Make sure `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are unset, and do not use `--bare`. If you need a `setup-token` fallback, the owner sets `CLAUDE_CODE_OAUTH_TOKEN` themselves, outside Vibecode's own storage.
3. **Invocation:** `claude -p --output-format stream-json --verbose --permission-mode acceptEdits|auto --allowedTools … --permission-prompts none --max-turns N --strict-mcp-config --mcp-config …`. Parse the NDJSON and keep `session_id` for `--resume`.
4. **Rate limits:** treat `rate_limit_event.status=="rejected"` plus `resetsAt` as authoritative and pause the job queue until then. Fall back to `api_retry.error=="rate_limit"`, `result.api_error_status==429`, or the "resets …" text. Show `allowed_warning` and `utilization` in the UI. Handle "Login expired" or `authentication_failed` by pausing and asking the owner to log in again.
5. **Usage tracking:** record `modelUsage` and `total_cost_usd` from each result as estimates, taking differences on resumed sessions.
6. **Guardrails:** never offer this backend to other users. For any multi-user use, require the API-key backend instead. Avoid extreme parallel fan-out so usage stays "ordinary, individual". Before shipping, confirm the unit of `resetsAt` and the retry-watchdog env vars by experiment on the pinned version.

## Findings

## 1. Legal and ToS position (the deciding factor)
Sources: code.claude.com "Legal and compliance" page, current as of 2026-11, and the Consumer Terms (effective 2025-10-08).
- **Consumer Terms §3(7)** ban "automated or non-human means, whether through a bot, script" unless you use an API key "or where we otherwise explicitly permit it". Anthropic's Claude Code docs give that permission for ordinary use:
  - They document `claude -p` / Agent SDK headless use with a subscription.
  - They document `claude setup-token` "for CI pipelines and scripts".
  - The legal page says "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- **OAuth sign-in** "is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra… subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
- **Builders of products or services**, including Agent SDK users, should use API keys. Two things are explicitly forbidden:
  - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users."
  - "developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
- **Explicit carve-out:** the rules do not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code".
- **Conditions for hosting** (these require the Commercial Terms):
  - The binary must not be modified.
  - The built-in auth methods must not be removed or disabled.
  - The platform must not "pay for, resell, or intermediate Claude usage". Each end user authenticates with their own credentials.
  - "Anthropic reserves the right to take measures to enforce… without prior notice."
- **Consumer Terms §2:** you may not share account credentials or "make your Account available to anyone else".
- **What this means for Vibecode:**
  - **Viable:** a single-owner deployment where the owner runs the official, unmodified `claude` binary in their own container, signs in themselves through Anthropic's flow, and only the owner's own work runs on it.
  - **Not viable:** a multi-user product, or any design where Vibecode reads, copies or stores the OAuth tokens, or calls the API directly with them. Third-party harnesses that reuse subscription tokens are exactly what is forbidden.
  - **Gray area:** heavy unattended agent fan-out may exceed "ordinary, individual usage". The docs warn that large workflow fan-outs can use up the weekly allowance.

## 2. Logging in and keeping credentials in a container (no token extraction)
- **Option A (preferred):** the owner runs `docker exec -it <ctr> claude auth login` (or `claude` then `/login`) once.
  - If no browser opens, copy the login URL and paste back the code at the "Paste code here if prompted" prompt.
  - The login is stored in `$CLAUDE_CONFIG_DIR/.credentials.json` (mode 0600), and the CLI refreshes it itself.
  - **Keeping it across rebuilds (official devcontainer docs):** mount a named volume at `~/.claude` and set `CLAUDE_CONFIG_DIR` to the same path, so `.claude.json` (account and onboarding state) also lands in the volume. Without that variable, setup repeats after every rebuild.
  - `/login` is not available inside `-p` runs, so the login has to be an interactive step.
  - The CLI warns 3 days before the login expires. After that, requests fail with "Login expired" and `/status` shows "Expired — log in again". The platform must detect this and ask the owner to log in again.
- **Option B:** the owner runs `claude setup-token`. It mints a 1-year OAuth token, prints it once and does not save it. The owner sets it as `CLAUDE_CODE_OAUTH_TOKEN`.
  - Docs sanction this for CI. It can only make model requests (no Remote Control or claude.ai connectors).
  - **Risk:** if Vibecode's software stores or injects this token, that arguably counts as "store/intermediate". It is safest only if the owner puts it into their own secret store or env themselves.
- **Never parse or copy `.credentials.json`.**
- **Do NOT use `--bare` with a subscription:** bare mode never reads OAuth or `CLAUDE_CODE_OAUTH_TOKEN`, only `ANTHROPIC_API_KEY` or `apiKeyHelper`.
- **Leave `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset.** They take priority over the subscription, and `-p` always uses an API key when one is present. Auth order:
  1. Cloud provider
  2. `ANTHROPIC_AUTH_TOKEN`
  3. `ANTHROPIC_API_KEY`
  4. `apiKeyHelper`
  5. `CLAUDE_CODE_OAUTH_TOKEN`
  6. Profiles
  7. `/login` OAuth
- **Optional:** set `DISABLE_AUTOUPDATER=1` and pin the version with `npm i -g @anthropic-ai/claude-code@X.Y.Z` for reproducible builds.

## 3. Headless invocation and output
- **Command:**
  `claude -p "<prompt>" --output-format stream-json --verbose [--include-partial-messages] [--input-format stream-json] [--resume <session_id> | --continue] [--max-turns N] [--max-budget-usd X] [--append-system-prompt ...] [--mcp-config ... --strict-mcp-config] [--json-schema ...]`
- **Exit codes:** 0 on success, non-zero on failure. Failures that happen inside the run (for example missing auth) are printed as the result on stdout. SIGTERM gives exit 143 and leaves the turn unfinished. Send SIGINT to end the turn cleanly.
- **Stream format:** newline-delimited JSON (NDJSON), one object per line:
  - **First line:** `system/init` with model, tools, `mcp_servers`/`mcp_server_errors`, plugins and `capabilities`.
  - **Messages:** `assistant` and `user` messages; `parent_tool_use_id` is non-null for subagents.
  - **Partial output:** `stream_event` items carry token deltas, filtered with `.event.delta.type=="text_delta"`.
  - **Other events:** `system/api_retry`, `tool_progress` (a heartbeat every 30s), `rate_limit_event`, and `system/permission_denied`.
  - **Last line:** a `result` message.
- **Resuming:** read `session_id` from the result, then pass `--resume <id>`.
- **Stdin limits:** piped stdin is capped at 10MB.

## 4. Rate and usage-limit signals
- **`rate_limit_event`** (since v2.1.181), shape:
  `{type:"rate_limit_event", rate_limit_info:{status:"allowed"|"allowed_warning"|"rejected", resetsAt?:number, utilization?:number, errorCode?:"credits_required", canUserPurchaseCredits?, hasChargeableSavedPaymentMethod?, overageEnabled?}, uuid, session_id}`
  - `errorCode:"credits_required"` means the subscription's included usage is exhausted.
  - `overageEnabled` on warnings needs v2.1.295 or later.
  - `resetsAt` is a number. The docs don't state the unit; I'd assume epoch seconds, so verify empirically.
- **Retries:** `system/api_retry` has `{attempt, max_retries, retry_delay_ms, error_status, error}`. The `error` field is one of: `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown`.
- **Assistant message:** `error` uses the same set of values. A 429 quota error is `rate_limit`.
- **Result message:** has `is_error`, `api_error_status` (e.g. 429), `terminal_reason` ("api_error"), and `errors[]` on error subtypes.
- **Human-readable messages** (appear in the `result` text in json/stream-json mode):
  - "You've hit your session limit · resets 3:45pm"
  - "You've hit your weekly limit · resets Mon 12:00am"
  - "You've hit your Opus limit" / "You've hit your Sonnet limit" (per model family; switching family keeps you working)
  - Warning: "You've used 85% of your session limit · resets 3:45pm"
  - The session and weekly limits apply at the same time.
- **Plan for the backend:** key pauses on `rate_limit_event.status=="rejected"` plus `resetsAt`, and fall back to parsing the "resets …" text.
- **CLI-side waiting:** env vars `CLAUDE_CODE_RETRY_WATCHDOG`, `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` and `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` control whether the CLI waits for a plan limit to reset. I couldn't read their full descriptions (truncated page), so verify them.
- **Usage in the status line:** a custom status line also gets `rate_limits` fields (interactive only).

## 5. Token and usage data reported
- **Result fields:**
  - `total_cost_usd` (a client-side estimate, not a bill)
  - `usage` (main loop only, excludes subagents): `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens_details.thinking_tokens`
  - `modelUsage[model]` = `{inputTokens, outputTokens, thinkingTokens?, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens, canonicalModel?, provider?, costBasis?}`. This includes subagents and compaction, and the docs recommend it for accounting.
  - `num_turns`, `duration_ms`, `duration_api_ms`, `permission_denials[]`
- **Totals across turns:** in streaming-input sessions `modelUsage` is cumulative. `--resume` reports the conversation's whole total, so take differences rather than summing.
- **During a run:** `task_progress.usage` gives `total_tokens`, `tool_uses` and `duration_ms` per subagent. Sending `/usage` as a prompt returns its output as an assistant message.
- **What the CLI does NOT give:** a remaining-quota percentage, except `rate_limit_info.utilization` on rate-limit events.

## 6. Permission and tool flags for unattended runs
- **Default mode:** with v2.1.302 or later, `-p` starts in Manual mode, and anything needing approval is denied unless approved some other way.
- **Ways to approve:**
  - `--allowedTools "Read,Edit,Bash(git diff *)"` / `--disallowedTools`
  - `--permission-mode acceptEdits | auto | dontAsk | bypassPermissions | plan`
  - `--dangerously-skip-permissions`, which the CLI rejects when run as root, so run the container as a non-root user
  - `--permission-prompt-tool <mcp tool>` or a PermissionRequest hook
  - `--permission-prompts none` (v2.1.259+), which removes AskUserQuestion and denies prompts without waiting; the persistent equivalent is the setting `permissions.denyInsteadOfPrompting`
- **Visibility:** denials appear as `permission_denied` events and in `result.permission_denials`.
- **Background work:** `-p` waits up to 10 minutes for it (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`).
- **Security notes:**
  - Without `--bare`, `-p` runs project hooks and `.mcp.json` servers with no trust prompt. Use `--strict-mcp-config` and managed settings at `/etc/claude-code/managed-settings.json`.
  - Under skip-permissions, a malicious repo can steal `~/.claude` credentials. Pair it with an egress firewall (Anthropic's reference `init-firewall.sh`) and use trusted repos only.

## Sources

- [Claude Code docs – Legal and compliance (auth & credential use)](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Code docs – Run Claude Code programmatically (headless)](https://code.claude.com/docs/en/headless)
- [Claude Code docs – Authentication (credential storage, precedence, setup-token)](https://code.claude.com/docs/en/authentication)
- [Claude Code docs – Development containers (persist auth, skip-permissions)](https://code.claude.com/docs/en/devcontainer)
- [Agent SDK TypeScript reference (SDKResultMessage, SDKRateLimitEvent, ModelUsage)](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Claude Code docs – Errors (usage limits messages)](https://code.claude.com/docs/en/errors)
- [Anthropic Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms)
