import { isIPv4 } from 'node:net';

// Bind policy (ADR 9, CODING_STANDARDS §7): loopback only unless an owner password is set.

/** True for `localhost`, 127.0.0.0/8 and ::1 (bracketed or not). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost' || h === '::1') return true;
  return isIPv4(h) && h.startsWith('127.');
}

/** True when a `Host` header (`name[:port]`) names a loopback host. */
export function isLoopbackHostHeader(header: string): boolean {
  if (header === '') return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${header}`).hostname;
  } catch {
    return false;
  }
  return isLoopbackHost(hostname);
}

/** Called at boot: throws unless `host` is loopback or a password hash exists. */
export function assertBindAllowed(host: string, hasPassword: boolean): void {
  if (hasPassword || isLoopbackHost(host)) return;
  throw new Error(
    `Refusing to listen on VIBECODE_HOST=${host}: no password is set, so only loopback ` +
      `(127.0.0.1) is allowed. Set a password first with \`npm run set-password\`, or unset ` +
      `VIBECODE_HOST. For remote access, put Vibecode behind Tailscale or a TLS reverse proxy.`,
  );
}
