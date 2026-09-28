import { EventStatus } from "@prisma/client";

/**
 * API-Football (api-sports.io) v3: the fixtures, live scores and pre-match
 * odds Bast.al prices from. Parsing is kept separate from the HTTP call so the
 * same code runs against the real API and the mock feed.
 */

export type FetchJson = (path: string, params: Record<string, string | number>) => Promise<ApiResponse<unknown>>;

export type ApiResponse<T> = {
  errors?: unknown;
  results?: number;
  paging?: { current: number; total: number };
  response: T[];
};

export type RawFixture = {
  fixture: { id: number; date: string; status: { short: string; elapsed: number | null } };
  league: { id: number; name: string; country: string; season: number };
  teams: { home: { name: string }; away: { name: string } };
  goals: { home: number | null; away: number | null };
  /** `fulltime` is the score after 90 minutes, before any extra time. */
  score?: { fulltime?: { home: number | null; away: number | null } };
};

export type RawOdds = {
  fixture: { id: number };
  bookmakers: Array<{ id: number; name: string; bets: Array<{ id: number; name: string; values: Array<{ value: string | number; odd: string }> }> }>;
};

export type FeedFixture = {
  externalId: string;
  leagueId: number;
  season: number;
  league: string;
  country: string;
  homeTeam: string;
  awayTeam: string;
  startsAt: Date;
  status: EventStatus;
  elapsed: number | null;
  homeScore: number | null;
  awayScore: number | null;
  /** The score bets settle on, once the match has finished. Null until then. */
  result: { home: number; away: number } | null;
};

export type FeedMarket = {
  key: string;
  name: string;
  sortOrder: number;
  selections: Array<{ key: string; name: string; odds: number; sortOrder: number }>;
};

const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);
const FINISHED = new Set(["FT", "AET", "PEN"]);
const CANCELLED = new Set(["CANC", "ABD", "AWD", "WO"]);

export function eventStatus(short: string): EventStatus {
  if (LIVE.has(short)) return EventStatus.LIVE;
  if (FINISHED.has(short)) return EventStatus.COMPLETED;
  if (CANCELLED.has(short)) return EventStatus.CANCELLED;
  if (short === "PST") return EventStatus.POSTPONED;
  return EventStatus.UPCOMING;
}

export function parseFixture(raw: RawFixture): FeedFixture {
  const status = eventStatus(raw.fixture.status.short);
  // Bets are on 90 minutes. After extra time `goals` includes it, so prefer
  // the full-time score; a plain FT match has both the same.
  const fulltime = raw.score?.fulltime;
  const home = fulltime?.home ?? (raw.fixture.status.short === "FT" ? raw.goals.home : null);
  const away = fulltime?.away ?? (raw.fixture.status.short === "FT" ? raw.goals.away : null);
  return {
    externalId: String(raw.fixture.id),
    leagueId: raw.league.id,
    season: raw.league.season,
    league: raw.league.name,
    country: raw.league.country,
    homeTeam: raw.teams.home.name,
    awayTeam: raw.teams.away.name,
    startsAt: new Date(raw.fixture.date),
    status,
    elapsed: raw.fixture.status.elapsed,
    homeScore: raw.goals.home,
    awayScore: raw.goals.away,
    result: status === EventStatus.COMPLETED && home !== null && away !== null ? { home, away } : null,
  };
}

type MarketSpec = {
  key: string;
  name: string;
  /** Feed value → our selection key and display name. */
  values: Array<[feedValue: string, key: string, name: (home: string, away: string) => string]>;
};

