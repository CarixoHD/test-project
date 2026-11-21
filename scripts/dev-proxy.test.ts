import { describe, expect, it } from 'vitest';

type DevApiOrigin = (
  host: string | undefined,
  origin: string | undefined,
  apiPort: number,
) => string | undefined;

// dev-proxy.mjs is plain JS like preflight.mjs, and tsconfig has no allowJs, so load it through a
// non-literal specifier and type the export here.
const DEV_PROXY_URL = new URL('./dev-proxy.mjs', import.meta.url);
const { devApiOrigin } = (await import(DEV_PROXY_URL.href)) as { devApiOrigin: DevApiOrigin };

const API = { host: '192.0.2.10:5291', apiPort: 5292 };

describe('devApiOrigin', () => {
  it('rewrites a same-origin Origin to the API origin', () => {
    expect(devApiOrigin(API.host, 'http://192.0.2.10:5291', API.apiPort)).toBe(
      'http://127.0.0.1:5292',
    );
    // Host names are case-insensitive; the URL parser lowercases the Origin's host.
    expect(devApiOrigin('Dev.Example:5291', 'http://dev.example:5291', API.apiPort)).toBe(
      'http://127.0.0.1:5292',
    );
  });

  it('leaves a foreign Origin untouched', () => {
    expect(devApiOrigin(API.host, 'http://evil.example', API.apiPort)).toBe('http://evil.example');
    expect(devApiOrigin(API.host, 'http://192.0.2.10:9999', API.apiPort)).toBe(
      'http://192.0.2.10:9999',
    );
  });

  it('leaves the opaque null Origin untouched', () => {
    expect(devApiOrigin(API.host, 'null', API.apiPort)).toBe('null');
  });

  it('leaves a missing Origin untouched', () => {
    expect(devApiOrigin(API.host, undefined, API.apiPort)).toBeUndefined();
    expect(devApiOrigin(undefined, 'http://192.0.2.10:5291', API.apiPort)).toBe(
      'http://192.0.2.10:5291',
    );
  });
});
