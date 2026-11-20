import { describe, expect, it } from 'vitest';
import { pruneCommand, staleImageTags } from './prune-images.ts';

const BASE_NOW = 'vibecode/base:aaaaaaaaaaaa';
const CLAUDE_NOW = `vibecode/claude-code:${'c'.repeat(64)}`;
const CURRENT = [BASE_NOW, CLAUDE_NOW];

describe('staleImageTags', () => {
  it('keeps the current hashed tags', () => {
    expect(staleImageTags([BASE_NOW, CLAUDE_NOW], CURRENT)).toEqual([]);
  });

  it('returns plain/latest and old hashed tags of vibecode/base and vibecode/claude-code', () => {
    const old = [
      'vibecode/base:latest',
      'vibecode/base:bbbbbbbbbbbb',
      'vibecode/claude-code:latest',
      `vibecode/claude-code:${'d'.repeat(64)}`,
    ];
    expect(staleImageTags([BASE_NOW, ...old, CLAUDE_NOW], CURRENT)).toEqual(old);
  });

  it('ignores other repositories, including product images', () => {
    const others = [
      'vibecode/p-01abc:1234',
      'vibecode/p-01abc-claude:5678',
      'vibecode/base-extra:latest',
      'debian:bookworm',
      'registry.example/vibecode/base:latest',
    ];
    expect(staleImageTags(others, CURRENT)).toEqual([]);
  });

  it('ignores <none> entries and blank lines', () => {
    expect(staleImageTags(['<none>:<none>', 'vibecode/base:<none>', '', '  '], CURRENT)).toEqual(
      [],
    );
  });

  it('lists each stale tag once, trimmed', () => {
    expect(staleImageTags([' vibecode/base:latest ', 'vibecode/base:latest'], CURRENT)).toEqual([
      'vibecode/base:latest',
    ]);
  });
});

describe('pruneCommand', () => {
  it('is one docker image rm line for the stale tags', () => {
    expect(pruneCommand(['vibecode/base:latest', 'vibecode/claude-code:latest'])).toBe(
      'docker image rm vibecode/base:latest vibecode/claude-code:latest\n',
    );
  });

  it('is empty when nothing is stale', () => {
    expect(pruneCommand([])).toBe('');
  });
});
