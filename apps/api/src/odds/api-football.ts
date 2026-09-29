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
  score?: { halftime?: { home: number | null; away: number | null }; fulltime?: { home: number | null; away: number | null } };
};

export type RawOdds = {
  fixture: { id: number };
  bookmakers: Array<{ id: number; name: string; bets: Array<{ id: number; name: string; values: Array<{ value: string | number; odd: string }> }> }>;
};

/**
 * One live match from `/odds/live`. `status.stopped` and `status.blocked` mean
 * the bookmaker isn't taking bets on the whole match right now; `suspended`
 * on a value means that price is off the board.
 */
export type RawLiveOdds = {
  fixture: { id: number; status?: { long?: string; elapsed?: number | null } };
  teams?: { home?: { goals?: number | null }; away?: { goals?: number | null } };
  status?: { stopped?: boolean; blocked?: boolean; finished?: boolean };
  update?: string;
  odds: Array<{ id: number; name: string; values: Array<{ value: string | number; odd: string; handicap?: string | null; main?: boolean | null; suspended?: boolean }> }>;
};

export type FeedLiveMarket = FeedMarket & {
  /** The feed suspended this market, or one of its outcomes has no valid price. */
  suspended: boolean;
};

export type FeedLiveOdds = {
  externalId: string;
  /** The feed isn't taking bets on this match at all right now. */
  stopped: boolean;
  markets: FeedLiveMarket[];
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
  /** The half-time score, for the half markets. Null until the match has finished or if the feed didn't send it. */
  halfTime: { home: number; away: number } | null;
  /** Went to extra time or penalties. Match statistics then include extra time, so corner and card bets can't settle from them. */
  extraTime: boolean;
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
    extraTime: raw.fixture.status.short === "AET" || raw.fixture.status.short === "PEN",
    halfTime:
      status === EventStatus.COMPLETED && raw.score?.halftime?.home != null && raw.score.halftime.away != null
        ? { home: raw.score.halftime.home, away: raw.score.halftime.away }
        : null,
  };
}

type Namer = (home: string, away: string) => string;
type FeedBet = { name: string; values: Array<{ value: string | number; odd: string }> };
type Built = Omit<FeedMarket, "sortOrder">;

/** A market with a fixed set of outcomes. Feed value → our selection key and display name. */
function fixed(key: string, name: Namer, values: Array<[feedValue: string, key: string, name: Namer]>) {
  return (bet: FeedBet, home: string, away: string): Built[] => [
    {
      key,
      name: name(home, away),
      selections: values.map(([feedValue, selectionKey, selectionName], sortOrder) => ({
        key: selectionKey,
        name: selectionName(home, away),
        odds: priceOf(bet, feedValue),
        sortOrder,
      })),
    },
  ];
}

/**
 * Over/under on goals: one market per half-goal line the feed prices, keyed
 * e.g. `goals_1_5`. Only .5 lines are offered, so there's never a push.
 */
function lines(prefix: string, name: (home: string, away: string, line: string) => string, offered: string[]) {
  return (bet: FeedBet, home: string, away: string): Built[] =>
    offered.map((line) => ({
      key: `${prefix}_${line.replace(".", "_")}`,
      name: name(home, away, line),
      selections: [
        { key: "over", name: `Over ${line}`, odds: priceOf(bet, `Over ${line}`), sortOrder: 0 },
        { key: "under", name: `Under ${line}`, odds: priceOf(bet, `Under ${line}`), sortOrder: 1 },
      ],
    }));
}

/**
 * Over/under on a count whose lines change from match to match (corners,
 * cards): one market per half line the feed prices, up to `max` of them,
 * keyed e.g. `corners_9_5`. Whole lines (Over 10) are skipped, so there's
 * never a push.
 */
function feedLines(prefix: string, name: (home: string, away: string, line: string) => string, max = 3) {
  return (bet: FeedBet, home: string, away: string): Built[] => {
    const offered = [...new Set(bet.values.map((v) => /^Over (\d+\.5)$/.exec(String(v.value))?.[1]).filter((line): line is string => Boolean(line)))]
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, max);
    return lines(prefix, name, offered)(bet, home, away);
  };
}

