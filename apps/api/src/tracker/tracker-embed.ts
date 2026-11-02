/**
 * The live tracker's switch and its embed address. Both come from the
 * environment and are read on every request, so turning the tracker off is
 * a config change with no code change.
 *
 * LIVE_TRACKER_ENABLED  "true" to show it; anything else hides it everywhere.
 * SPORTSCORE_EMBED_URL  the official embed address from https://sportscore.com/embed/,
 *                       with {id} where the match id goes, and optionally {lang}
 *                       ("sq" / "en") and {theme} ("light" / "dark").
 */

export const TRACKER_PROVIDER = "sportscore";
export const TRACKER_ATTRIBUTION_URL = "https://sportscore.com";

export function trackerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LIVE_TRACKER_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Only an https address on sportscore.com (or a subdomain) is ever framed. */
function officialHost(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === "sportscore.com" || url.hostname.endsWith(".sportscore.com"));
}

export function trackerEmbedSrc(id: string, lang: "sq" | "en", theme: "light" | "dark", env: NodeJS.ProcessEnv = process.env): string | null {
  const template = (env.SPORTSCORE_EMBED_URL ?? "").trim();
  if (!template.includes("{id}") || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const filled = template.replaceAll("{id}", encodeURIComponent(id)).replaceAll("{lang}", lang).replaceAll("{theme}", theme);
  try {
    const url = new URL(filled);
    return officialHost(url) ? url.toString() : null;
  } catch {
    return null;
  }
}
