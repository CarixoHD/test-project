import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS, type ProviderId } from '../../shared/models.ts';
import { capabilities, webSearchTool } from './index.ts';

const EXPECTED: Record<
  ProviderId,
  { caps: ReturnType<typeof capabilities>; searchToolId: string | undefined }
> = {
  anthropic: {
    caps: { tools: true, webSearch: true, subscription: false },
    searchToolId: 'anthropic.web_search_20260318',
  },
  openai: {
    caps: { tools: true, webSearch: true, subscription: false },
    searchToolId: 'openai.web_search',
  },
  google: {
    caps: { tools: true, webSearch: true, subscription: false },
    searchToolId: 'google.google_search',
  },
  // Search is the `:online` model variant (see model(ref, {webSearch: true})), not a tool.
  openrouter: {
    caps: { tools: true, webSearch: true, subscription: false },
    searchToolId: undefined,
  },
  'openai-compatible': {
    caps: { tools: true, webSearch: false, subscription: false },
    searchToolId: undefined,
  },
  fake: { caps: { tools: true, webSearch: false, subscription: false }, searchToolId: undefined },
  // The CLI brings its own WebSearch/WebFetch; no API tool is attached.
  'claude-code': {
    caps: { tools: true, webSearch: true, subscription: true },
    searchToolId: undefined,
  },
};

describe('capabilities', () => {
  it('has an expectation for every ProviderId', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PROVIDER_IDS].sort());
  });

  it.each(PROVIDER_IDS)('%s has the ADR 10 capabilities', (provider) => {
    expect(capabilities({ provider, model: 'some-model' })).toEqual(EXPECTED[provider].caps);
  });

  it.each(PROVIDER_IDS)('%s maps to its provider-native web search tool (or none)', (provider) => {
    const searchTool = webSearchTool({ provider, model: 'some-model' });
    const id = searchTool?.type === 'provider' ? searchTool.id : undefined;
    expect(searchTool === undefined ? undefined : id).toBe(EXPECTED[provider].searchToolId);
  });

  it('returns a copy so callers cannot change the table', () => {
    const caps = capabilities({ provider: 'fake', model: 'x' });
    caps.webSearch = true;
    expect(capabilities({ provider: 'fake', model: 'x' }).webSearch).toBe(false);
  });
});
