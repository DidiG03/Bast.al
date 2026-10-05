import type { FeedGame, GameStatus } from "./basketball";

/**
 * NFL: games, results and prices from API-Sports' American football API (the
 * same account as API-Football, its own quota). Its prices come in the same
 * shape as basketball's, so an NFL game has the same three bet types, keyed
 * the same way and settled the same way (see basketball.ts): the winner
 * (a tie, which the regular season can end in, is void), a handicap (the
 * spread) and total points, all including overtime.
 */

export const NFL_PROVIDER = "api-sports-nfl";
export const NFL_LEAGUE_ID = 1;

export type RawNflGame = {
  game?: { id?: number; date?: { timestamp?: number }; status?: { short?: string } };
  league?: { id?: number; name?: string; country?: { name?: string } };
  teams?: { home?: { name?: string }; away?: { name?: string } };
  scores?: { home?: { total?: number | null }; away?: { total?: number | null } };
};

const UPCOMING = new Set(["NS", "TBD"]);
/** Full time, and after overtime. */
const FINISHED = new Set(["FT", "AOT"]);
const POSTPONED = new Set(["PST", "POST"]);
const CANCELLED = new Set(["CANC", "ABD", "AWD"]);

export function parseNflGame(raw: RawNflGame): FeedGame | null {
  const id = raw.game?.id;
  const timestamp = raw.game?.date?.timestamp;
  const home = raw.teams?.home?.name?.trim();
  const away = raw.teams?.away?.name?.trim();
  if (!id || !timestamp || !home || !away || !raw.league?.id) return null;
  const short = raw.game?.status?.short ?? "NS";
  const status: GameStatus = FINISHED.has(short) ? "finished" : UPCOMING.has(short) ? "upcoming" : POSTPONED.has(short) ? "postponed" : CANCELLED.has(short) ? "cancelled" : "live";
  const h = raw.scores?.home?.total;
  const a = raw.scores?.away?.total;
  return {
    externalId: String(id),
    leagueId: raw.league.id,
    league: raw.league.name?.trim() || "NFL",
    country: raw.league.country?.name?.trim() || "",
    home,
    away,
    startsAt: new Date(timestamp * 1000),
    status,
    score: status === "finished" && Number.isInteger(h) && Number.isInteger(a) ? { home: h!, away: a! } : null,
  };
}