/** Correct score: every scoreline the feed prices up to 4 goals a side, keyed `2-1`. */
function scores(key: string, name: string) {
  return (bet: FeedBet): Built[] => {
    const selections = bet.values
      .map((v) => ({ match: /^(\d+):(\d+)$/.exec(String(v.value)), odds: Number(v.odd) }))
      .filter((v): v is { match: RegExpExecArray; odds: number } => v.match !== null && Number(v.match[1]) <= 4 && Number(v.match[2]) <= 4)
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]) || Number(a.match[2]) - Number(b.match[2]))
      .map((v, sortOrder) => ({ key: `${v.match[1]}-${v.match[2]}`, name: `${v.match[1]}–${v.match[2]}`, odds: v.odds, sortOrder }));
    return selections.length >= 2 ? [{ key, name, selections }] : [];
  };
}

function priceOf(bet: FeedBet, feedValue: string): number {
  return Number(bet.values.find((v) => String(v.value) === feedValue)?.odd);
}

const outcomes: Array<[feed: string, key: string, name: Namer]> = [
  ["Home", "home", (home) => home],
  ["Draw", "draw", () => "Draw"],
  ["Away", "away", (_home, away) => away],
];
const yesNo: Array<[string, string, Namer]> = [
  ["Yes", "yes", () => "Yes"],
  ["No", "no", () => "No"],
];
const eitherTeam: Array<[string, string, Namer]> = [
  ["Home", "home", (home) => home],
  ["Away", "away", (_home, away) => away],
];
const doubleChance: Array<[string, string, Namer]> = [
  ["Home/Draw", "home_draw", (home) => `${home} or draw`],
  ["Home/Away", "home_away", (home, away) => `${home} or ${away}`],
  ["Draw/Away", "draw_away", (_home, away) => `Draw or ${away}`],
];
const sideName = (side: string, home: string, away: string) => (side === "home" ? home : side === "away" ? away : "Draw");
const pairs = (left: string[], right: string[]) => left.flatMap((l) => right.map((r) => [l, r] as const));
const cap = (word: string) => word[0].toUpperCase() + word.slice(1);

/**
 * The markets Bast.al offers, matched on API-Football's pre-match bet names,
 * in the order Players see them. Every one settles from the 90-minute score,
 * plus the half-time score for the half markets (see bets/grading.ts), so
 * nothing here needs data the feed doesn't already send with the result.
 */
