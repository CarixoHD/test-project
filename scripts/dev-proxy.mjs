// Dev proxy header rules (ARCHITECTURE §8): plain JS so dev.mjs can import it next to Vite.
// The API behind Vite is loopback-only and Vite's allowedHosts check guards the dev Host, so
// present /api requests to the API as local (see devApiOrigin for the Origin half).

/**
 * The Origin header to send to the API. A browser Origin whose host is the request's own Host is
 * same-origin from the browser's view: rewrite it to the API's loopback origin, which is what
 * `changeOrigin: true` makes the API see as Host. Any other Origin (foreign, `null`) is a
 * cross-origin mutation and must reach the API unchanged, so its check still refuses it.
 * @param {string | undefined} host the incoming request's Host header
 * @param {string | undefined} origin the incoming request's Origin header
 * @param {number} apiPort the loopback port the API listens on
 * @returns {string | undefined}
 */
export function devApiOrigin(host, origin, apiPort) {
  if (host === undefined || origin === undefined) return origin;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return origin; // includes the opaque origin `null`
  }
  if (originHost !== host.toLowerCase()) return origin;
  return `http://127.0.0.1:${apiPort}`;
}
