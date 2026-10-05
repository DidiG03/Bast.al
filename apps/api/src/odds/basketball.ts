import { SelectionResult } from "@prisma/client";

/**
 * Basketball: games and results from API-Sports' basketball API (the same
 * account as API-Football, its own quota). Prices for the European leagues
 * come from API-Sports too; it has no NBA prices on any plan, so the NBA's
 * come from The Odds API (US bookmakers), matched to API-Sports' games by
 * team names and tip-off.
 *
 * Markets, at fixed prices like football, all including overtime:
 * - Winner: either team (a tie, which basketball doesn't have, would be void);
 * - Handicap: a home team handicap and its mirror for the away team;
 * - Total points: over or under.
 * Only half-point lines are offered, so a bet never lands exactly on the line.
 */

export const BASKETBALL_PROVIDER = "api-sports-basketball";
export const NBA_LEAGUE_ID = 12;
/** Handicap and total lines offered per game: the even one and those nearest it. */
const LINES_SHOWN = 5;

export type GameStatus = "upcoming" | "live" | "finished" | "postponed" | "cancelled";

export type FeedGame = {
  externalId: string;
  leagueId: number;
  league: string;
  country: string;
  home: string;
  away: string;
  startsAt: Date;
  status: GameStatus;
  /** Final scores, overtime included, once it's over. */
  score: { home: number; away: number } | null;
};

export type GameMarket = { key: string; name: string; sortOrder: number; selections: Array<{ key: string; name: string; odds: number; sortOrder: number }> };

type RawScore = { total?: number | null };
export type RawGame = {
  id: number;
  date?: string;
  status?: { short?: string };
  league?: { id?: number; name?: string };
  country?: { name?: string };
  teams?: { home?: { name?: string }; away?: { name?: string } };
  scores?: { home?: RawScore; away?: RawScore };
};

const UPCOMING = new Set(["NS", "TBD"]);
const FINISHED = new Set(["FT", "AOT"]);
const POSTPONED = new Set(["POST"]);
const CANCELLED = new Set(["CANC", "ABD", "AWD"]);

export function parseGame(raw: RawGame): FeedGame | null {
  const startsAt = new Date(raw.date ?? "");
  const home = raw.teams?.home?.name?.trim();
  const away = raw.teams?.away?.name?.trim();
  if (!raw.id || Number.isNaN(startsAt.getTime()) || !home || !away || !raw.league?.id) return null;
  const short = raw.status?.short ?? "NS";
  const status: GameStatus = FINISHED.has(short) ? "finished" : UPCOMING.has(short) ? "upcoming" : POSTPONED.has(short) ? "postponed" : CANCELLED.has(short) ? "cancelled" : "live";
  const h = raw.scores?.home?.total;
  const a = raw.scores?.away?.total;
  return {
    externalId: String(raw.id),
    leagueId: raw.league.id,
    league: raw.league.name?.trim() || "Basketball",
    country: raw.country?.name?.trim() || "",
    home,
    away,
    startsAt,
    status,
    score: status === "finished" && Number.isInteger(h) && Number.isInteger(a) ? { home: h!, away: a! } : null,
  };
}

const price = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 1 ? Math.round(n * 100) / 100 : null;
};
const isHalf = (line: number) => Math.abs((Math.abs(line) % 1) - 0.5) < 1e-9;
/** "-1.5" → "m1_5", "8.5" → "8_5", for a market key. */
const lineKey = (line: number) => `${line < 0 ? "m" : ""}${Math.abs(line).toFixed(1).replace(".", "_")}`;
const signed = (line: number) => `${line > 0 ? "+" : line < 0 ? "−" : ""}${Math.abs(line)}`;

type Line = { line: number; a: number; b: number };

/** The lines nearest the even one (where both prices are closest), in order; half-point ones only when there's a choice. */
function mainLines(lines: Line[], halfOnly: boolean): Line[] {
  const half = halfOnly ? lines.filter((l) => isHalf(l.line)) : lines;
  if (half.length === 0) return [];
  const even = half.reduce((best, l) => (Math.abs(l.a - l.b) < Math.abs(best.a - best.b) ? l : best));
  return [...half].sort((x, y) => Math.abs(x.line - even.line) - Math.abs(y.line - even.line)).slice(0, LINES_SHOWN).sort((x, y) => x.line - y.line);
}

/** The three bet types from a winner price pair and handicap and total lines. */
export function gameMarkets(home: string, away: string, winner: { home: number; away: number } | null, handicaps: Line[], totals: Line[], halfOnly = true): GameMarket[] {
  const markets: GameMarket[] = [];
  if (winner) markets.push({ key: "bb_winner", name: "Winner (incl. overtime)", sortOrder: 0, selections: [{ key: "home", name: home, odds: winner.home, sortOrder: 0 }, { key: "away", name: away, odds: winner.away, sortOrder: 1 }] });
  mainLines(handicaps, halfOnly).forEach((l, i) =>
    markets.push({
      key: `bb_handicap_${lineKey(l.line)}`,
      name: `Handicap ${home} ${signed(l.line)}`,
      sortOrder: 10 + i,
      selections: [
        { key: "home", name: `${home} ${signed(l.line)}`, odds: l.a, sortOrder: 0 },
        { key: "away", name: `${away} ${signed(-l.line)}`, odds: l.b, sortOrder: 1 },
      ],
    }),
  );
  mainLines(totals, halfOnly).forEach((l, i) =>
    markets.push({
      key: `bb_total_${lineKey(l.line)}`,
      name: `Total points ${l.line}`,
      sortOrder: 30 + i,
      selections: [
        { key: "over", name: `Over ${l.line}`, odds: l.a, sortOrder: 0 },
        { key: "under", name: `Under ${l.line}`, odds: l.b, sortOrder: 1 },
      ],
    }),
  );
  return markets;
}

