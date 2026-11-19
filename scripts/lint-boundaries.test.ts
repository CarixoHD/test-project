import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Proves the module-boundary rules in eslint.config.js (CODING_STANDARDS.md §4).
const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });

async function restrictedRuleIds(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'fatal');
}

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
});