/** The markets Bast.al offers, matched on API-Football's bet names. */
const MARKETS: Record<string, MarketSpec> = {
  "Match Winner": {
    key: "match_winner",
    name: "Match winner",
    values: [
      ["Home", "home", (home) => home],
      ["Draw", "draw", () => "Draw"],
      ["Away", "away", (_home, away) => away],
    ],
  },
  "Double Chance": {
    key: "double_chance",
    name: "Double chance",
    values: [
      ["Home/Draw", "home_draw", (home) => `${home} or draw`],
      ["Home/Away", "home_away", (home, away) => `${home} or ${away}`],
      ["Draw/Away", "draw_away", (_home, away) => `Draw or ${away}`],
    ],
  },
  "Goals Over/Under": {
    key: "goals_2_5",
    name: "Total goals 2.5",
    values: [
      ["Over 2.5", "over", () => "Over 2.5"],
      ["Under 2.5", "under", () => "Under 2.5"],
    ],
  },
  "Both Teams Score": {
    key: "btts",
    name: "Both teams score",
    values: [
      ["Yes", "yes", () => "Yes"],
      ["No", "no", () => "No"],
    ],
  },
};
const MARKET_ORDER = Object.keys(MARKETS);

/**
 * Picks the markets we offer out of one bookmaker's odds. A market is kept
 * only when every one of its outcomes has a valid price, so a half-priced
 * market never reaches a Player.
 */
export function parseMarkets(raw: RawOdds, homeTeam: string, awayTeam: string, bookmakerId: number): FeedMarket[] {
  const bookmaker = raw.bookmakers.find((b) => b.id === bookmakerId) ?? raw.bookmakers[0];
  if (!bookmaker) return [];
  const markets: FeedMarket[] = [];
  for (const bet of bookmaker.bets) {
    const spec = MARKETS[bet.name];
    if (!spec) continue;
    const selections = spec.values.map(([feedValue, key, name], sortOrder) => {
      const odd = Number(bet.values.find((v) => String(v.value) === feedValue)?.odd);
      return { key, name: name(homeTeam, awayTeam), odds: odd, sortOrder };
    });
    if (selections.some((s) => !Number.isFinite(s.odds) || s.odds <= 1)) continue;
    markets.push({ key: spec.key, name: spec.name, sortOrder: MARKET_ORDER.indexOf(bet.name), selections });
  }
  return markets.sort((a, b) => a.sortOrder - b.sortOrder);
}

export class ApiFootballClient {
  constructor(private readonly fetchJson: FetchJson) {}

  async fixturesByDate(date: string): Promise<FeedFixture[]> {
    const res = (await this.fetchJson("/fixtures", { date, timezone: "UTC" })) as ApiResponse<RawFixture>;
    return res.response.map(parseFixture);
  }

  async liveFixtures(): Promise<FeedFixture[]> {
    const res = (await this.fetchJson("/fixtures", { live: "all" })) as ApiResponse<RawFixture>;
    return res.response.map(parseFixture);
  }

  /** Up to 20 fixtures by id, e.g. to get the final score of a match that just ended. */
  async fixturesByIds(ids: string[]): Promise<FeedFixture[]> {
    if (ids.length === 0) return [];
    const res = (await this.fetchJson("/fixtures", { ids: ids.slice(0, 20).join("-") })) as ApiResponse<RawFixture>;
    return res.response.map(parseFixture);
  }

  /** Pre-match odds for one league on one day, every page. */
  async odds(leagueId: number, season: number, date: string, bookmakerId: number): Promise<RawOdds[]> {
    const all: RawOdds[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = (await this.fetchJson("/odds", { league: leagueId, season, date, bookmaker: bookmakerId, page })) as ApiResponse<RawOdds>;
      all.push(...res.response);
      if (!res.paging || res.paging.current >= res.paging.total) break;
    }
    return all;
  }
}

/** Real HTTP access. API-Football reports problems in `errors` with a 200 status. */
export function httpFetchJson(host: string, apiKey: string): FetchJson {
  return async (path, params) => {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`https://${host}${path}?${query}`, {
      headers: { "x-apisports-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`API-Football answered ${res.status} for ${path}`);
    const body = (await res.json()) as ApiResponse<unknown>;
    const errors = body.errors && typeof body.errors === "object" ? Object.values(body.errors as Record<string, string>) : [];
    if (errors.length > 0) throw new Error(`API-Football: ${errors.join("; ")}`);
    return body;
  };
}
