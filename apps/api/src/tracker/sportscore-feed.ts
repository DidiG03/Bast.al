/**
 * SportScore's documented public API (https://sportscore.com/developers/,
 * OpenAPI: /developers/openapi.yaml): the day's live football fixtures, used
 * only to learn each match's slug for the tracker iframe.
 */
import { TRACKER_ID } from "./tracker-embed";

export const SPORTSCORE_FIXTURES_URL = "https://sportscore.com/api/v1/fixtures/";
/** Shown in SportScore's referer analytics (their optional `src` parameter). */
const SOURCE = "shtatat.al";

export interface SportScoreFixture {
  id: string;
  home: string;
  away: string;
  kickoff: string;
}

/** The match slug from a fixture's site address ("/football/match/<slug>/<uuid>/"). */
export function slugFromUrl(url: unknown): string | null {
  const match = typeof url === "string" ? /^\/football\/match\/([a-z0-9-]+)\/[a-z0-9]+\/?$/.exec(url) : null;
  return match && TRACKER_ID.test(match[1]) ? match[1] : null;
}

/** Turns the API's `matches` into fixtures; rows without names, a time or a slug are dropped. */
export function parseFixtures(body: unknown): SportScoreFixture[] {
  const rows = (body as { matches?: unknown } | null)?.matches;
  if (!Array.isArray(rows)) return [];
  const out: SportScoreFixture[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const id = slugFromUrl(row?.url);
    const kickoff = typeof row?.time === "string" ? new Date(row.time) : null;
    if (!id || typeof row.home !== "string" || typeof row.away !== "string" || !kickoff || Number.isNaN(kickoff.getTime())) continue;
    out.push({ id, home: row.home.slice(0, 120), away: row.away.slice(0, 120), kickoff: kickoff.toISOString() });
  }
  return out;
}

/** One UTC day's live football fixtures. */
export async function fetchLiveFixtures(day: string, fetcher: typeof fetch = fetch): Promise<SportScoreFixture[]> {
  const url = `${SPORTSCORE_FIXTURES_URL}?sport=football&status=live&date=${day}&limit=200&src=${SOURCE}`;
  const response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`SportScore fixtures: HTTP ${response.status}`);
  return parseFixtures(await response.json());
}
