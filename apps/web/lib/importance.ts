import type { OddsEvent } from "./api";

/**
 * Which matches the Bet page lists first: a match with one of the big clubs (or Albania) on top, then the
 * top competitions, then the second tier, then the rest. Within each level the usual order (kick-off) stays.
 * Names are as API-Football writes them; a league name is only trusted with its country, since "Serie A"
 * or "Bundesliga" exist in more than one.
 */

/** "country|league", lower case. */
const TOP_LEAGUES = new Set([
  "world|uefa champions league",
  "england|premier league",
  "spain|la liga",
  "italy|serie a",
  "germany|bundesliga",
  "france|ligue 1",
  "albania|superliga",
  "world|world cup",
  "world|euro championship",
]);

const SECOND_LEAGUES = new Set([
  "world|uefa europa league",
  "world|uefa europa conference league",
  "world|uefa conference league",
  "world|uefa nations league",
  "world|uefa super cup",
  "world|fifa club world cup",
  "world|world cup - qualification europe",
  "world|euro championship - qualification",
  "england|fa cup",
  "england|league cup",
  "england|championship",
  "spain|copa del rey",
  "spain|super cup",
  "italy|coppa italia",
  "italy|super cup",
  "germany|dfb pokal",
  "france|coupe de france",
  "netherlands|eredivisie",
  "portugal|primeira liga",
  "turkey|süper lig",
  "albania|cup",
]);

/**
 * The clubs people look for first, exactly as the feed names their first team: an exact match keeps out
 * "Arsenal Tivat", "Inter Miami", and the women's and reserve sides ("Chelsea W", "Benfica B").
 */
const BIG_TEAMS = new Set([
  "real madrid",
  "barcelona",
  "atletico madrid",
  "paris saint germain",
  "bayern münchen",
  "borussia dortmund",
  "manchester city",
  "manchester united",
  "liverpool",
  "arsenal",
  "chelsea",
  "tottenham",
  "juventus",
  "inter",
  "ac milan",
  "napoli",
  "as roma",
  "benfica",
  "fc porto",
  "ajax",
  "albania",
]);

const isBigTeam = (name: string | null) => !!name && BIG_TEAMS.has(name.toLowerCase().trim());

/** 0 comes first: a big club playing, then top leagues (1), second tier (2), everything else (3). */
export function importance(event: Pick<OddsEvent, "league" | "country" | "homeTeam" | "awayTeam" | "sport">): number {
  // Football only (a match without a sport is football, the default list).
  if (event.sport && event.sport !== "football") return 3;
  if (isBigTeam(event.homeTeam) || isBigTeam(event.awayTeam)) return 0;
  const key = `${(event.country ?? "").toLowerCase()}|${event.league.toLowerCase()}`;
  if (TOP_LEAGUES.has(key)) return 1;
  if (SECOND_LEAGUES.has(key)) return 2;
  return 3;
}

/** The same matches, most important first; equal ones keep the order they came in. */
export function byImportance<T extends Pick<OddsEvent, "league" | "country" | "homeTeam" | "awayTeam" | "sport">>(events: T[]): T[] {
  return events
    .map((event, index) => ({ event, index, rank: importance(event) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ event }) => event);
}
