import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import type { Tool } from 'ai';
import type { ModelRef, ProviderId } from '../../shared/models.ts';

/** What a provider can do (ADR 10). `subscription`: runs on the Claude Code CLI, not an API key. */
export type Capabilities = { tools: boolean; webSearch: boolean; subscription: boolean };

const API: Capabilities = { tools: true, webSearch: true, subscription: false };
const NO_SEARCH: Capabilities = { tools: true, webSearch: false, subscription: false };

const CAPABILITIES: Record<ProviderId, Capabilities> = {
  anthropic: API,
  openai: API,
  google: API,
  // Searches through the `:online` model variant: model(ref, {webSearch: true}).
  openrouter: API,
  // Ollama and custom endpoints have no native search.
  'openai-compatible': NO_SEARCH,
  fake: NO_SEARCH,
  // The CLI's built-in WebSearch/WebFetch, allowed for the orchestrator only.
  'claude-code': { tools: true, webSearch: true, subscription: true },
};

export function capabilities(ref: ModelRef): Capabilities {
  return { ...CAPABILITIES[ref.provider] };
}

/** Suggested key for the search tool in a ToolSet. */
export const WEB_SEARCH_TOOL_NAME = 'web_search';

/**
 * The provider-executed web search tool to add to the orchestrator's ToolSet, if the provider
 * has one. OpenRouter (`:online` model variant) and claude-code (CLI tool) search without one.
 */
export function webSearchTool(ref: ModelRef): Tool | undefined {
  switch (ref.provider) {
    case 'anthropic':
      return anthropic.tools.webSearch_20260318({});
    case 'openai':
      return openai.tools.webSearch({});
    case 'google':
      return google.tools.googleSearch({});
    case 'openrouter':
    case 'openai-compatible':
    case 'fake':
    case 'claude-code':
      return undefined;
  }
}
