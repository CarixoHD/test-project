# Which stack and LLM abstraction best fit a self-hosted single-user TypeScript (or Python) server with pluggable providers (Anthropic, OpenAI, Gemini, OpenRouter, OpenAI-compatible/Ollama, plus a fake scripted provider)? Compare e.g. Vercel AI SDK, LiteLLM, Mastra, and a thin custom adapter. Criteria: tool calling, streaming, token usage reporting, provider-native web search, a model price table for USD cost, and how easy it is to test with a mock provider.

Date: 2026-11-19 · Confidence: high

## Recommendation

Use TypeScript on Node 22+ (ESM) with Vercel AI SDK v7 (pinned exact versions) as the provider layer, behind a small internal `LlmProvider` interface owned by Slopper. Don't adopt Mastra or LiteLLM.

Concretely:
- Registry: map providerId to an AI SDK model factory: @ai-sdk/anthropic, @ai-sdk/openai, @ai-sdk/google, @openrouter/ai-sdk-provider (or @ai-sdk/openai-compatible pointed at the OpenRouter base URL), @ai-sdk/openai-compatible for Ollama/custom, and a `fake` provider built on MockLanguageModelV4 (or a custom LanguageModelV4) that plays back scripted turns: text, tool calls, usage and stream chunks.
- Agent loop: write our own loop using streamText with tools and stopWhen, or use ToolLoopAgent, but keep stepping, budget checks and approvals in our code so roles share one loop.
- Web search: a per-provider capability map (anthropic.tools.webSearch_20260318, openai.tools.webSearch, google.tools.googleSearch, OpenRouter web plugin, none for Ollama), exposed as a single `webSearch: boolean` model capability.
- Cost: a versioned, checked-in price table generated from models.dev api.json (USD per 1M; input, output, cache_read, cache_write, reasoning), applied to AI SDK's normalized per-step usage. User overrides are allowed. Unknown models are flagged as "unpriced" and never silently treated as $0, except Ollama, which is $0. When OpenRouter's response includes usage.cost, prefer it. Count web-search calls separately (e.g. Anthropic $10 per 1k).
- Tests: unit tests use the fake provider. Optionally add contract tests with recorded fixtures per provider.
- Version stability: wrap AI SDK so a future v8 rename touches only the adapter.

If the team strongly prefers Python, use LiteLLM, but only at ≥1.106.2 excluding 1.107.0, with hash-pinned installs and a vendored price JSON (LITELLM_LOCAL_MODEL_COST_MAP). Given the two 2026 compromises, I'd rank it a clear second.

## Findings

State as of 2026-11-19.

1) Vercel AI SDK (TypeScript, Apache-2.0). Current major is v7 (stable 2026-06-25; ai 7.0.8 by 2026-06-30). v6 came out Dec 2025. v7 requires Node 22+ and ESM only. Renames in v7: system→instructions, fullStream→stream, onFinish→onEnd, needsApproval→toolApproval. OpenTelemetry moved to @ai-sdk/otel.
- Tool calling: generateText/streamText with zod tools and stopWhen loop control. ToolLoopAgent (from v6; the default stop is stepCountIs(20)). v7 adds tool approval policies, timeouts, runtimeContext/toolsContext, lifecycle callbacks and WorkflowAgent for durable runs.
- Streaming: streamText returns a typed part stream (text, reasoning, tool-input deltas, tool results, finish).
- Usage: normalized across providers. inputTokens{total,noCache,cacheRead,cacheWrite} and outputTokens{total,text,reasoning}. In v7, top-level usage adds up across all steps and the last step's data is under finalStep. Anthropic cache-write tokens are now in the standard fields. Steps also report latency and tokens per second.
- Provider-native web search, as provider-executed tools: anthropic.tools.webSearch_20260318 (older _20260209 and _20250305 still exist; options maxUses, allowed/blockedDomains, userLocation; costs $10 per 1k searches), openai.tools.webSearch() (Responses API; webSearchPreview is deprecated), google.tools.googleSearch() (Google's grounding terms require showing the search suggestions). Each provider has its own tool, so the platform needs a thin `webSearch` capability map per provider.
- Providers: @ai-sdk/anthropic, @ai-sdk/openai, @ai-sdk/google, @ai-sdk/openai-compatible (works for Ollama, LM Studio, vLLM), and @openrouter/ai-sdk-provider (community package; its docs don't describe passing through usage or cost).
- Price table: none built in. Usage has to be multiplied by a price table you supply.
- Testing: `ai/test` provides MockLanguageModelV4 (doGenerate/doStream can be a scripted array of responses, and doGenerateCalls lets tests assert on the prompts sent), mockValues, mockId, and simulateReadableStream from `ai`. A fake scripted provider is therefore simple: implement the LanguageModelV4 spec, or wrap the mock behind a "fake" provider ID. Tests need no network or API key.

2) Mastra (TypeScript; @mastra/core 1.0 on 2026-01-20, 1.83.0 on 2026-11-12). Built on AI SDK and supports AI SDK v6 LanguageModelV3 models. Adds a "provider/model" string router that reads API keys from env vars, plus workflows, memory, storage, a studio UI, evals, server adapters (Hono/Express/Fastify/Koa) and a hosted Gateway. Tool calling, streaming and usage come from AI SDK underneath. It ships no USD budget layer of its own that we need. Downsides: a large dependency surface, very fast churn (83 minor releases in 10 months), and opinions that may clash with Slopper's own orchestrator/agent-loop design. Its value (workflows, memory, studio) overlaps with what we are building ourselves. It may also lag AI SDK majors: the 1.0 notes cite v6, and v7 support in Mastra is unconfirmed.

3) LiteLLM (Python SDK plus proxy, MIT core). Its strengths are an OpenAI-format API for 100+ providers, built-in cost calculation (completion_cost) from model_prices_and_context_window.json (about 3,850 models; auto-sync from GitHub; the proxy also has budgets), and support for streaming and tool calls. Risks:
- The PyPI and Docker release pipeline was compromised twice in 2026: 1.82.7/1.82.8 on 2026-03-24 (TeamPCP, credential stealer via a .pth startup hook) and 1.107.0 on 2026-10-21 (credential theft plus RCE loader). Wiz names 1.106.2 as the last safe version. Tracked as OSV MAL-2026-2144.
- A malformed price-map entry once made LiteLLM silently fall back to a stale cost map.
- By default it fetches the price map from GitHub at runtime.
- Everything is squeezed into the OpenAI chat shape, so provider-native features (Anthropic server tools, Gemini grounding, caching details) work less well.
- It forces Python, or running the proxy as a sidecar.
Testing works through mock_response=..., but scripting multi-step tool flows is clumsier than with AI SDK.

