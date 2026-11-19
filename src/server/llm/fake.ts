import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

/*
 * Scripted fake provider (ADR 3). Built on `MockLanguageModelV4` from `ai/test` (ai 7.0.x).
 * Each model call (doGenerate or doStream) consumes the next turn of the script.
 */

export const FakeTurnSchema = z.strictObject({
  text: z.string().optional(),
});
export const FakeScriptSchema = z.array(FakeTurnSchema);
export type FakeTurn = z.infer<typeof FakeTurnSchema>;
export type FakeScript = z.infer<typeof FakeScriptSchema>;

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type Content = GenerateResult['content'][number];

export function fakeModel(script: FakeScript): MockLanguageModelV4 {
  const turns = FakeScriptSchema.parse(script);
  let cursor = 0;
  const next = (): FakeTurn => {
    const turn = turns[cursor];
    if (turn === undefined) {
      throw new Error(`Fake script exhausted: all ${turns.length} turns were used`);
    }
    cursor += 1;
    return turn;
  };

  return new MockLanguageModelV4({
    provider: 'fake',
    modelId: 'fake',
    doGenerate: async () => {
      const turn = next();
      const content: Content[] = [];
      if (turn.text !== undefined) content.push({ type: 'text', text: turn.text });
      return {
        content,
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}
