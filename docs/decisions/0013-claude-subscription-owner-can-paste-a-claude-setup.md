# 0013. Claude subscription: owner can paste a `claude setup-token` token in Settings (amends ADR 4)

Date: 2026-11-20 · Status: Accepted

## Context

The owner wants to use Claude by pasting their subscription token into Vibecode, with no terminal steps. ADR 4 rejected this option because storing a subscription token could count as Vibecode "storing or intermediating" credentials. Facts: `claude setup-token` mints a 1-year OAuth token that Anthropic documents for CI and scripts. The official CLI reads it from CLAUDE_CODE_OAUTH_TOKEN. Anthropic's own GitHub Action tells users to store that token as a repository secret. Vibecode is self-hosted and single-user, so its secrets table is the owner's own secret store on the owner's own machine. The PRD's hard rule is narrower: never use subscription tokens to call the Anthropic API directly or through the Agent SDK.

## Options considered

- **Keep ADR 4 as is (volume login only)**: Lowest ToS risk, but the owner has to run three docker commands in a terminal. They explicitly don't want that.
- **Paste a setup-token in Settings; only the unmodified CLI uses it via CLAUDE_CODE_OAUTH_TOKEN**: Write-only secret, same handling as API keys and git tokens. Passed to `claude -p` in the container through the exec environment, never through argv. The volume login stays as a fallback. No direct API calls.
- **Use the token to call the Anthropic API or Agent SDK directly**: Explicitly forbidden by the PRD and by Anthropic. Rejected.

## Decision

Add an optional, write-only "Claude subscription token" (from `claude setup-token`) to Settings → Claude Code. It is stored in `secrets` and registered with the redactor. Reads show only whether it is set and its last 4 characters. When it is set, every Claude Code run gets CLAUDE_CODE_OAUTH_TOKEN through the container exec environment (`docker exec -e NAME`, with the value in the docker CLI's process env and never in argv). The CLI is still unmodified and still runs without --bare, and ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN stay unset. Saving or replacing the token clears needs_login. Without a token, the existing volume login (ADR 4) still works. Vibecode never uses the token for anything except passing it to the official CLI.

## Rationale

This is the owner's explicit request, on their own single-user, self-hosted install, with their own account. The token only ever reaches Anthropic's unmodified binary through the documented CI mechanism, which matches how Anthropic's own GitHub Action handles it. The PRD rule (no direct API or SDK use of subscription tokens) still holds. Residual risk: a strict reading of "developers may not store … tokens" could still apply. The owner has been told this, and the volume login remains available for them. Also, code inside a Claude-backed container can read the token from its environment, which is the same exposure as the login volume today.

## Sources

- [Research: Claude Code headless under subscription](docs/research/how-can-the-platform-drive-the-official-claude-cod.md)
- [Claude Code docs – Authentication (setup-token, CLAUDE_CODE_OAUTH_TOKEN)](https://code.claude.com/docs/en/authentication)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