type RawBookmaker = { id: number; name?: string; bets?: Array<{ name: string | null; values?: Array<{ value: string; odd: string }> }> };

/**
 * API-Sports' prices for a game (European leagues), from the chosen
 * bookmaker, else the first that has each bet. A handicap value "Home -1.5"
 * is the home team's handicap, and "Away -1.5" is the other side of that same
 * line (the away team at +1.5).
 */
export function parseApiSportsOdds(raw: { bookmakers?: RawBookmaker[] }, home: string, away: string, bookmakerId: number): GameMarket[] {
  const books = [...(raw.bookmakers ?? [])].sort((a, b) => (a.id === bookmakerId ? -1 : b.id === bookmakerId ? 1 : 0));
  const bet = (name: string) => books.map((book) => (book.bets ?? []).find((b) => b.name === name)?.values).find((values) => values && values.length > 0) ?? null;
  const ml = bet("Home/Away");
  const mlHome = price(ml?.find((v) => v.value === "Home")?.odd);
  const mlAway = price(ml?.find((v) => v.value === "Away")?.odd);
  const pairs = (values: Array<{ value: string; odd: string }> | null, a: string, b: string): Line[] => {
    const byLine = new Map<number, Partial<Line>>();
    for (const v of values ?? []) {
      const match = new RegExp(`^(${a}|${b}) ([+-]?\\d+(?:\\.\\d+)?)$`).exec(v.value);
      const odds = price(v.odd);
      if (!match || odds === null) continue;
      const line = Number(match[2]);
      const entry = byLine.get(line) ?? { line };
      entry[match[1] === a ? "a" : "b"] = odds;
      byLine.set(line, entry);
    }
    return [...byLine.values()].filter((l): l is Line => l.a !== undefined && l.b !== undefined);
  };
  return gameMarkets(home, away, mlHome && mlAway ? { home: mlHome, away: mlAway } : null, pairs(bet("Asian Handicap"), "Home", "Away"), pairs(bet("Over/Under"), "Over", "Under"));
}

/** One NBA game from The Odds API. */
export type OddsApiEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Array<{ key: string; markets?: Array<{ key: string; outcomes?: Array<{ name: string; price: number; point?: number }> }> }>;
};

/** Bookmakers whose NBA prices we take, in order of preference. */
export const ODDS_API_BOOKMAKERS = ["draftkings", "fanduel", "betmgm", "williamhill_us", "betrivers"];

/** The Odds API's prices for an NBA game, from the most preferred bookmaker that has each market. */
export function parseOddsApiEvent(event: OddsApiEvent, home: string, away: string): GameMarket[] {
  const rank = (key: string) => (ODDS_API_BOOKMAKERS.includes(key) ? ODDS_API_BOOKMAKERS.indexOf(key) : ODDS_API_BOOKMAKERS.length);
  const books = [...(event.bookmakers ?? [])].sort((a, b) => rank(a.key) - rank(b.key));
  const market = (key: string) => books.map((book) => book.markets?.find((m) => m.key === key)?.outcomes).find((o) => o && o.length > 0) ?? null;
  const h2h = market("h2h");
  const wHome = price(h2h?.find((o) => o.name === event.home_team)?.price);
  const wAway = price(h2h?.find((o) => o.name === event.away_team)?.price);
  const spreads = market("spreads");
  const sHome = spreads?.find((o) => o.name === event.home_team);
  const sAway = spreads?.find((o) => o.name === event.away_team);
  const handicaps: Line[] = sHome && sAway && sHome.point !== undefined && price(sHome.price) && price(sAway.price) ? [{ line: sHome.point, a: price(sHome.price)!, b: price(sAway.price)! }] : [];
  const totals = market("totals");
  const over = totals?.find((o) => o.name === "Over");
  const under = totals?.find((o) => o.name === "Under");
  const totalLines: Line[] = over && under && over.point !== undefined && price(over.price) && price(under.price) ? [{ line: over.point, a: price(over.price)!, b: price(under.price)! }] : [];
  // One line each from The Odds API: kept even when it's a whole number (landing on it gives the stake back).
  return gameMarkets(home, away, wHome && wAway ? { home: wHome, away: wAway } : null, handicaps, totalLines, false);
}

/** A team name in plain lowercase words, to match The Odds API's games to API-Sports'. */
export const teamKey = (name: string) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Sports whose games settle on the final score alone, with these markets: basketball, and the NFL (see nfl.ts). */
export const POINTS_SPORTS: ReadonlySet<string> = new Set(["basketball", "nfl"]);

export const isBasketballMarket = (marketKey: string) => marketKey.startsWith("bb_");

/** One outcome's result from the final score (overtime included). */
export function gradeBasketball(marketKey: string, selectionKey: string, home: number, away: number): SelectionResult | null {
  const result = (margin: number) => (margin > 0 ? SelectionResult.WON : margin < 0 ? SelectionResult.LOST : SelectionResult.VOID);
  if (marketKey === "bb_winner") return result(selectionKey === "home" ? home - away : away - home);
  const handicap = /^bb_handicap_(m?)(\d+)_(\d)$/.exec(marketKey);
  if (handicap) {
    const line = (handicap[1] ? -1 : 1) * Number(`${handicap[2]}.${handicap[3]}`);
    const homeMargin = home + line - away;
    return result(selectionKey === "home" ? homeMargin : -homeMargin);
  }
  const total = /^bb_total_(\d+)_(\d)$/.exec(marketKey);
  if (total) {
    const line = Number(`${total[1]}.${total[2]}`);
    return result(selectionKey === "over" ? home + away - line : line - home - away);
  }
  return null;
}
