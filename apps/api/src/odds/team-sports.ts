import { type FeedMarket } from "./api-football";
import { type RawBookmaker, type Values } from "./basketball";

/**
 * What volleyball and handball share: API-Sports' game shape (the same in
 * both APIs), its statuses, and picking each bet from the preferred
 * bookmaker. See volleyball.ts and handball.ts for each sport's markets.
 */

export type GameStatus = "upcoming" | "live" | "finished" | "postponed" | "cancelled";

type RawSide = { home?: number | null; away?: number | null };
/** One game from API-Sports' volleyball or handball API. */
export type RawTeamGame = {
  id: number;
  date?: string;
  status?: { short?: string };
  league?: { id?: number; name?: string };
  country?: { name?: string };
  teams?: { home?: { name?: string }; away?: { name?: string } };
  /** Volleyball: sets won. Handball: goals, extra time included after it. */
  scores?: RawSide;
  /** Volleyball: first … fifth set's points. Handball: first and second half's goals. */
  periods?: Record<string, RawSide | undefined>;
};

export type RawGameOdds = { game?: { id?: number }; bookmakers?: RawBookmaker[] };

/** The parts every game has. */
export type TeamGame = {
  externalId: string;
  leagueId: number;
  league: string;
  country: string;
  home: string;
  away: string;
  startsAt: Date;
  status: GameStatus;
};

/** The game's own details, or null when the feed left out something needed. */
export function parseTeamGame(raw: RawTeamGame, statuses: { finished: Set<string>; postponed: Set<string>; cancelled: Set<string> }, fallbackLeague: string): TeamGame | null {
  const startsAt = new Date(raw.date ?? "");
  const home = raw.teams?.home?.name?.trim();
  const away = raw.teams?.away?.name?.trim();
  if (!raw.id || Number.isNaN(startsAt.getTime()) || !home || !away || !raw.league?.id) return null;
  const short = raw.status?.short ?? "NS";
  const status: GameStatus =
    short === "NS" || short === "TBD" ? "upcoming"
    : statuses.finished.has(short) ? "finished"
    : statuses.postponed.has(short) ? "postponed"
    : statuses.cancelled.has(short) ? "cancelled"
    : "live";
  return { externalId: String(raw.id), leagueId: raw.league.id, league: raw.league.name?.trim() || fallbackLeague, country: raw.country?.name?.trim() || "", home, away, startsAt, status };
}

/** A whole number from the feed, or null. */
export const whole = (value: unknown): number | null => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null);

/**
 * Each bet from the preferred bookmaker, else the first other bookmaker that
 * prices it, so one market's prices always come from one bookmaker.
 */
export function betsFrom(raw: RawGameOdds, bookmakerId: number): (name: string) => Values {
  const books = [...(raw.bookmakers ?? [])].sort((a, b) => (a.id === bookmakerId ? -1 : b.id === bookmakerId ? 1 : 0));
  return (name: string) => books.map((book) => (book.bets ?? []).find((b) => b.name === name)?.values).find((values) => values && values.length > 0) ?? null;
}

/** A team's name in plain lowercase words, without a women's or youth marker, to match the bookmakers' spellings to the feed's. */
function plainName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\((w|women|u\d+)\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(w|women)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether a bookmaker's team name is this team: the same words, or one name inside the other ("Baia Mare" and "Minaur Baia Mare"). */
function sameTeam(feed: string, team: string): boolean {
  const a = plainName(feed);
  const b = plainName(team);
  if (!a || !b) return false;
  return a === b || ` ${b} `.includes(` ${a} `) || ` ${a} `.includes(` ${b} `);
}

/**
 * A market whose values name the teams ("Baia Mare/CSM Bucuresti", "Draw/Baia
 * Mare"), as half time / full time comes from the bookmakers: each value's
 * two parts matched to home, away or "Draw", keyed "home_away". Null when a
 * name can't be told apart for sure (it fits both teams, or neither).
 */
export function teamPairPrices(values: Values, home: string, away: string): Map<string, number> | null {
  if (!values || values.length === 0) return null;
  const side = (part: string): "home" | "draw" | "away" | null => {
    if (/^draw$/i.test(part.trim())) return "draw";
    const isHome = sameTeam(part, home);
    const isAway = sameTeam(part, away);
    return isHome === isAway ? null : isHome ? "home" : "away";
  };
  const out = new Map<string, number>();
  for (const v of values) {
    const text = String(v.value);
    // A team name can hold a "/" itself, so try every split for one that reads as two sides.
    let found: string | null = null;
    for (let i = text.indexOf("/"); i !== -1; i = text.indexOf("/", i + 1)) {
      const left = side(text.slice(0, i));
      const right = side(text.slice(i + 1));
      if (left && right) {
        if (found) return null;
        found = `${left}_${right}`;
      }
    }
    const odds = Number(v.odd);
    if (!found || !Number.isFinite(odds) || odds <= 1 || out.has(found)) return null;
    out.set(found, Math.round(odds * 100) / 100);
  }
  return out;
}

/** Keeps a market only when every outcome has a valid price, as football does. */
export function priced(markets: Array<Omit<FeedMarket, "sortOrder">>, sortOrder: number): FeedMarket[] {
  return markets
    .filter((market) => market.selections.length >= 2 && market.selections.every((s) => Number.isFinite(s.odds) && s.odds > 1))
    .map((market, position) => ({ ...market, sortOrder: sortOrder + position, selections: market.selections.map((s) => ({ ...s, odds: Math.round(s.odds * 100) / 100 })) }));
}
