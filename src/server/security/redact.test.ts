import { describe, expect, it } from 'vitest';
import { Redactor, redactor } from './index.ts';

const LONG = 'sk-ant-api03-abcdefghijklmnop1234'; // ≥ 16 chars → ***last4
const MEDIUM = 'tok-9876'; // 8–15 chars → [REDACTED]

describe('Redactor', () => {
  it.each([
    ['long secret keeps only last 4', [LONG], `key=${LONG}`, 'key=***1234'],
    ['medium secret fully hidden', [MEDIUM], `t ${MEDIUM} t`, 't [REDACTED] t'],
    ['every occurrence', [LONG], `${LONG} ${LONG}`, '***1234 ***1234'],
    ['values shorter than 8 are ignored', ['short12'], 'short12', 'short12'],
    ['empty value is ignored', [''], 'abc', 'abc'],
    [
      'regex metacharacters are literal',
      ['a.b*c+d?(e)[f]$^|\\'],
      'a.b*c+d?(e)[f]$^|\\',
      '***$^|\\',
    ],
    ['metachar value does not match as a pattern', ['a.b*c+d?'], 'aXbbbcdd', 'aXbbbcdd'],
    [
      'longer secret wins over its own substring',
      [MEDIUM, `${MEDIUM}-and-more-stuff`],
      `${MEDIUM}-and-more-stuff`,
      '***tuff',
    ],
    ['duplicate registration is harmless', [LONG, LONG], LONG, '***1234'],
    ['no registered secrets leaves text as is', [], `x ${LONG}`, `x ${LONG}`],
    ['multiline text', [LONG], `a\n${LONG}\nb`, 'a\n***1234\nb'],
  ])('%s', (_name, values, text, expected) => {
    const r = new Redactor();
    for (const v of values) r.register(v);
    expect(r.redact(text)).toBe(expected);
  });

  it('applies to secrets registered after earlier redactions', () => {
    const r = new Redactor();
    r.register(LONG);
    expect(r.redact(`${LONG} ${MEDIUM}`)).toBe(`***1234 ${MEDIUM}`);
    r.register(MEDIUM);
    expect(r.redact(`${LONG} ${MEDIUM}`)).toBe('***1234 [REDACTED]');
  });

  it('the replacement never contains the full secret', () => {
    const r = new Redactor();
    for (const v of [LONG, MEDIUM, '12345678', '1234567890123456']) {
      r.register(v);
      expect(r.redact(v)).not.toContain(v);
    }
  });

  it('exports a process-wide default instance', () => {
    expect(redactor).toBeInstanceOf(Redactor);
  });
});
