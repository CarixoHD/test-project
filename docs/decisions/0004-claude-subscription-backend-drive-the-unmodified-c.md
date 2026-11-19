# 0004. Claude subscription backend: drive the unmodified Claude Code CLI headless in the agent container

Date: 2026-11-19 · Status: Accepted

## Context

PRD open question. The owner wants to use their Claude Pro/Max subscription. Anthropic's terms forbid third-party apps from collecting, storing or intermediating subscription credentials, or from calling the API with OAuth tokens. The terms explicitly allow an end user to sign in to the unmodified Claude Code binary with their own subscription, including when a platform hosts it, for ordinary individual use.

## Options considered

- **Run official `claude -p` in the agent container; owner logs in once into a named volume**: ToS-compliant single-owner design; Vibecode never touches credentials.
- **Owner pastes a `claude setup-token` token into Vibecode settings**: Vibecode would store and inject a subscription token, which arguably counts as storing or intermediating credentials. Rejected.
- **Extract OAuth tokens and call the API or Agent SDK directly**: Explicitly forbidden and a ban risk. Rejected.

## Decision

Provider id `claude-code` selects ClaudeCodeBackend. The image vibecode/claude-code layers a pinned `@anthropic-ai/claude-code` (2.1.329 at the time of writing) with DISABLE_AUTOUPDATER=1 and a non-root user. Claude-backed runs use a derived image FROM the product image (which must be Debian/glibc). The named volume `vibecode-claude-config` is mounted at /home/agent/.claude with CLAUDE_CONFIG_DIR pointing there. The owner logs in once with `docker run -it … claude auth login`; the Settings page shows the command. Vibecode never reads the volume, never sets ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for these runs, and never uses --bare. The invocation is `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools <role list> --permission-prompts none --strict-mcp-config --max-turns N --json-schema <result schema> --model <m>`, with the prompt on stdin and SIGINT to stop. The NDJSON output is mapped as follows:
- `rate_limit_event{status:'rejected', resetsAt}` becomes backend.limited for the whole account. Fallbacks are api_retry error=rate_limit and the "resets …" text.
- `authentication_failed` or "Login expired" becomes needs_login plus an inbox item.
- `modelUsage` becomes usage rows with billing=subscription: tokens and calls, plus costUSD stored only as an estimate.
Claude containers need egress (vibecode-egress bridge). Orchestrator runs may use the CLI's built-in WebSearch and WebFetch. The issue that implements this must verify the resetsAt unit, the --json-schema behaviour and the flag names against the pinned version, using recorded fixture streams.

## Rationale

This is the only option within Anthropic's published rules. The owner authenticates through Anthropic's own flow into the unmodified binary, and Vibecode only spawns it. Rate limits are modelled per backend account, not per product, because the subscription limit is per account. Default parallelism (3) keeps usage closer to "ordinary, individual". A known risk, documented: a malicious dependency in a Claude-backed container could read the login volume. The mitigations are trusted product code only and a follow-up for an egress allowlist proxy.

## Sources

- [Research: Claude Code headless under subscription](docs/research/how-can-the-platform-drive-the-official-claude-cod.md)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
