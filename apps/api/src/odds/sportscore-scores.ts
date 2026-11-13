/**
 * SportScore's live scores (their documented public API,
 * https://sportscore.com/developers/), read by the early goal signals
 * (early-goal.service.ts). A match is known by its slug, the same id the
 * tracker's mapping keeps for it (TrackerMapping.externalId), so the two
 * line up without this importing the tracker.
 */

const FIXTURES_URL = "https://sportscore.com/api/v1/fixtures/";
/** Shown in SportScore's referer analytics (their optional `src` parameter). */
const SOURCE = "shtatat.al";
/** A match slug, the same pattern the tracker accepts for its ids. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,159}$/;

/** The match slug from a fixture's site address ("/football/match/<slug>/<uuid>/"). */
function slugOf(url: unknown): string | null {
  const match = typeof url === "string" ? /^\/football\/match\/([a-z0-9-]+)\/[a-z0-9]+\/?$/.exec(url) : null;
  return match && SLUG.test(match[1]) ? match[1] : null;
}

export interface SportScoreScore {
  /** The match slug, the same id the tracker mapping keeps. */
  id: string;
  home: number;
  away: number;
}

const goalsOf = (value: unknown): number | null => {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 100 ? n : null;
};

/**
 * The score of each match in a fixtures answer: `home_score` / `away_score`
 * (the documented MatchSummary), or a `score` of "1-0" or `{ home, away }`.
 * A row without a slug or a whole score is left out.
 */
export function parseScores(body: unknown): SportScoreScore[] {
  const rows = (body as { matches?: unknown } | null)?.matches;
  if (!Array.isArray(rows)) return [];
  const out: SportScoreScore[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const id = slugOf(row?.url) ?? (typeof row?.slug === "string" && SLUG.test(row.slug) ? row.slug : null);
    if (!id) continue;
    let home = goalsOf(row.home_score);
    let away = goalsOf(row.away_score);
    const score = row.score;
    if ((home === null || away === null) && typeof score === "string") {
      const m = /^\s*(\d+)\s*[-:–]\s*(\d+)\s*$/.exec(score);
      if (m) [home, away] = [Number(m[1]), Number(m[2])];
    } else if ((home === null || away === null) && score && typeof score === "object") {
      home = goalsOf((score as Record<string, unknown>).home);
      away = goalsOf((score as Record<string, unknown>).away);
    }
    if (home === null || away === null) continue;
    out.push({ id, home, away });
  }
  return out;
}

/** The scores of today's live football matches, in one request. `apiKey` raises SportScore's rate limit. */
export async function fetchLiveScores(day: string, fetcher: typeof fetch = fetch, apiKey?: string | null): Promise<SportScoreScore[]> {
  const url = `${FIXTURES_URL}?sport=football&status=live&date=${day}&limit=200&src=${SOURCE}`;
  const response = await fetcher(url, { headers: { accept: "application/json", ...(apiKey ? { "X-Api-Key": apiKey } : {}) }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`SportScore scores: HTTP ${response.status}`);
  return parseScores(await response.json());
}