const MARKETS: Array<[betName: string, build: (bet: FeedBet, home: string, away: string) => Built[]]> = [
  ["Match Winner", fixed("match_winner", () => "Match winner", outcomes)],
  ["Double Chance", fixed("double_chance", () => "Double chance", doubleChance)],
  // `goals_2_5` keeps its original key and name, since placed bets point at it.
  ["Goals Over/Under", lines("goals", (_h, _a, line) => `Total goals ${line}`, ["2.5", "1.5", "3.5", "0.5", "4.5"])],
  ["Both Teams Score", fixed("btts", () => "Both teams score", yesNo)],
  ["Home/Away", fixed("draw_no_bet", () => "Draw no bet", eitherTeam)],
  ["First Half Winner", fixed("h1_winner", () => "1st half result", outcomes)],
  [
    "HT/FT Double",
    fixed(
      "ht_ft",
      () => "Half time / full time",
      pairs(["home", "draw", "away"], ["home", "draw", "away"]).map(([ht, ft]) => [`${cap(ht)}/${cap(ft)}`, `${ht}_${ft}`, (home, away) => `${sideName(ht, home, away)} / ${sideName(ft, home, away)}`]),
    ),
  ],
  [
    "Results/Both Teams Score",
    fixed(
      "result_btts",
      () => "Result and both teams score",
      pairs(["home", "draw", "away"], ["yes", "no"]).map(([side, btts]) => [`${cap(side)}/${cap(btts)}`, `${side}_${btts}`, (home, away) => `${sideName(side, home, away)} / ${cap(btts)}`]),
    ),
  ],
  ["Exact Score", scores("correct_score", "Correct score")],
  [
    "Exact Goals Number",
    fixed("exact_goals", () => "Exact total goals", [
      ...["0", "1", "2", "3", "4", "5", "6"].map((n): [string, string, Namer] => [n, n, () => `${n} goals`]),
      ["more 7", "7+", () => "7+ goals"],
    ]),
  ],
  ["Total - Home", lines("home_goals", (home, _a, line) => `${home} goals ${line}`, ["0.5", "1.5", "2.5"])],
  ["Total - Away", lines("away_goals", (_h, away, line) => `${away} goals ${line}`, ["0.5", "1.5", "2.5"])],
  [
    "Odd/Even",
    fixed("odd_even", () => "Total goals odd/even", [
      ["Odd", "odd", () => "Odd"],
      ["Even", "even", () => "Even"],
    ]),
  ],
  ["Clean Sheet - Home", fixed("clean_sheet_home", (home) => `${home} clean sheet`, yesNo)],
  ["Clean Sheet - Away", fixed("clean_sheet_away", (_h, away) => `${away} clean sheet`, yesNo)],
  ["Win To Nil", fixed("win_to_nil", () => "Win to nil", eitherTeam)],
  ["Double Chance - First Half", fixed("h1_double_chance", () => "1st half double chance", doubleChance)],
  ["Goals Over/Under First Half", lines("h1_goals", (_h, _a, line) => `1st half goals ${line}`, ["0.5", "1.5", "2.5"])],
  ["Both Teams Score - First Half", fixed("h1_btts", () => "1st half both teams score", yesNo)],
  ["Correct Score - First Half", scores("h1_correct_score", "1st half correct score")],
  ["Second Half Winner", fixed("h2_winner", () => "2nd half result", outcomes)],
  ["Goals Over/Under - Second Half", lines("h2_goals", (_h, _a, line) => `2nd half goals ${line}`, ["0.5", "1.5", "2.5"])],
  ["Both Teams To Score - Second Half", fixed("h2_btts", () => "2nd half both teams score", yesNo)],
  [
    "Highest Scoring Half",
    fixed("highest_half", () => "Highest scoring half", [
      ["1st Half", "first", () => "1st half"],
      ["2nd Half", "second", () => "2nd half"],
      ["Draw", "equal", () => "Equal"],
    ]),
  ],
  ["Win Both Halves", fixed("win_both_halves", () => "Win both halves", eitherTeam)],
  ["To Win Either Half", fixed("win_either_half", () => "Win either half", eitherTeam)],
  // Corners and cards settle from the match statistics fetched after full time.
  ["Corners Over Under", feedLines("corners", (_h, _a, line) => `Total corners ${line}`)],
  ["Home Corners Over/Under", feedLines("home_corners", (home, _a, line) => `${home} corners ${line}`)],
  ["Away Corners Over/Under", feedLines("away_corners", (_h, away, line) => `${away} corners ${line}`)],
  ["Cards Over/Under", feedLines("cards", (_h, _a, line) => `Total cards ${line}`)],
  ["Home Team Total Cards", feedLines("home_cards", (home, _a, line) => `${home} cards ${line}`)],
  ["Away Team Total Cards", feedLines("away_cards", (_h, away, line) => `${away} cards ${line}`)],
];
const MARKET_INDEX = new Map(MARKETS.map(([betName, build], index) => [betName, { build, index }]));

/**
 * Picks the markets we offer out of one bookmaker's odds. A market is kept
 * only when every one of its outcomes has a valid price, so a half-priced
 * market never reaches a Player.
 */
