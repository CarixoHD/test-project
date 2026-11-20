import { decodeTime, isValid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.ts';
import { FakeIdGen, createIdGen } from './id-gen.ts';

describe('createIdGen', () => {
  it('produces valid ULIDs stamped with the clock time', () => {
    const ids = createIdGen(new FakeClock(1_700_000_000_000));
    const id = ids.next('issue');
    expect(isValid(id)).toBe(true);
    expect(decodeTime(id)).toBe(1_700_000_000_000);
  });

  it('is strictly increasing within the same millisecond, across kinds', () => {
    const ids = createIdGen(new FakeClock(1_700_000_000_000));
    const seq = [ids.next('product'), ids.next('issue'), ids.next('issue'), ids.next('agent')];
    expect([...seq].sort()).toEqual(seq);
    expect(new Set(seq).size).toBe(seq.length);
  });
});

describe('FakeIdGen', () => {
  it('produces readable, sortable, deterministic ids', () => {
    const a = new FakeIdGen();
    const b = new FakeIdGen();
    const fromA = [a.next('product'), a.next('issue'), a.next('issue')];
    expect(fromA).toEqual([b.next('product'), b.next('issue'), b.next('issue')]);
    expect(fromA[0]).toMatch(/^product-/);
    expect([...fromA].sort((x, y) => x.slice(-6).localeCompare(y.slice(-6)))).toEqual(fromA);
    expect(new Set(fromA).size).toBe(3);
  });
});
