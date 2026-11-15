/**
 * SportScore's documented public API (https://sportscore.com/developers/,
 * OpenAPI: /developers/openapi.yaml): football fixtures, read to learn each
 * match's slug for the tracker iframe (and the early goal signals' link).
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

/** SportScore's key (SPORTSCORE_API_KEY), sent when set: it raises their rate limit from ~10,000 a day to 6,000 a minute. */
export function sportScoreKey(): string | null {
  return process.env.SPORTSCORE_API_KEY?.trim() || null;
}

const headers = (): Record<string, string> => {
  const key = sportScoreKey();
  return { accept: "application/json", ...(key ? { "X-Api-Key": key } : {}) };
};

async function readFixtures(query: string, fetcher: typeof fetch): Promise<SportScoreFixture[]> {
  const url = `${SPORTSCORE_FIXTURES_URL}?sport=football&${query}&limit=200&src=${SOURCE}`;
  const response = await fetcher(url, { headers: headers(), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`SportScore fixtures: HTTP ${response.status}`);
  return parseFixtures(await response.json());
}

/** One UTC day's football fixtures that are live (or, with "upcoming", not started yet). */
export async function fetchLiveFixtures(day: string, fetcher: typeof fetch = fetch, status: "live" | "upcoming" = "live"): Promise<SportScoreFixture[]> {
  return readFixtures(`status=${status}&date=${day}`, fetcher);
}

/**
 * One team's fixtures on a UTC day, whatever their status. SportScore's
 * status=live list has come back empty while matches were live; asked by
 * team, the same matches are there.
 */
export async function fetchTeamFixtures(team: string, day: string, fetcher: typeof fetch = fetch): Promise<SportScoreFixture[]> {
  return readFixtures(`team=${encodeURIComponent(team)}&date=${day}`, fetcher);
}

/** Our guess at a team's SportScore slug from its name: "Bosnia & Herzegovina" → "bosnia-and-herzegovina". */
export function teamSlug(name: string): string | null {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length >= 2 ? slug : null;
}

/** SportScore's teams for a name (their search), as { name, slug }. */
export async function searchTeams(query: string, fetcher: typeof fetch = fetch): Promise<Array<{ name: string; slug: string }>> {
  const url = `https://sportscore.com/api/v1/search/?sport=football&q=${encodeURIComponent(query.slice(0, 60))}&limit=8&src=${SOURCE}`;
  const response = await fetcher(url, { headers: headers(), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`SportScore search: HTTP ${response.status}`);
  const teams = ((await response.json()) as { teams?: unknown } | null)?.teams;
  if (!Array.isArray(teams)) return [];
  return (teams as Array<Record<string, unknown>>)
    .filter((team) => typeof team?.name === "string" && typeof team.slug === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(team.slug))
    .map((team) => ({ name: (team.name as string).slice(0, 120), slug: team.slug as string }));
}