export function parseMarkets(raw: RawOdds, homeTeam: string, awayTeam: string, bookmakerId: number): FeedMarket[] {
  const bookmaker = raw.bookmakers.find((b) => b.id === bookmakerId) ?? raw.bookmakers[0];
  if (!bookmaker) return [];
  const markets: FeedMarket[] = [];
  const seen = new Set<string>();
  for (const bet of bookmaker.bets) {
    const spec = MARKET_INDEX.get(bet.name);
    if (!spec) continue;
    spec.build(bet, homeTeam, awayTeam).forEach((market, position) => {
      if (seen.has(market.key)) return;
      if (market.selections.some((s) => !Number.isFinite(s.odds) || s.odds <= 1)) return;
      seen.add(market.key);
      // Room for up to 10 lines per bet type while keeping the overall order.
      markets.push({ ...market, sortOrder: spec.index * 10 + position });
    });
  }
  return markets.sort((a, b) => a.sortOrder - b.sortOrder);
}

type LiveMarketSpec = {
  key: string;
  name: string;
  /** Only values with this handicap count, e.g. "2.5" for the goals line. */
  handicap?: string;
  values: Array<[feedValues: string[], key: string, name: (home: string, away: string) => string]>;
};

/**
 * In-play markets use different bet names from pre-match ones, so they're
 * matched on their own names (compared case-insensitively) onto the same
 * market and selection keys. Anything else in the feed is ignored.
 */
const LIVE_MARKETS: Record<string, LiveMarketSpec> = {
  "fulltime result": {
    key: "match_winner",
    name: "Match winner",
    values: [
      [["Home", "1"], "home", (home) => home],
      [["Draw", "X"], "draw", () => "Draw"],
      [["Away", "2"], "away", (_home, away) => away],
    ],
  },
  "double chance": {
    key: "double_chance",
    name: "Double chance",
    values: [
      [["Home/Draw", "1X"], "home_draw", (home) => `${home} or draw`],
      [["Home/Away", "12"], "home_away", (home, away) => `${home} or ${away}`],
      [["Draw/Away", "X2"], "draw_away", (_home, away) => `Draw or ${away}`],
    ],
  },
  "over/under line": {
    key: "goals_2_5",
    name: "Total goals 2.5",
    handicap: "2.5",
    values: [
      [["Over", "Over 2.5"], "over", () => "Over 2.5"],
      [["Under", "Under 2.5"], "under", () => "Under 2.5"],
    ],
  },
  "both teams to score": {
    key: "btts",
    name: "Both teams score",
    values: [
      [["Yes"], "yes", () => "Yes"],
      [["No"], "no", () => "No"],
    ],
  },
};
LIVE_MARKETS["match goals"] = LIVE_MARKETS["over/under line"];
const LIVE_ORDER = ["match_winner", "double_chance", "goals_2_5", "btts"];

/**
 * The in-play prices for one match. A market with any suspended or missing
 * outcome comes back suspended, with the prices it does have.
 */