4) Thin custom adapter. Five providers mean three wire protocols (Anthropic Messages, OpenAI Chat/Responses, which covers OpenRouter and Ollama, and Gemini) plus three SSE parsers. You would also have to write and maintain tool-call delta assembly, reasoning/cache usage normalization, and the web-search tool schemas yourself, and track every API change. That is realistic in about 1.5–3k LOC but becomes ongoing maintenance. Its only clear benefit is full control, and you get most of that by putting our own interface in front of AI SDK.

Price data: models.dev (sst/models.dev, MIT, used by opencode) publishes https://models.dev/api.json with cost.input, output, cache_read, cache_write, reasoning and audio, all in USD per 1M tokens, across many providers including openrouter and ollama. LiteLLM's JSON (MIT) is an alternative source. OpenRouter returns `usage.cost` (credits, effectively USD) and cost_details on every response by default, which is an authoritative cost when routing through OpenRouter. Local Ollama models should be priced at $0.

## Sources

- [AI SDK 7 changelog (Vercel)](https://vercel.com/changelog/ai-sdk-7)
- [AI SDK 6 announcement](https://vercel.com/blog/ai-sdk-6)
- [AI SDK Testing docs (MockLanguageModelV4)](https://ai-sdk.dev/docs/ai-sdk-core/testing)
- [AI SDK Anthropic provider (web search tools)](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)
- [AI SDK OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)
- [AI SDK Tools foundations](https://ai-sdk.dev/docs/foundations/tools)
- [AI SDK OpenRouter community provider](https://ai-sdk.dev/providers/community-providers/openrouter)
- [Announcing Mastra 1.0](https://mastra.ai/blog/announcing-mastra-1)
- [Mastra changelog 2026-01-20](https://mastra.ai/blog/changelog-2026-01-20)
- [Mastra guide (1.83.0 on 2026-11-12)](https://cadenya.com/other-content/mastra-for-ai-agents)
- [LiteLLM auto-sync model cost map](https://docs.litellm.ai/docs/proxy/sync_models_github)
- [LiteLLM cost map incident](https://docs.litellm.ai/blog/model-cost-map-incident)
- [Microsoft: LiteLLM 1.107.0 supply chain compromise](https://www.microsoft.com/en-us/security/blog/2026/10/23/inside-the-litellm-1-107-0-supply-chain-compromise-credential-theft-through-python-startup-hooks/)
- [Datadog: LiteLLM compromised on PyPI (March 2026)](https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-teampcp-supply-chain-campaign/)
- [Help Net Security: second LiteLLM attack](https://www.helpnetsecurity.com/2026/10/22/litellm-compromised-supply-chain-attack-pypi-docker/)
- [OpenRouter usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting)
- [models.dev repo (MIT, api.json schema)](https://github.com/sst/models.dev)
