/** An https image URL from a feed, or null. Anything else is left out. */
export function crestUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (url.length < 12 || url.length > 400) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Crests to save. A reading without one leaves the crest already stored. */
export function savedCrests(home: string | null, away: string | null): { homeLogo?: string; awayLogo?: string } {
  return { ...(home ? { homeLogo: home } : {}), ...(away ? { awayLogo: away } : {}) };
}
