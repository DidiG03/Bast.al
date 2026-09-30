import { Request } from "express";
import { clientContext, normalizeIp } from "./client-context";

/**
 * Real client IP for rate limiting, lockouts and audit logging.
 *
 * First choice is the visitor's address as signed by our Next.js BFF (see
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
