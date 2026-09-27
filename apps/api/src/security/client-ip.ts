import { Request } from "express";

/**
 * Real client IP for rate limiting, lockouts and audit logging.
 *
 * `request.ip` is Express's own X-Forwarded-For resolution, which only trusts
 * the header when the immediate TCP peer matches the `trust proxy` setting
 * configured in main.ts (loopback / private docker network — i.e. our own
 * Next.js BFF or a local reverse proxy). A caller connecting from a public
 * address cannot spoof this by sending its own X-Forwarded-For header, unlike
 * the naive "read the header if present" parsing this replaces.
 */
export function clientIp(request: Request): string {
  return request.ip ?? request.socket?.remoteAddress ?? "unknown";
}
