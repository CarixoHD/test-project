import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// Proves the module-boundary rules in eslint.config.js (CODING_STANDARDS.md §4).
const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });

async function restrictedRuleIds(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'fatal');
}

// Loading the config, parser and plugins cold can exceed the 5s per-test timeout
// when the full suite runs in parallel, so pay that cost once here.
const WARM_UP_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  await eslint.lintText('export {};\n', { filePath: 'src/shared/warm-up.ts' });
}, WARM_UP_TIMEOUT_MS);

describe('module boundaries', () => {
  it.each([
    ['src/shared/a.ts', "import 'node:fs';\n"],
    ['src/shared/a.ts', "import 'fs';\n"],
    ['src/shared/a.ts', "import '../server/main.ts';\n"],
    ['src/shared/deep/a.ts', "import '../../web/App.tsx';\n"],
    ['src/web/a.tsx', "import '../server/main.ts';\n"],
    ['src/web/features/board/a.tsx', "import '../../../server/main.ts';\n"],
    ['src/server/a.ts', "import 'node:child_process';\n"],
    ['src/server/git/git.ts', "import { execFile } from 'child_process';\n"],
    ['src/server/sandbox/a.test.ts', "import { spawn } from 'node:child_process';\n"],
  ])('%s rejects %s', async (filePath, code) => {
    expect(await restrictedRuleIds(filePath, code)).toContain('no-restricted-imports');
  });

  it.each([
    ['src/shared/a.ts', "import './events.ts';\n"],
    ['src/web/a.tsx', "import '../shared/events.ts';\n"],
    ['src/web/a.tsx', "import 'react-dom/server';\n"],
    ['src/server/a.ts', "import 'node:fs';\n"],
    ['src/server/a.ts', "import '../shared/events.ts';\n"],
    ['src/server/util/exec.ts', "import 'node:child_process';\n"],
  ])('%s allows %s', async (filePath, code) => {
    expect(await restrictedRuleIds(filePath, code)).toEqual([]);
  });

  it.each([
    [
      "await import('node:child_process')",
      "export const m = await import('node:child_process');\n",
    ],
    ["require('child_process')", "export const m = require('child_process');\n"],
  ])('src/server rejects %s outside util/exec.ts', async (_name, code) => {
    expect(await restrictedRuleIds('src/server/a.ts', code)).toContain('no-restricted-syntax');
  });

  it.each([
    ['Date.now', 'export const t = Date.now();\n', 'no-restricted-properties'],
    ['Math.random', 'export const r = Math.random();\n', 'no-restricted-properties'],
    ['fetch', "export const p = fetch('x');\n", 'no-restricted-globals'],
  ])('src/shared rejects %s', async (_name, code, ruleId) => {
    expect(await restrictedRuleIds('src/shared/a.ts', code)).toContain(ruleId);
  });

  // ADR 3: only src/server/llm and the API agent backend touch the AI SDK.
  it.each([
    ['src/server/pipeline/a.ts', "export { generateText } from 'ai';\n"],
    [
      'src/server/agents/claude-code-backend.ts',
      "export { MockLanguageModelV4 } from 'ai/test';\n",
    ],
    ['src/server/http/a.ts', "export { createAnthropic } from '@ai-sdk/anthropic';\n"],
    ['src/shared/a.ts', "export { tool } from 'ai';\n"],
    ['src/web/a.tsx', "export { streamText } from 'ai';\n"],
    ['scripts/a.ts', "export { generateText } from 'ai';\n"],
  ])('%s may not import the AI SDK: %s', async (filePath, code) => {
    expect(await restrictedRuleIds(filePath, code)).toContain('no-restricted-imports');
  });

  it.each([
    ['src/server/llm/registry.ts', "export { generateText } from 'ai';\n"],
    ['src/server/llm/deep/a.ts', "export { createOpenAI } from '@ai-sdk/openai';\n"],
    ['src/server/agents/api-backend.ts', "export { streamText } from 'ai';\n"],
    ['src/server/pipeline/a.ts', "export { aiThing } from './ai.ts';\n"],
    ['src/server/pipeline/a.ts', "export { x } from 'aim';\n"],
  ])('%s may import %s', async (filePath, code) => {
    expect(await restrictedRuleIds(filePath, code)).toEqual([]);
  });

  it('src/shared keeps its own boundaries next to the AI SDK rule', async () => {
    expect(await restrictedRuleIds('src/shared/a.ts', "import 'node:fs';\n")).toContain(
      'no-restricted-imports',
    );
  });
});
