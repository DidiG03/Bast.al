import { createHmac, timingSafeEqual } from "crypto";
import { Request } from "express";

/**
 * Who is really on the other end of a request that came through our Next.js
 * BFF (/api/backend). The API is reached through the web app and usually a
 * hosting proxy too, so its own view of the caller is a proxy address
 * (e.g. 100.64.x.x) with no location. The BFF reads the visitor's address,
 * browser and Vercel geolocation, and signs them with REQUEST_INTEGRITY_SECRET:
 *
 *   x-bastal-client     base64url(JSON { ip, ua, country, region, city, ts })
 *   x-bastal-client-sig hex(HMAC-SHA256(secret, x-bastal-client))
 *
 * Only a correctly signed, fresh header is believed, so nobody can pick their
 * own IP to dodge lockouts. Without the secret this is always null and the API
 * falls back to what it sees itself.
 */
export type ClientContext = {
  ip: string | null;
  userAgent: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
};

const MAX_AGE_MS = 5 * 60_000;
const cache = new WeakMap<Request, ClientContext | null>();

function secret(): Buffer | null {
  const hex = process.env.REQUEST_INTEGRITY_SECRET ?? "";
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
}

export function clientContext(request: Request): ClientContext | null {
  if (cache.has(request)) return cache.get(request)!;
  const context = read(request);
  cache.set(request, context);
  return context;
}

function read(request: Request): ClientContext | null {
  const key = secret();
  const payload = request.headers["x-bastal-client"];
  const signature = request.headers["x-bastal-client-sig"];
  if (!key || typeof payload !== "string" || typeof signature !== "string" || payload.length > 4096) return null;
  const expected = createHmac("sha256", key).update(payload).digest();
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof data.ts !== "number" || Math.abs(Date.now() - data.ts) > MAX_AGE_MS) return null;
    const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
    return {
      ip: text(data.ip, 64),
      userAgent: text(data.ua, 512),
      country: text(data.country, 8),
      region: text(data.region, 64),
      city: text(data.city, 96),
    };
  } catch {
    return null;
  }
}

/** "::ffff:1.2.3.4" (an IPv4 address in IPv6 form) becomes "1.2.3.4". */
export function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
}
