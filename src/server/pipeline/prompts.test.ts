import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderPrompt } from './index.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vibecode-prompts-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function template(name: string, text: string): Promise<void> {
  await writeFile(path.join(dir, `${name}.md`), text);
}

describe('renderPrompt', () => {
  it('substitutes every {{var}}, including repeats and inner whitespace', async () => {
    await template('greet', '# Hi {{name}}\n{{ name }} works on {{issue.title}}.\n');

    const out = renderPrompt('greet', { name: 'Ada', 'issue.title': 'Login' }, { dir });

    expect(out).toBe('# Hi Ada\nAda works on Login.\n');
  });

  it('throws naming the missing variable', async () => {
    await template('greet', 'Hi {{name}}, see {{prd}}');

    expect(() => renderPrompt('greet', { name: 'Ada' }, { dir })).toThrow(/greet.*prd/);
  });

  it('does not expand placeholders inside substituted values', async () => {
    await template('echo', 'Feedback: {{feedback}}');

    expect(renderPrompt('echo', { feedback: 'use {{secret}}' }, { dir })).toBe(
      'Feedback: use {{secret}}',
    );
  });

  it('keeps $ patterns in values literally', async () => {
    await template('echo', 'Run {{cmd}}');

    expect(renderPrompt('echo', { cmd: "echo $& $1 $$'" }, { dir })).toBe("Run echo $& $1 $$'");
  });

  it('rejects names that are not plain template names', () => {
    for (const name of ['../secret', 'a/b', '', 'Greet.md']) {
      expect(() => renderPrompt(name, {}, { dir })).toThrow(/prompt name/i);
    }
  });

  it('throws with context for an unknown template', () => {
    expect(() => renderPrompt('nope', {}, { dir })).toThrow(/nope/);
  });

  it('loads from src/server/pipeline/prompts by default', () => {
    expect(() => renderPrompt('does-not-exist', {})).toThrow(/prompts[/\\]does-not-exist\.md/);
  });
});
