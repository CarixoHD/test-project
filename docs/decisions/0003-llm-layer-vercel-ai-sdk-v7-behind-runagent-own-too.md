# 0003. LLM layer: Vercel AI SDK v7 behind runAgent, own tool loop, fake scripted provider, models.dev price table

Date: 2026-11-19 · Status: Accepted

## Context

The PRD requires pluggable providers selectable per role (Anthropic, OpenAI, Gemini, OpenRouter, OpenAI-compatible/Ollama), tool calling, token usage and USD cost, a budget, and a fake provider for CI and demo mode.

## Options considered

- **Vercel AI SDK v7 behind our runAgent**: Normalized usage, streaming, tools; MockLanguageModelV4 for fakes; provider-native web search tools; no price table.
- **Mastra**: Large surface with very fast churn; its workflow and memory features overlap with ours; AI SDK v7 support unconfirmed.
- **LiteLLM (Python)**: Built-in prices, but forces Python, had compromised releases in 2026, and handles provider-native tools poorly.
- **Thin custom adapter**: 1.5–3k LOC across three wire protocols, plus ongoing maintenance.

## Decision

Use `ai` 7.x with @ai-sdk/anthropic, @ai-sdk/openai, @ai-sdk/google and @ai-sdk/openai-compatible, pinned exactly. OpenRouter goes through openai-compatible at its base URL, which avoids the community package; usage.cost from provider metadata is preferred when present. Only `src/server/llm` and `src/server/agents/api-backend.ts` import `ai`. Agents use our own step loop (streamText per step) with tools read_file, write_file, edit_file, list_dir, grep, run and finish(schema). shouldStop is checked between steps. The loop runs on the host and executes tools in the container. A `fake` provider built on MockLanguageModelV4 replays JSON scripts and drives tests and demo mode (VIBECODE_DEMO=1). Cost comes from a checked-in prices.json generated from models.dev api.json by scripts/update-prices.mjs, plus user overrides in settings. Ollama is $0. Unknown models are marked `unpriced` and never treated as $0.

## Rationale

This is the research's high-confidence recommendation. AI SDK normalizes usage (cache read/write, reasoning) across providers, and its mock models make scripted multi-step tool flows trivial, with no network. Keeping the loop in our code means one loop for all API-backed roles, budget and pause checks between steps, and API keys that never enter containers. Wrapping the SDK limits any future v8 rename to one module.

## Sources

- [Research: stack and LLM abstraction](docs/research/which-stack-and-llm-abstraction-best-fit-a-self-ho.md)
- [AI SDK](https://ai-sdk.dev/docs)
- [models.dev price data](https://models.dev/api.json)
