import { BlockList, isIP } from "net";
import { Request } from "express";
import { clientContext, normalizeIp } from "./client-context";

/**
 * Real client IP for rate limiting, lockouts and audit logging.
 *
 * First choice is the visitor's address as signed by our Next.js web app (see
 * client-context.ts), which is the only reliable one when the API runs behind
 * a hosting proxy. Otherwise `request.ip`: Express's own X-Forwarded-For
 * resolution, which only trusts the header when the immediate TCP peer matches
 * the `trust proxy` setting in main.ts (loopback / private network), so a
 * caller on a public address can't spoof it.
 */
export function clientIp(request: Request): string {
  const ip = clientContext(request)?.ip ?? request.ip ?? request.socket?.remoteAddress ?? "unknown";
  return normalizeIp(ip);
}

/** Loopback, private networks and the carrier-grade NAT range hosting proxies use (100.64.0.0/10). */
const infrastructure = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  infrastructure.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  infrastructure.addSubnet(network, prefix, "ipv6");
}

/**
 * Whether an address belongs to one visitor, so it's fair to count failures
 * against it and block it. A hosting proxy or our own web server's address is
 * shared by everyone whose request came through it: blocking that would lock
 * every user out because of one stranger. Unknown and non-IP values count as
 * shared too.
 */
export function isVisitorAddress(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const version = isIP(ip);
  if (version === 0) return false;
  return !infrastructure.check(ip, version === 6 ? "ipv6" : "ipv4");
}
