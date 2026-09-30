import { createHmac } from "crypto";

/**
 * Server only. The visitor as this web server sees them (address, browser,
 * and Vercel's geolocation), signed with REQUEST_INTEGRITY_SECRET so the API
 * can believe it. Behind its hosting proxy the API itself only sees a proxy
 * address shared by everyone, and no location. See
 * apps/api/src/security/client-context.ts.
 *
 * Used by the /api/backend proxy for the browser's calls and by
 * serverApiFetch for server components' calls, so both are counted against
 * the visitor who made them.
 */
export function signedClientHeaders(headers: { get(name: string): string | null }): Record<string, string> {
  const secret = process.env.REQUEST_INTEGRITY_SECRET ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(secret)) return {};
  const header = (name: string) => headers.get(name)?.trim() || null;
  const decode = (value: string | null) => {
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const ip = header("x-real-ip") ?? header("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const payload = Buffer.from(
    JSON.stringify({
      ip,
      ua: header("user-agent"),
      country: header("x-vercel-ip-country") ?? header("cf-ipcountry"),
      region: decode(header("x-vercel-ip-country-region")),
      city: decode(header("x-vercel-ip-city")),
      ts: Date.now(),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(secret, "hex")).update(payload).digest("hex");
  return { "x-bastal-client": payload, "x-bastal-client-sig": signature };
}
