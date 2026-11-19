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
  ])('%s rejects %s', async (filePath, code) => {
    expect(await restrictedRuleIds(filePath, code)).toContain('no-restricted-imports');
  });

  it.each([
    ['src/shared/a.ts', "import './events.ts';\n"],
    ['src/web/a.tsx', "import '../shared/events.ts';\n"],
    ['src/web/a.tsx', "import 'react-dom/server';\n"],
    ['src/server/a.ts', "import 'node:fs';\n"],
    ['src/server/a.ts', "import '../shared/events.ts';\n"],
  ])('%s allows %s', async (filePath, code) => {
    expect(await restrictedRuleIds(filePath, code)).toEqual([]);
  });

  it.each([
    ['Date.now', 'export const t = Date.now();\n', 'no-restricted-properties'],
    ['Math.random', 'export const r = Math.random();\n', 'no-restricted-properties'],
    ['fetch', "export const p = fetch('x');\n", 'no-restricted-globals'],
  ])('src/shared rejects %s', async (_name, code, ruleId) => {
    expect(await restrictedRuleIds('src/shared/a.ts', code)).toContain(ruleId);
  });
});