export function parseLiveOdds(raw: RawLiveOdds, homeTeam: string, awayTeam: string): FeedLiveOdds {
  const markets = new Map<string, FeedLiveMarket>();
  for (const bet of raw.odds ?? []) {
    const spec = LIVE_MARKETS[bet.name.trim().toLowerCase()];
    if (!spec || markets.has(spec.key)) continue;
    let suspended = false;
    const selections = spec.values.map(([feedValues, key, name], sortOrder) => {
      const value = bet.values.find(
        (v) => feedValues.includes(String(v.value)) && (spec.handicap === undefined || String(v.handicap ?? "").trim() === spec.handicap || String(v.value).endsWith(spec.handicap)),
      );
      const odds = Number(value?.odd);
      if (!value || value.suspended || !Number.isFinite(odds) || odds <= 1) suspended = true;
      return { key, name: name(homeTeam, awayTeam), odds: Number.isFinite(odds) && odds > 1 ? odds : 0, sortOrder };
    });
    // A goals line the feed isn't offering right now (e.g. only 3.5 is up) is simply absent.
    if (spec.handicap && selections.every((s) => s.odds === 0)) continue;
    markets.set(spec.key, { key: spec.key, name: spec.name, sortOrder: LIVE_ORDER.indexOf(spec.key) * 10, selections, suspended });
  }
  return {
    externalId: String(raw.fixture.id),
    stopped: Boolean(raw.status?.stopped || raw.status?.blocked || raw.status?.finished),
    markets: [...markets.values()].sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

/** One team's numbers from `/fixtures/statistics`. A count the feed has no events for comes back null, meaning 0. */
export type RawTeamStatistics = {
  team: { id: number; name: string };
  statistics: Array<{ type: string; value: number | string | null }>;
};

/** Corners and cards for a finished match. Every yellow and every red card counts as one card. */
export type MatchStats = { cornersHome: number; cornersAway: number; cardsHome: number; cardsAway: number };

/**
 * Reads corners and cards out of a match's statistics. Returns null when the
 * feed has no statistics for the match (common outside the bigger leagues),
 * so those bets wait for Super Admin instead of settling on made-up zeros.
 */
export function parseStatistics(raw: RawTeamStatistics[], homeTeam: string): MatchStats | null {
  if (raw.length !== 2) return null;
  // Home comes first in the feed; the name check guards against it ever flipping.
  const [first, second] = raw;
  const [home, away] = second.team.name === homeTeam && first.team.name !== homeTeam ? [second, first] : [first, second];
  const read = (team: RawTeamStatistics, type: string): number | undefined => {
    const stat = team.statistics.find((s) => s.type === type);
    if (!stat) return undefined;
    const value = Number(stat.value ?? 0);
    return Number.isFinite(value) ? value : undefined;
  };
  const cornersHome = read(home, "Corner Kicks");
  const cornersAway = read(away, "Corner Kicks");
  const yellowHome = read(home, "Yellow Cards");
  const yellowAway = read(away, "Yellow Cards");
  if (cornersHome === undefined || cornersAway === undefined || yellowHome === undefined || yellowAway === undefined) return null;
  return {
    cornersHome,
    cornersAway,
    cardsHome: yellowHome + (read(home, "Red Cards") ?? 0),
    cardsAway: yellowAway + (read(away, "Red Cards") ?? 0),
  };
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

  /** Corners and cards for one finished match, or null if the feed has no statistics for it. */
  async statistics(fixtureId: string, homeTeam: string): Promise<MatchStats | null> {
    const res = (await this.fetchJson("/fixtures/statistics", { fixture: fixtureId })) as ApiResponse<RawTeamStatistics>;
    return parseStatistics(res.response, homeTeam);
  }

  /** In-play odds for every match the feed is pricing live, in one request. */
  async liveOdds(): Promise<RawLiveOdds[]> {
    const res = (await this.fetchJson("/odds/live", {})) as ApiResponse<RawLiveOdds>;
    return res.response;
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

/**
 * Real HTTP access. API-Football reports problems in `errors` with a 200
 * status. Same data, two ways to reach it:
 * - direct (api-sports.io): host `v3.football.api-sports.io`, paths as-is,
 *   key sent as `x-apisports-key`.
 * - RapidAPI: host `api-football-v1.p.rapidapi.com`, paths need a `/v3`
 *   prefix, key sent as `x-rapidapi-key` (+ `x-rapidapi-host`).
 * Detected from the host string, so switching providers is just an env var
 * change (API_FOOTBALL_HOST) — no other config needed.
 */
export function httpFetchJson(host: string, apiKey: string): FetchJson {
  const rapidApi = host.includes("rapidapi.com");
  const base = rapidApi ? `${host}/v3` : host;
  return async (path, params) => {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`https://${base}${path}?${query}`, {
      headers: rapidApi
        ? { "x-rapidapi-key": apiKey, "x-rapidapi-host": host }
        : { "x-apisports-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`API-Football answered ${res.status} for ${path}`);
    const body = (await res.json()) as ApiResponse<unknown>;
    const errors = body.errors && typeof body.errors === "object" ? Object.values(body.errors as Record<string, string>) : [];
    if (errors.length > 0) throw new Error(`API-Football: ${errors.join("; ")}`);
    return body;
  };
}
