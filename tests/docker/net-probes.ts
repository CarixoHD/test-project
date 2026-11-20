// Network probes shared by the Docker suites (test-only).

/** Exits 0 only if an outbound TCP connection succeeds. Proves nothing on a host without egress. */
export const EGRESS_PROBE =
  "require('net').connect({host:'1.1.1.1',port:53,timeout:5000})" +
  ".on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))" +
  ".on('timeout',()=>process.exit(4))";

/**
 * Interfaces a network-none container may have: loopback, plus the always-down fallback tunnel
 * devices the kernel adds to every network namespace when a tunnel module (ipip, sit, gre, vti)
 * is loaded on the host. None of them can carry traffic out.
 */
const ALLOWED_IFACES = [
  'lo',
  'tunl0',
  'sit0',
  'ip6tnl0',
  'gre0',
  'gretap0',
  'erspan0',
  'ip6gre0',
  'ip_vti0',
  'ip6_vti0',
] as const;

/** Interface names listed in a /proc/net/dev dump. */
export function interfaces(procNetDev: string): string[] {
  return [...procNetDev.matchAll(/^\s*([^\s:|]+):/gm)].map((m) => m[1] ?? '');
}

/** Interfaces in a /proc/net/dev dump that could connect the container to a network. */
export function openInterfaces(procNetDev: string): string[] {
  const allowed: readonly string[] = ALLOWED_IFACES;
  return interfaces(procNetDev).filter((n) => !allowed.includes(n));
}

/**
 * Shell check (no internet needed): prints `check:no-iface`, or prints `check:iface-OPEN` and
 * exits 1 when /proc/net/dev lists any interface outside ALLOWED_IFACES.
 */
export const NO_IFACE_CHECK =
  `if grep -Ev '^ *(${ALLOWED_IFACES.join('|')}):' /proc/net/dev | grep -q ':'; ` +
  'then echo check:iface-OPEN; exit 1; fi; echo check:no-iface';
