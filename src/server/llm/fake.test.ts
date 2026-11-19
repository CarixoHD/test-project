import { APICallError, generateText, hasToolCall, jsonSchema, streamText, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { fakeModel } from './index.ts';

const finishTool = tool({
  description: 'Report the result',
  inputSchema: jsonSchema<{ summary: string }>({
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  }),
  execute: async () => 'recorded',
});

const readFileTool = tool({
  description: 'Read a file',
  inputSchema: jsonSchema<{ path: string }>({
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  }),
  execute: async ({ path }) => `contents of ${path}`,
});

async function callError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('fakeModel', () => {
  it('replays scripted text turns in order through generateText', async () => {
    const model = fakeModel([{ text: 'first' }, { text: 'second' }]);

    const a = await generateText({ model, prompt: 'go' });
    const b = await generateText({ model, prompt: 'again' });

    expect(a.text).toBe('first');
    expect(b.text).toBe('second');
  });

  it('replays tool calls across steps and ends with the finish tool', async () => {
    const model = fakeModel([
      { text: 'Reading.', toolCalls: [{ name: 'read_file', input: { path: 'README.md' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: 'done' } }] },
    ]);

    const result = await generateText({
      model,
      prompt: 'go',
      tools: { read_file: readFileTool, finish: finishTool },
      stopWhen: hasToolCall('finish'),
    });

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.text).toBe('Reading.');
    expect(result.steps[0]?.toolResults[0]?.output).toBe('contents of README.md');
    expect(result.finishReason).toBe('tool-calls');
    expect(result.steps[1]?.toolCalls).toEqual([
      expect.objectContaining({ toolName: 'finish', input: { summary: 'done' } }),
    ]);
  });

  it('fills {{var}} placeholders in text and nested tool input from vars', async () => {
    const model = fakeModel(
      [
        {
          text: 'Working on #{{issue.number}}: {{issue.title}}',
          toolCalls: [
            {
              name: 'finish',
              input: { summary: 'Closed #{{issue.number}}', files: ['src/{{ name }}.ts'] },
            },
          ],
        },
      ],
      { vars: { issue: { number: 11, title: 'LLM registry' }, name: 'registry' } },
    );

    const result = await generateText({ model, prompt: 'go', tools: { finish: finishTool } });

    expect(result.text).toBe('Working on #11: LLM registry');
    expect(result.toolCalls[0]?.input).toEqual({
      summary: 'Closed #11',
      files: ['src/registry.ts'],
    });
  });

  it('rejects a template that names an unknown variable', async () => {
    const model = fakeModel([{ text: 'Hi {{nobody}}' }], { vars: {} });

    const error = await callError(generateText({ model, prompt: 'go', maxRetries: 0 }));

    expect(String(error)).toContain('{{nobody}}');
  });

  it('streams the same script through streamText', async () => {
    const model = fakeModel(
      [
        {
          text: 'Issue {{issue.number}}',
          toolCalls: [{ name: 'finish', input: { summary: 'ok' } }],
          usage: { input: 10, output: 4 },
        },
      ],
      { vars: { issue: { number: 7 } } },
    );

    const result = streamText({ model, prompt: 'go', tools: { finish: finishTool } });

    expect(await result.text).toBe('Issue 7');
    expect(await result.toolCalls).toEqual([
      expect.objectContaining({ toolName: 'finish', input: { summary: 'ok' } }),
    ]);
    expect((await result.usage).inputTokens).toBe(10);
    expect((await result.usage).outputTokens).toBe(4);
  });

  it('reports scripted usage in AI SDK buckets (input/cache/reasoning)', async () => {
    const model = fakeModel([
      {
        text: 'x',
        usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 7 },
      },
    ]);

    const { usage } = await generateText({ model, prompt: 'go' });

    expect(usage.inputTokens).toBe(135);
    expect(usage.inputTokenDetails).toEqual({
      noCacheTokens: 100,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
    });
    expect(usage.outputTokens).toBe(27);
    expect(usage.outputTokenDetails).toEqual({ textTokens: 20, reasoningTokens: 7 });
  });

  it('defaults usage to zero tokens', async () => {
    const { usage } = await generateText({ model: fakeModel([{ text: 'x' }]), prompt: 'go' });
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });

  it('injects a retryable 429 with retry-after, then continues with the next turn', async () => {
    const model = fakeModel([{ error: { status: 429, retryAfterSeconds: 3 } }, { text: 'after' }]);

    const error = await callError(generateText({ model, prompt: 'go', maxRetries: 0 }));

    expect(APICallError.isInstance(error)).toBe(true);
    const apiError = error as APICallError;
    expect(apiError.statusCode).toBe(429);
    expect(apiError.isRetryable).toBe(true);
    expect(apiError.responseHeaders?.['retry-after']).toBe('3');
    expect((await generateText({ model, prompt: 'retry' })).text).toBe('after');
  });

  it('injects a non-retryable 401 in streamText', async () => {
    const model = fakeModel([{ error: { status: 401, message: 'invalid x-api-key' } }]);
    const errors: unknown[] = [];

    const result = streamText({
      model,
      prompt: 'go',
      maxRetries: 0,
      onError: ({ error }) => {
        errors.push(error);
      },
    });
    await result.consumeStream();

    expect(errors).toHaveLength(1);
    const apiError = errors[0] as APICallError;
    expect(APICallError.isInstance(apiError)).toBe(true);
    expect(apiError.statusCode).toBe(401);
    expect(apiError.isRetryable).toBe(false);
    expect(apiError.message).toBe('invalid x-api-key');
  });

  it('fails clearly when the script is exhausted', async () => {
    const model = fakeModel([{ text: 'only' }]);
    await generateText({ model, prompt: 'go' });

    const error = await callError(generateText({ model, prompt: 'more', maxRetries: 0 }));

    expect(String(error)).toMatch(/script exhausted/i);
  });

  it('validates the script up front', () => {
    expect(() => fakeModel([{ error: { status: 500 } }] as never)).toThrow();
  });
});
