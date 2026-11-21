import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isGone } from './process.ts';

/** A positive pid that is not running right now. */
const unusedPid = (): number => {
  const used = new Set(readdirSync('/proc').map(Number));
  let pid = 1;
  while (used.has(pid)) pid++;
  return pid;
};

describe('isGone', () => {
  it('reports a live process as not gone', () => {
    expect(isGone(process.pid)).toBe(false);
  });

  it('reports a pid that is not running as gone', () => {
    expect(isGone(unusedPid())).toBe(true);
  });
});
