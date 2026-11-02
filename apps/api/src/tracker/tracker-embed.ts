/**
 * The live tracker's switch and its embed address, read on every request so
 * turning the tracker off is a config change with no code change.
 *
 * LIVE_TRACKER_ENABLED  "true" to show it; anything else hides it everywhere.
 * SPORTSCORE_EMBED_URL  optional override of the official per-match tracker
 *                       address (https://sportscore.com/embed/), with {id} for
 *                       the match slug and {theme} for "light" / "dark".
 */

export const TRACKER_PROVIDER = "sportscore";
/** SportScore's terms: a visible, crawlable, dofollow link to exactly this address. */
export const TRACKER_ATTRIBUTION_URL = "https://sportscore.com/";
/** The official tracker iframe, as SportScore's embed page and embed.js build it. */
export const DEFAULT_EMBED_URL = "https://sportscore.com/embed/tracker/football/{id}/?theme={theme}";
/** A SportScore match slug, e.g. "botev-vratsa-vs-cherno-more-varna". */
export const TRACKER_ID = /^[a-z0-9][a-z0-9-]{0,159}$/;

export function trackerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LIVE_TRACKER_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Only an https address on sportscore.com (or a subdomain) is ever framed. */
function officialHost(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === "sportscore.com" || url.hostname.endsWith(".sportscore.com"));
}

export function trackerEmbedSrc(id: string, lang: "sq" | "en", theme: "light" | "dark", env: NodeJS.ProcessEnv = process.env): string | null {
  const template = (env.SPORTSCORE_EMBED_URL ?? "").trim() || DEFAULT_EMBED_URL;
  if (!template.includes("{id}") || !TRACKER_ID.test(id)) return null;
  try {
    const url = new URL(template.replaceAll("{id}", encodeURIComponent(id)).replaceAll("{theme}", theme).replaceAll("{lang}", lang));
    if (!officialHost(url)) return null;
    // Like SportScore's embed.js: a language other than English goes in "lang" (English is their default).
    if (!template.includes("{lang}") && lang !== "en") url.searchParams.set("lang", lang);
    return url.toString();
  } catch {
    return null;
  }
}
