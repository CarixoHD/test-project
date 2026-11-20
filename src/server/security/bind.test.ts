import { describe, expect, it } from 'vitest';
import { assertBindAllowed, isLoopbackHost, isLoopbackHostHeader } from './bind.ts';

describe('bind policy', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]'])(
    '%s is loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '::', '192.168.1.5', 'example.com', 'localhost.evil.com', '127.0.0.1.nip.io'])(
    '%s is not loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );

  it('refuses remote bind without a password, with an actionable message', () => {
    expect(() => {
      assertBindAllowed('0.0.0.0', false);
    }).toThrow(/VIBECODE_HOST=0\.0\.0\.0.*no password.*set-password/s);
  });

  it('allows loopback without a password and any host with one', () => {
    expect(() => {
      assertBindAllowed('127.0.0.1', false);
    }).not.toThrow();
    expect(() => {
      assertBindAllowed('localhost', false);
    }).not.toThrow();
    expect(() => {
      assertBindAllowed('0.0.0.0', true);
    }).not.toThrow();
  });

  it.each([
    ['localhost:4317', true],
    ['127.0.0.1', true],
    ['[::1]:4317', true],
    ['evil.example:4317', false],
    ['192.168.1.5:4317', false],
    ['', false],
    ['bad host', false],
  ])('Host header %j loopback → %s', (header, expected) => {
    expect(isLoopbackHostHeader(header)).toBe(expected);
  });
});
