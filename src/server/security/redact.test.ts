import { describe, expect, it } from 'vitest';
import { MIN_SECRET_LENGTH, Redactor, redactor } from './index.ts';

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

  describe('safeBoundary', () => {
    const r = new Redactor();
    r.register(LONG);
    r.register(MEDIUM);
    const holdBack = LONG.length - 1;

    it.each([
      ['no secrets registered keeps everything', new Redactor(), 'abc', 3],
      ['short text that could still begin a secret is all held back', r, 'abcdef', 0],
      ['holds back only a tail shorter than the longest secret', r, 'x'.repeat(50), 50 - holdBack],
      [
        'a complete secret over the cut is released whole',
        r,
        `${'x'.repeat(10)}${LONG}`,
        10 + LONG.length,
      ],
    ])('%s', (_name, redactor, text, expected) => {
      expect(redactor.safeBoundary(text)).toBe(expected);
    });

    it('never splits a secret: the redacted head is final whatever follows', () => {
      const stream = `ab ${LONG} cd ${MEDIUM}${LONG}${LONG.slice(0, 9)}`;
      const whole = r.redact(stream);
      for (let end = 0; end <= stream.length; end++) {
        const text = stream.slice(0, end);
        const head = r.redact(text.slice(0, r.safeBoundary(text)));
        expect(whole.startsWith(head)).toBe(true);
        for (const secret of [LONG, MEDIUM]) {
          for (let k = 6; k < secret.length; k++) {
            expect(head.endsWith(secret.slice(0, k))).toBe(false);
          }
        }
      }
    });
  });

  describe('multi-line secrets', () => {
    const LINES = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAAS', 'CBKcwggSjAgEAAoIBAQC7VJTUt9Us8'];
    const SHORT_LINE = 'cKBwko'; // < MIN_SECRET_LENGTH
    const PEM = ['-----BEGIN PRIVATE KEY-----', ...LINES, SHORT_LINE, '-----END PRIVATE KEY-----'];
    const masked = (s: string): string => `***${s.slice(-4)}`;

    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
    ])('masks each line long enough to register when it appears alone (%s)', (_name, eol) => {
      const r = new Redactor();
      r.register(PEM.join(eol));
      for (const line of LINES) {
        expect(r.redact(`x ${line} y`)).toBe(`x ${masked(line)} y`);
        expect(r.redact(`${line}\r`)).toBe(`${masked(line)}\r`);
      }
    });

    it('skips line fragments shorter than MIN_SECRET_LENGTH', () => {
      const r = new Redactor();
      r.register(PEM.join('\n'));
      expect(SHORT_LINE.length).toBeLessThan(MIN_SECRET_LENGTH);
      expect(r.redact(`a ${SHORT_LINE} b`)).toBe(`a ${SHORT_LINE} b`);
    });

    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
    ])('masks the whole secret as one piece (%s)', (_name, eol) => {
      const r = new Redactor();
      const pem = PEM.join(eol);
      r.register(pem);
      expect(r.redact(`key:${eol}${pem}${eol}done`)).toBe(`key:${eol}${masked(pem)}${eol}done`);
    });

    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
    ])('does not register PEM armor lines on their own (%s)', (_name, eol) => {
      const r = new Redactor();
      r.register(PEM.join(eol));
      const output = [
        'generated test cert:',
        '-----BEGIN PRIVATE KEY-----',
        'notTheSecretBody',
        '-----END PRIVATE KEY-----',
        '-----BEGIN CERTIFICATE-----',
      ].join(eol);
      expect(r.redact(output)).toBe(output);
    });

    it('exempts armor lines with surrounding whitespace and other labels', () => {
      const r = new Redactor();
      r.register(
        ['  -----BEGIN RSA PRIVATE KEY-----  ', ...LINES, '\t-----END EC2 KEY-----'].join('\n'),
      );
      expect(r.redact('-----BEGIN RSA PRIVATE KEY-----')).toBe('-----BEGIN RSA PRIVATE KEY-----');
      expect(r.redact('\t-----END EC2 KEY-----')).toBe('\t-----END EC2 KEY-----');
      for (const line of LINES) expect(r.redact(line)).toBe(masked(line));
    });

    it('still registers lines that only resemble armor', () => {
      const r = new Redactor();
      const fake = '-----BEGIN private key-----';
      r.register(['header', fake].join('\n'));
      expect(r.redact(`x ${fake}`)).toBe(`x ${masked(fake)}`);
    });

    it('still masks the full PEM and body lines when streamed in chunks', () => {
      const r = new Redactor();
      const pem = PEM.join('\n');
      r.register(pem);
      const text = `start\n${pem}\nend`;
      let out = '';
      let pending = '';
      for (let i = 0; i < text.length; i += 7) {
        pending += text.slice(i, i + 7);
        const cut = r.safeBoundary(pending);
        out += r.redact(pending.slice(0, cut));
        pending = pending.slice(cut);
      }
      out += r.redact(pending);
      expect(out).toBe(`start\n${masked(pem)}\nend`);
      // Line-split stream: each line redacted on its own.
      const perLine = pem
        .split('\n')
        .map((l) => r.redact(l))
        .join('\n');
      expect(perLine).toBe(
        [
          '-----BEGIN PRIVATE KEY-----',
          ...LINES.map(masked),
          SHORT_LINE,
          '-----END PRIVATE KEY-----',
        ].join('\n'),
      );
    });
  });

  it('exports a process-wide default instance', () => {
    expect(redactor).toBeInstanceOf(Redactor);
  });
});
