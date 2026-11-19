import { generateText, jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { fakeModel } from './index.ts';

const finishTool = tool({
  description: 'Report the result',
  inputSchema: jsonSchema<{ summary: string }>({
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  }),
});

describe('fakeModel', () => {
  it('replays scripted text turns in order through generateText', async () => {
    const model = fakeModel([{ text: 'first' }, { text: 'second' }]);

    const a = await generateText({ model, prompt: 'go' });
    const b = await generateText({ model, prompt: 'again' });

    expect(a.text).toBe('first');
    expect(b.text).toBe('second');
  });
});
