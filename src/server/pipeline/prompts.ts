import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Agent prompt templates: `src/server/pipeline/prompts/<name>.md` (CODING_STANDARDS §4). */
export const PROMPTS_DIR = fileURLToPath(new URL('./prompts/', import.meta.url));

const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

/**
 * Loads the template `name` and replaces every `{{var}}` with `vars[var]` in one pass, so
 * placeholders inside substituted values (agent output, owner text) are never expanded.
 * A placeholder without a value throws: a half-filled prompt is a programmer error.
 */
export function renderPrompt(
  name: string,
  vars: Readonly<Record<string, string>>,
  opts: { dir?: string } = {},
): string {
  if (!NAME.test(name)) throw new Error(`Invalid prompt name ${JSON.stringify(name)}`);
  const file = path.join(opts.dir ?? PROMPTS_DIR, `${name}.md`);
  let template: string;
  try {
    template = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read prompt template ${file}`, { cause: err });
  }
  const missing = new Set<string>();
  const out = template.replace(PLACEHOLDER, (match, key: string) => {
    const value = Object.hasOwn(vars, key) ? vars[key] : undefined;
    if (value === undefined) missing.add(key);
    return value ?? match;
  });
  if (missing.size > 0) {
    throw new Error(`Prompt ${name}: missing variable(s) ${[...missing].join(', ')}`);
  }
  return out;
}
