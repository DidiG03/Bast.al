/**
 * Which matches the Player home page leads with when filling Top events:
 * big clubs / Albania first, then top leagues, then the second tier, then the rest.
 * Names match the feed (same set as the web Bet page).
 */

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

/** 0 comes first. Non-football keeps one level so market count / kick-off decide. */
export function homeImportance(event: {
  sport: string;
  league: string;
  country: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
}): number {
  if (event.sport !== "football") return 3;
  const home = event.homeTeam?.toLowerCase().trim() ?? "";
  const away = event.awayTeam?.toLowerCase().trim() ?? "";
  if (BIG_TEAMS.has(home) || BIG_TEAMS.has(away)) return 0;
  const key = `${(event.country ?? "").toLowerCase()}|${event.league.toLowerCase()}`;
  if (TOP_LEAGUES.has(key)) return 1;
  if (SECOND_LEAGUES.has(key)) return 2;
  return 3;
}
