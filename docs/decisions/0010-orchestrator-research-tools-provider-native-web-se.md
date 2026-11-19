# 0010. Orchestrator research tools: provider-native web search via a capability map

Date: 2026-11-19 · Status: Accepted

## Context

PRD open question: which web search or fetch capability agents use for research. Options are provider-native tools or a separate search API key.

## Options considered

- **Provider-native search via capability map**: No extra key; the cost is counted per search; not available on Ollama.
- **Search API key (Brave/Tavily) + host fetch_url**: Works with any model, but needs another key and an SSRF-guarded fetcher.
- **No research**: Simplest; weaker decisions.

## Decision

llm/capabilities.ts maps each provider to a native search tool:
- Anthropic: webSearch_20260318
- OpenAI: webSearch (Responses API)
- Google: googleSearch
- OpenRouter: the :online/web plugin
- Ollama and custom endpoints: none
The Claude Code backend allows the CLI's built-in WebSearch and WebFetch for the orchestrator only. Search calls are recorded in usage.web_searches and priced (Anthropic $10 per 1k). If the orchestrator's model has no search, the prompt says research is unavailable and it relies on prior knowledge. A pluggable search-API adapter is a possible follow-up.

## Rationale

This needs zero extra configuration for the common providers and works the same way through AI SDK provider-executed tools. Only the orchestrator researches, which keeps cost bounded.

## Sources

- [Research: stack and LLM abstraction (web search section)](docs/research/which-stack-and-llm-abstraction-best-fit-a-self-ho.md)
