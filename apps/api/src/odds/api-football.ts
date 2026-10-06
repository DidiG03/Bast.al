import { EventStatus } from "@prisma/client";
import type { Goal, GoalRecord, Participant, Side } from "../bets/goals";

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
  teams: { home: { id?: number; name: string }; away: { id?: number; name: string } };
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
  /** The feed says the match is over, often a minute before the fixtures list does. */
  finished: boolean;
  /** The score and minute the prices were made for, when the feed sends them. */
  homeScore: number | null;
  awayScore: number | null;
  elapsed: number | null;
  markets: FeedLiveMarket[];
};

/** A competition with a season in progress, for Super Admin's league picker. */
export type FeedLeague = { id: number; name: string; type: "League" | "Cup"; country: string };

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
  /** The feed's short status ("1H", "HT", "2H" …), for showing half-time and other breaks. */
  period: string;
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
    period: raw.fixture.status.short,
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
const oddEven: Array<[string, string, Namer]> = [
  ["Odd", "odd", () => "Odd"],
  ["Even", "even", () => "Even"],
];
const halves: Array<[string, string, Namer]> = [
  ["1st Half", "first", () => "1st half"],
  ["2nd Half", "second", () => "2nd half"],
  ["Draw", "equal", () => "Equal"],
];
const sideName = (side: string, home: string, away: string) => (side === "home" ? home : side === "away" ? away : "Draw");
const pairs = (left: string[], right: string[]) => left.flatMap((l) => right.map((r) => [l, r] as const));
const cap = (word: string) => word[0].toUpperCase() + word.slice(1);

/**
 * A count's exact value ("0", "1", "2", "more 3"), keyed "0", "1", "2", "3+".
 * The top value is "N or more", so every outcome is covered.
 */
function exactCount(key: string, name: Namer, top: number) {
  return fixed(key, name, [
    ...Array.from({ length: top }, (_, n): [string, string, Namer] => [String(n), String(n), () => `${n} goals`]),
    [`more ${top}`, `${top}+`, () => `${top}+ goals`],
  ]);
}

/**
 * Two markets in one ("Home/Over 2.5", "o/yes 2.5"): one market per line the
 * feed prices, keyed `{prefix}_X_5`, with an outcome for every pair.
 * `parse` reads a feed value into [left key, right key, line].
 */
function comboLines(
  prefix: string,
  name: (line: string) => string,
  parse: (value: string) => [left: string, right: string, line: string] | null,
  label: (left: string, right: string, line: string, home: string, away: string) => string,
  order: { left: string[]; right: string[] },
) {
  return (bet: FeedBet, home: string, away: string): Built[] => {
    const byLine = new Map<string, Map<string, number>>();
    for (const v of bet.values) {
      const parsed = parse(String(v.value));
      if (!parsed || !/^\d+\.5$/.test(parsed[2])) continue;
      const [left, right, line] = parsed;
      if (!byLine.has(line)) byLine.set(line, new Map());
      byLine.get(line)!.set(`${left}_${right}`, Number(v.odd));
    }
    return [...byLine.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([line, prices]) => ({
        key: `${prefix}_${line.replace(".", "_")}`,
        name: name(line),
        selections: pairs(order.left, order.right).map(([left, right], sortOrder) => ({
          key: `${left}_${right}`,
          name: label(left, right, line, home, away),
          odds: prices.get(`${left}_${right}`) ?? NaN,
          sortOrder,
        })),
      }));
  };
}

const signedLine = (line: number) => `${line > 0 ? "+" : line < 0 ? "−" : ""}${Math.abs(line)}`;
/** "-1.5" → "m1_5", "1" → "p1", "0" → "0", for a market key. */
const handicapKey = (line: number) => `${line < 0 ? "m" : line > 0 ? "p" : ""}${String(Math.abs(line)).replace(".", "_")}`;

/**
 * Handicaps, "Home -1.5" and "Away -1.5": the number is the home team's
 * handicap on both sides (as in API-Sports' basketball odds). Asian lines
 * are half lines only, two outcomes and no push; European ones ("Handicap
 * Result": "Home -1", "Draw -1", "Away -1") whole lines with a draw. Up to
 * `max` lines, the most evenly priced and those nearest it.
 */
function handicaps(prefix: string, name: (home: string, line: string) => string, european: boolean, max = 3) {
  return (bet: FeedBet, home: string, away: string): Built[] => {
    const byLine = new Map<number, Map<string, number>>();
    for (const v of bet.values) {
      const m = /^(Home|Draw|Away) ([+-]?\d+(?:\.\d+)?)$/.exec(String(v.value).trim());
      if (!m) continue;
      const line = Number(m[2]);
      const half = Math.abs((Math.abs(line) % 1) - 0.5) < 1e-9;
      if (european ? !Number.isInteger(line) || line === 0 : !half) continue;
      if (!byLine.has(line)) byLine.set(line, new Map());
      byLine.get(line)!.set(m[1].toLowerCase(), Number(v.odd));
    }
    const sides = european ? ["home", "draw", "away"] : ["home", "away"];
    const priced = [...byLine.entries()].filter(([, prices]) => sides.every((side) => (prices.get(side) ?? 0) > 1));
    if (priced.length === 0) return [];
    const spread = (prices: Map<string, number>) => Math.abs(prices.get("home")! - prices.get("away")!);
    const even = priced.reduce((best, entry) => (spread(entry[1]) < spread(best[1]) ? entry : best))[0];
    return priced
      .sort(([a], [b]) => Math.abs(a - even) - Math.abs(b - even))
      .slice(0, max)
      .sort(([a], [b]) => a - b)
      .map(([line, prices]) => ({
        key: `${prefix}_${handicapKey(line)}`,
        name: name(home, signedLine(line)),
        selections: sides.map((side, sortOrder) => ({
          key: side,
          name: side === "home" ? `${home} ${signedLine(line)}` : side === "away" ? `${away} ${signedLine(-line)}` : `Draw (${signedLine(line)})`,
          odds: prices.get(side)!,
          sortOrder,
        })),
      }));
  };
}

/** Corner ranges ("Under 6", "6 - 8", "Over 14"), whose bands change from match to match. Keyed "u6", "6-8", "o14". */
function countRanges(key: string, name: string) {
  return (bet: FeedBet): Built[] => {
    const selections = bet.values
      .map((v) => {
        const value = String(v.value).trim();
        const under = /^Under (\d+)$/.exec(value);
        const over = /^Over (\d+)$/.exec(value);
        const band = /^(\d+) - (\d+)$/.exec(value);
        if (under) return { key: `u${under[1]}`, name: `Under ${under[1]}`, from: -1, odds: Number(v.odd) };
        if (over) return { key: `o${over[1]}`, name: `Over ${over[1]}`, from: Number(over[1]) + 1, odds: Number(v.odd) };
        if (band) return { key: `${band[1]}-${band[2]}`, name: `${band[1]}–${band[2]}`, from: Number(band[1]), odds: Number(v.odd) };
        return null;
      })
      .filter((v): v is { key: string; name: string; from: number; odds: number } => v !== null)
      .sort((a, b) => a.from - b.from)
      .map(({ key: selectionKey, name: selectionName, odds }, sortOrder) => ({ key: selectionKey, name: selectionName, odds, sortOrder }));
    return selections.length >= 3 ? [{ key, name, selections }] : [];
  };
}

/** Winning margin: "1 by 2" is the home team by 2, "2 by 4+" the away team by 4 or more; "Score Draw" a draw with goals, "Draw" 0–0. */
const winningMargin: Array<[string, string, Namer]> = [
  ...(["home", "away"] as const).flatMap((side) =>
    ["1", "2", "3", "4+"].map((by): [string, string, Namer] => [`${side === "home" ? 1 : 2} by ${by}`, `${side}_${by}`, (home, away) => `${side === "home" ? home : away} by ${by}`]),
  ),
  ["Score Draw", "score_draw", () => "Score draw"],
  ["Draw", "no_goal", () => "0–0"],
];

/**
 * Goalscorer markets: one outcome per player the feed prices, keyed by the
 * name in plain letters ("memphis-depay"), the shortest price first, plus
 * "No goalscorer" where the feed offers it. A player whose price is missing
 * is left out rather than dropping the whole market.
 */
function goalscorers(key: string, name: string) {
  return (bet: FeedBet): Built[] => {
    const seen = new Set<string>();
    const players = bet.values
      .map((v) => ({ value: String(v.value).trim(), odds: Number(v.odd) }))
      .filter((v) => v.value.length > 0 && Number.isFinite(v.odds) && v.odds > 1)
      .map((v) => (/^no goal ?scorer$/i.test(v.value) ? { key: "none", name: "No goalscorer", odds: v.odds } : { key: playerKey(v.value), name: v.value, odds: v.odds }))
      .filter((v) => v.key.length > 0 && !seen.has(v.key) && Boolean(seen.add(v.key)))
      .sort((a, b) => (a.key === "none" ? 1 : 0) - (b.key === "none" ? 1 : 0) || a.odds - b.odds || a.name.localeCompare(b.name))
      .map((v, sortOrder) => ({ ...v, sortOrder }));
    return players.filter((p) => p.key !== "none").length >= 2 ? [{ key, name, selections: players }] : [];
  };
}

/** A player's name in plain lowercase letters, words joined by "-": "Agustín Sant'Anna" → "agustin-sant-anna". */
export function playerKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

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
  // Handicaps settle on the 90-minute score like everything else.
  ["Asian Handicap", handicaps("ah", (home, line) => `Asian handicap ${home} ${line}`, false)],
  ["Handicap Result", handicaps("eh", (home, line) => `Handicap ${home} ${line}`, true)],
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
  // Two markets in one.
  [
    "Result/Total Goals",
    comboLines(
      "result_goals",
      (line) => `Result and total goals ${line}`,
      (value) => {
        const m = /^(Home|Draw|Away)\/(Over|Under) (\d+(?:\.\d+)?)$/.exec(value);
        return m ? [m[1].toLowerCase(), m[2].toLowerCase(), m[3]] : null;
      },
      (side, ou, line, home, away) => `${sideName(side, home, away)} / ${cap(ou)} ${line}`,
      { left: ["home", "draw", "away"], right: ["over", "under"] },
    ),
  ],
  [
    "Total Goals/Both Teams To Score",
    comboLines(
      "goals_btts",
      (line) => `Total goals ${line} and both teams score`,
      (value) => {
        const m = /^(o|u)\/(yes|no) (\d+(?:\.\d+)?)$/i.exec(value);
        return m ? [m[1].toLowerCase() === "o" ? "over" : "under", m[2].toLowerCase(), m[3]] : null;
      },
      (ou, yn, line) => `${cap(ou)} ${line} / ${cap(yn)}`,
      { left: ["over", "under"], right: ["yes", "no"] },
    ),
  ],
  ["Exact Score", scores("correct_score", "Correct score")],
  [
    "Winning Margin",
    fixed("winning_margin", () => "Winning margin", winningMargin),
  ],
  [
    "Number Of Goals In Match",
    fixed("goal_range", () => "Number of goals", [
      ["Under 2 goals", "0-1", () => "0–1 goals"],
      ["2 or 3 goals", "2-3", () => "2–3 goals"],
      ["Over 3 goals", "4+", () => "4+ goals"],
    ]),
  ],
  [
    "Exact Goals Number",
    fixed("exact_goals", () => "Exact total goals", [
      ...["0", "1", "2", "3", "4", "5", "6"].map((n): [string, string, Namer] => [n, n, () => `${n} goals`]),
      ["more 7", "7+", () => "7+ goals"],
    ]),
  ],
  ["Total - Home", lines("home_goals", (home, _a, line) => `${home} goals ${line}`, ["0.5", "1.5", "2.5"])],
  ["Total - Away", lines("away_goals", (_h, away, line) => `${away} goals ${line}`, ["0.5", "1.5", "2.5"])],
  ["Home Team Exact Goals Number", exactCount("home_exact_goals", (home) => `${home} exact goals`, 3)],
  ["Away Team Exact Goals Number", exactCount("away_exact_goals", (_h, away) => `${away} exact goals`, 3)],
  [
    "Odd/Even",
    fixed("odd_even", () => "Total goals odd/even", oddEven),
  ],
  ["Home Odd/Even", fixed("home_odd_even", (home) => `${home} goals odd/even`, oddEven)],
  ["Away Odd/Even", fixed("away_odd_even", (_h, away) => `${away} goals odd/even`, oddEven)],
  ["Clean Sheet - Home", fixed("clean_sheet_home", (home) => `${home} clean sheet`, yesNo)],
  ["Clean Sheet - Away", fixed("clean_sheet_away", (_h, away) => `${away} clean sheet`, yesNo)],
  ["Home Team Score a Goal", fixed("home_scores", (home) => `${home} to score`, yesNo)],
  ["Away Team Score a Goal", fixed("away_scores", (_h, away) => `${away} to score`, yesNo)],
  ["Win To Nil", fixed("win_to_nil", () => "Win to nil", eitherTeam)],
  ["Win to Nil - Home", fixed("win_to_nil_home", (home) => `${home} to win to nil`, yesNo)],
  ["Win to Nil - Away", fixed("win_to_nil_away", (_h, away) => `${away} to win to nil`, yesNo)],
  // Settle from the order of the goals, fetched after full time (see bets/goals.ts).
  ["Team To Score First", fixed("first_team_score", () => "First team to score", [...eitherTeam, ["No goal", "none", () => "No goal"]])],
  ["Team To Score Last", fixed("last_team_score", () => "Last team to score", [...eitherTeam, ["No goal", "none", () => "No goal"]])],
  ["To Win From Behind", fixed("win_from_behind", () => "Win from behind", eitherTeam)],
  ["Anytime Goal Scorer", goalscorers("scorer_anytime", "Anytime goalscorer")],
  ["First Goal Scorer", goalscorers("scorer_first", "First goalscorer")],
  ["Last Goal Scorer", goalscorers("scorer_last", "Last goalscorer")],
  ["Double Chance - First Half", fixed("h1_double_chance", () => "1st half double chance", doubleChance)],
  ["Asian Handicap First Half", handicaps("h1_ah", (home, line) => `1st half Asian handicap ${home} ${line}`, false)],
  ["Handicap Result - First Half", handicaps("h1_eh", (home, line) => `1st half handicap ${home} ${line}`, true)],
  ["Home Team Total Goals(1st Half)", lines("h1_home_goals", (home, _a, line) => `${home} 1st half goals ${line}`, ["0.5", "1.5"])],
  ["Away Team Total Goals(1st Half)", lines("h1_away_goals", (_h, away, line) => `${away} 1st half goals ${line}`, ["0.5", "1.5"])],
  ["Goals Over/Under First Half", lines("h1_goals", (_h, _a, line) => `1st half goals ${line}`, ["0.5", "1.5", "2.5"])],
  ["Both Teams Score - First Half", fixed("h1_btts", () => "1st half both teams score", yesNo)],
  ["Correct Score - First Half", scores("h1_correct_score", "1st half correct score")],
  ["Exact Goals Number - First Half", exactCount("h1_exact_goals", () => "1st half exact goals", 5)],
  ["Odd/Even - First Half", fixed("h1_odd_even", () => "1st half goals odd/even", oddEven)],
  ["Second Half Winner", fixed("h2_winner", () => "2nd half result", outcomes)],
  ["Double Chance - Second Half", fixed("h2_double_chance", () => "2nd half double chance", doubleChance)],
  ["Home Team Total Goals(2nd Half)", lines("h2_home_goals", (home, _a, line) => `${home} 2nd half goals ${line}`, ["0.5", "1.5"])],
  ["Away Team Total Goals(2nd Half)", lines("h2_away_goals", (_h, away, line) => `${away} 2nd half goals ${line}`, ["0.5", "1.5"])],
  ["Goals Over/Under - Second Half", lines("h2_goals", (_h, _a, line) => `2nd half goals ${line}`, ["0.5", "1.5", "2.5"])],
  ["Both Teams To Score - Second Half", fixed("h2_btts", () => "2nd half both teams score", yesNo)],
  ["Second Half Exact Goals Number", exactCount("h2_exact_goals", () => "2nd half exact goals", 5)],
  ["Odd/Even - Second Half", fixed("h2_odd_even", () => "2nd half goals odd/even", oddEven)],
  [
    "Highest Scoring Half",
    fixed("highest_half", () => "Highest scoring half", halves),
  ],
  ["Win Both Halves", fixed("win_both_halves", () => "Win both halves", eitherTeam)],
  ["To Win Either Half", fixed("win_either_half", () => "Win either half", eitherTeam)],
  ["Home win both halves", fixed("home_win_both_halves", (home) => `${home} to win both halves`, yesNo)],
  ["Away win both halves", fixed("away_win_both_halves", (_h, away) => `${away} to win both halves`, yesNo)],
  // Two separate bets in one list: each team scoring in both halves.
  ["To Score In Both Halves By Teams", fixed("score_both_halves", () => "Score in both halves", eitherTeam)],
  ["Home Highest Scoring Half", fixed("home_highest_half", (home) => `${home} highest scoring half`, halves)],
  ["Away Highest Scoring Half", fixed("away_highest_half", (_h, away) => `${away} highest scoring half`, halves)],
  // Corners and cards settle from the match statistics fetched after full time.
  ["Corners Over Under", feedLines("corners", (_h, _a, line) => `Total corners ${line}`)],
  ["Home Corners Over/Under", feedLines("home_corners", (home, _a, line) => `${home} corners ${line}`)],
  ["Away Corners Over/Under", feedLines("away_corners", (_h, away, line) => `${away} corners ${line}`)],
  ["Corners 1x2", fixed("corners_1x2", () => "Most corners", outcomes)],
  ["Corners. Total (Range)", countRanges("corners_range", "Total corners range")],
  ["Corners Asian Handicap", handicaps("corners_ah", (home, line) => `Corners handicap ${home} ${line}`, false)],
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

type LiveValue = RawLiveOdds["odds"][number]["values"][number];

/**
 * How one in-play bet maps onto our markets. `order` names the pre-match bet
 * the market sits with, so live-only markets line up with the rest.
 * - fixed: known outcomes; `partial` markets (many outcomes, some of which
 *   become impossible) stay open with just the outcomes still priced;
 * - lines: over/under, one `{prefix}_X_5` market per .5 line;
 * - scores: correct score, every scoreline the feed prices.
 */
type LiveSpec =
  | { kind: "fixed"; key: string; name: Namer; order: string; values: Array<[aliases: string[], key: string, name: Namer]>; partial?: boolean }
  | { kind: "lines"; prefix: string; name: (home: string, away: string, line: string) => string; order: string }
  | { kind: "scores"; key: string; name: string; order: string };

const SIDE_ALIASES: Record<string, string[]> = { home: ["home", "1"], draw: ["draw", "x"], away: ["away", "2"] };
const liveOutcomes: Array<[string[], string, Namer]> = [
  [SIDE_ALIASES.home, "home", (home) => home],
  [SIDE_ALIASES.draw, "draw", () => "Draw"],
  [SIDE_ALIASES.away, "away", (_home, away) => away],
];
const liveYesNo: Array<[string[], string, Namer]> = [
  [["yes"], "yes", () => "Yes"],
  [["no"], "no", () => "No"],
];
const liveEitherTeam: Array<[string[], string, Namer]> = [
  [SIDE_ALIASES.home, "home", (home) => home],
  [SIDE_ALIASES.away, "away", (_home, away) => away],
];
const liveDoubleChance: Array<[string[], string, Namer]> = [
  [["home/draw", "draw/home", "1x", "1/x"], "home_draw", (home) => `${home} or draw`],
  [["home/away", "away/home", "12", "1/2"], "home_away", (home, away) => `${home} or ${away}`],
  [["draw/away", "away/draw", "x2", "x/2"], "draw_away", (_home, away) => `Draw or ${away}`],
];
const sides = ["home", "draw", "away"] as const;
const liveHtFt: Array<[string[], string, Namer]> = sides.flatMap((ht) =>
  sides.map((ft): [string[], string, Namer] => [
    SIDE_ALIASES[ht].flatMap((l) => SIDE_ALIASES[ft].map((r) => `${l}/${r}`)),
    `${ht}_${ft}`,
    (home, away) => `${sideName(ht, home, away)} / ${sideName(ft, home, away)}`,
  ]),
);
const liveResultBtts: Array<[string[], string, Namer]> = sides.flatMap((side) =>
  (["yes", "no"] as const).map((btts): [string[], string, Namer] => [
    SIDE_ALIASES[side].map((l) => `${l}/${btts}`),
    `${side}_${btts}`,
    (home, away) => `${sideName(side, home, away)} / ${cap(btts)}`,
  ]),
);

/**
 * In-play markets use different bet names from pre-match ones (see
 * API-Football's /odds/live/bets), so they're matched on their own names,
 * compared case-insensitively, onto the same market and selection keys, and
 * settle the same way. Anything else in the feed is ignored.
 */
const LIVE_MARKETS: Record<string, LiveSpec> = {
  "fulltime result": { kind: "fixed", key: "match_winner", name: () => "Match winner", order: "Match Winner", values: liveOutcomes },
  "double chance": { kind: "fixed", key: "double_chance", name: () => "Double chance", order: "Double Chance", values: liveDoubleChance },
  "over/under line": { kind: "lines", prefix: "goals", name: (_h, _a, line) => `Total goals ${line}`, order: "Goals Over/Under" },
  "match goals": { kind: "lines", prefix: "goals", name: (_h, _a, line) => `Total goals ${line}`, order: "Goals Over/Under" },
  "both teams to score": { kind: "fixed", key: "btts", name: () => "Both teams score", order: "Both Teams Score", values: liveYesNo },
  "draw no bet": { kind: "fixed", key: "draw_no_bet", name: () => "Draw no bet", order: "Home/Away", values: liveEitherTeam },
  "1x2 (1st half)": { kind: "fixed", key: "h1_winner", name: () => "1st half result", order: "First Half Winner", values: liveOutcomes },
  "half time/full time": { kind: "fixed", key: "ht_ft", name: () => "Half time / full time", order: "HT/FT Double", values: liveHtFt, partial: true },
  "result / both teams to score": { kind: "fixed", key: "result_btts", name: () => "Result and both teams score", order: "Results/Both Teams Score", values: liveResultBtts, partial: true },
  "final score": { kind: "scores", key: "correct_score", name: "Correct score", order: "Exact Score" },
  "home team goals": { kind: "lines", prefix: "home_goals", name: (home, _a, line) => `${home} goals ${line}`, order: "Total - Home" },
  "away team goals": { kind: "lines", prefix: "away_goals", name: (_h, away, line) => `${away} goals ${line}`, order: "Total - Away" },
  "goals odd/even": {
    kind: "fixed",
    key: "odd_even",
    name: () => "Total goals odd/even",
    order: "Odd/Even",
    values: [
      [["odd"], "odd", () => "Odd"],
      [["even"], "even", () => "Even"],
    ],
  },
  "home team clean sheet": { kind: "fixed", key: "clean_sheet_home", name: (home) => `${home} clean sheet`, order: "Clean Sheet - Home", values: liveYesNo },
  "away team clean sheet": { kind: "fixed", key: "clean_sheet_away", name: (_h, away) => `${away} clean sheet`, order: "Clean Sheet - Away", values: liveYesNo },
  "double chance (1st half)": { kind: "fixed", key: "h1_double_chance", name: () => "1st half double chance", order: "Double Chance - First Half", values: liveDoubleChance },
  "over/under line (1st half)": { kind: "lines", prefix: "h1_goals", name: (_h, _a, line) => `1st half goals ${line}`, order: "Goals Over/Under First Half" },
  "over/under (1st half)": { kind: "lines", prefix: "h1_goals", name: (_h, _a, line) => `1st half goals ${line}`, order: "Goals Over/Under First Half" },
  "both teams to score (1st half)": { kind: "fixed", key: "h1_btts", name: () => "1st half both teams score", order: "Both Teams Score - First Half", values: liveYesNo },
  "correct score (1st half)": { kind: "scores", key: "h1_correct_score", name: "1st half correct score", order: "Correct Score - First Half" },
  "to win 2nd half": { kind: "fixed", key: "h2_winner", name: () => "2nd half result", order: "Second Half Winner", values: liveOutcomes },
  "over/under (2nd half)": { kind: "lines", prefix: "h2_goals", name: (_h, _a, line) => `2nd half goals ${line}`, order: "Goals Over/Under - Second Half" },
  "both teams to score (2nd half)": { kind: "fixed", key: "h2_btts", name: () => "2nd half both teams score", order: "Both Teams To Score - Second Half", values: liveYesNo },
  // Corners and cards settle from the match statistics fetched after full time.
  "total corners": { kind: "lines", prefix: "corners", name: (_h, _a, line) => `Total corners ${line}`, order: "Corners Over Under" },
  "match corners": { kind: "lines", prefix: "corners", name: (_h, _a, line) => `Total corners ${line}`, order: "Corners Over Under" },
  "home total corners": { kind: "lines", prefix: "home_corners", name: (home, _a, line) => `${home} corners ${line}`, order: "Home Corners Over/Under" },
  "away total corners": { kind: "lines", prefix: "away_corners", name: (_h, away, line) => `${away} corners ${line}`, order: "Away Corners Over/Under" },
  "total cards": { kind: "lines", prefix: "cards", name: (_h, _a, line) => `Total cards ${line}`, order: "Cards Over/Under" },
};

/** Lower case, no spaces, "&" and " or " as "/", so "Home or Draw", "Home & Yes" and "home/yes" compare alike. */
const normalize = (value: string | number) =>
  String(value)
    .toLowerCase()
    .replace(/\s+or\s+/g, "/")
    .replace(/\s+/g, "")
    .replace(/&/g, "/");

function livePrice(value?: LiveValue): number {
  const odds = Number(value?.odd);
  return value && !value.suspended && Number.isFinite(odds) && odds > 1 ? odds : 0;
}

function liveMarkets(spec: LiveSpec, values: LiveValue[], home: string, away: string): FeedLiveMarket[] {
  const base = (MARKET_INDEX.get(spec.order)?.index ?? MARKETS.length) * 10;
  if (spec.kind === "fixed") {
    const selections = spec.values.map(([aliases, key, name], sortOrder) => ({
      key,
      name: name(home, away),
      odds: livePrice(values.find((v) => aliases.includes(normalize(v.value)))),
      sortOrder,
    }));
    const priced = selections.filter((s) => s.odds > 0).length;
    // A two- or three-way market is off the board if any outcome is; a partial one while none is priced.
    const suspended = spec.partial ? priced === 0 : priced < selections.length;
    return [{ key: spec.key, name: spec.name(home, away), sortOrder: base, selections: spec.partial ? selections.filter((s) => s.odds > 0) : selections, suspended }];
  }
  if (spec.kind === "scores") {
    const selections = values
      .map((v) => ({ match: /^(\d+)[:-](\d+)$/.exec(normalize(v.value)), odds: livePrice(v) }))
      .filter((v): v is { match: RegExpExecArray; odds: number } => v.match !== null && v.odds > 0)
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]) || Number(a.match[2]) - Number(b.match[2]))
      .map((v, sortOrder) => ({ key: `${v.match[1]}-${v.match[2]}`, name: `${v.match[1]}–${v.match[2]}`, odds: v.odds, sortOrder }));
    return selections.length > 0 ? [{ key: spec.key, name: spec.name, sortOrder: base, selections, suspended: false }] : [];
  }
  return liveLines(values, spec.prefix, (line) => spec.name(home, away, line), base);
}

/**
 * The in-play prices for one match. Markets the feed suspends, or two- and
 * three-way markets missing an outcome, come back suspended with the prices
 * they do have; a market the feed doesn't send at all is left out, which
 * suspends it.
 */
export function parseLiveOdds(raw: RawLiveOdds, homeTeam: string, awayTeam: string): FeedLiveOdds {
  const markets = new Map<string, FeedLiveMarket>();
  for (const bet of raw.odds ?? []) {
    const spec = LIVE_MARKETS[bet.name.trim().toLowerCase()];
    if (!spec) continue;
    for (const market of liveMarkets(spec, bet.values, homeTeam, awayTeam)) if (!markets.has(market.key)) markets.set(market.key, market);
  }
  return {
    externalId: String(raw.fixture.id),
    stopped: Boolean(raw.status?.stopped || raw.status?.blocked || raw.status?.finished),
    finished: Boolean(raw.status?.finished),
    homeScore: goals(raw.teams?.home?.goals),
    awayScore: goals(raw.teams?.away?.goals),
    elapsed: goals(raw.fixture.status?.elapsed),
    markets: [...markets.values()].sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

const goals = (value: number | null | undefined) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

/**
 * The lines in an in-play over/under market, one `{prefix}_X_5` market per .5
 * line. The line is in `handicap`, or in the value itself ("Over 2.5"); whole
 * and quarter lines are skipped, so there's never a push. A line the feed
 * isn't offering right now (1.5 once two goals are in) is simply absent,
 * which suspends it.
 */
function liveLines(values: LiveValue[], prefix: string, name: (line: string) => string, base: number): FeedLiveMarket[] {
  const byLine = new Map<string, { over?: LiveValue; under?: LiveValue }>();
  for (const value of values) {
    const [, side, inValue] = /^(over|under)(?:\s+(\d+(?:\.\d+)?))?$/i.exec(String(value.value).trim()) ?? [];
    const line = String(value.handicap ?? "").trim() || inValue;
    if (!side || !line || !/^\d+\.5$/.test(line)) continue;
    const entry = byLine.get(line) ?? {};
    if (side.toLowerCase() === "over") entry.over ??= value;
    else entry.under ??= value;
    byLine.set(line, entry);
  }
  return [...byLine]
    .map(([line, { over, under }]) => {
      const selections = [
        { key: "over", name: `Over ${line}`, odds: livePrice(over), sortOrder: 0 },
        { key: "under", name: `Under ${line}`, odds: livePrice(under), sortOrder: 1 },
      ];
      return {
        key: `${prefix}_${line.replace(".", "_")}`,
        name: name(line),
        sortOrder: base + Math.min(9, Math.floor(Number(line))),
        selections,
        suspended: selections.some((selection) => selection.odds === 0),
      };
    })
    .filter((market) => market.selections.some((selection) => selection.odds > 0))
    .sort((a, b) => a.sortOrder - b.sortOrder);
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

type RawPerson = { id: number | null; name: string | null };

/** A fixture fetched by id, which comes with its events, lineups and player numbers. */
export type RawFixtureDetail = RawFixture & {
  events?: Array<{ time: { elapsed: number | null; extra?: number | null }; team: { id: number; name: string }; player: RawPerson; assist: RawPerson; type: string; detail: string }>;
  lineups?: Array<{ team: { id: number; name: string }; startXI: Array<{ player: RawPerson }>; substitutes: Array<{ player: RawPerson }> }>;
  players?: Array<{ team: { id: number; name: string }; players: Array<{ player: RawPerson; statistics: Array<{ games?: { minutes?: number | null } }> }> }>;
};

/**
 * The goals of a finished match in order, and who took part, for the
 * goal-event markets (see bets/goals.ts). Returns null when the goals the
 * feed lists don't add up to the 90-minute score, so nothing settles on a
 * list that's still being corrected.
 * - Missed penalties and extra-time goals are left out, and a goal VAR ruled
 *   out is dropped.
 * - The feed gives an own goal to the team it counts for; if the score only
 *   adds up the other way round, that way is used.
 * - In a substitution the feed names the players both ways round in
 *   different matches, so whoever of the two started on the bench came on.
 */
export function parseGoalRecord(raw: RawFixtureDetail, score: { home: number; away: number }): GoalRecord | null {
  const homeId = raw.teams.home.id;
  const sideOfTeam = (team: { id: number; name: string }): Side => (homeId !== undefined ? (team.id === homeId ? "home" : "away") : team.name === raw.teams.home.name ? "home" : "away");
  const events = raw.events ?? [];
  const ruledOut = new Set<number>();
  events.forEach((event, at) => {
    if (event.type !== "Var" || !/goal (cancelled|disallowed)/i.test(event.detail)) return;
    for (let i = at - 1; i >= 0; i--) {
      const goal = events[i];
      if (goal.type === "Goal" && goal.team.id === event.team.id && !ruledOut.has(i) && (event.time.elapsed ?? 0) - (goal.time.elapsed ?? 0) <= 5) {
        ruledOut.add(i);
        break;
      }
    }
  });
  const goals: Goal[] = [];
  events.forEach((event, at) => {
    if (event.type !== "Goal" || /^missed penalty$/i.test(event.detail) || ruledOut.has(at)) return;
    const minute = event.time.elapsed;
    if (minute === null || minute > 90) return;
    goals.push({
      minute,
      side: sideOfTeam(event.team),
      playerId: event.player.id,
      player: event.player.name,
      ownGoal: /^own goal$/i.test(event.detail),
      penalty: /^penalty$/i.test(event.detail),
      at,
    });
  });
  const adds = (list: Goal[]) => list.filter((g) => g.side === "home").length === score.home && list.filter((g) => g.side === "away").length === score.away;
  let counted = goals;
  if (!adds(counted)) {
    const flipped = goals.map((g): Goal => (g.ownGoal ? { ...g, side: g.side === "home" ? "away" : "home" } : g));
    if (!adds(flipped)) return null;
    counted = flipped;
  }

  const people = new Map<number, Participant & { started: boolean; bench: boolean; minutes: number | null }>();
  const person = (who: RawPerson, side: Side) => {
    if (who.id === null || who.id === undefined) return null;
    let row = people.get(who.id);
    if (!row) {
      row = { id: who.id, side, names: [], played: false, cameOnAt: null, started: false, bench: false, minutes: null };
      people.set(who.id, row);
    }
    if (who.name && !row.names.includes(who.name)) row.names.push(who.name);
    return row;
  };
  for (const lineup of raw.lineups ?? []) {
    const side = sideOfTeam(lineup.team);
    for (const { player } of lineup.startXI ?? []) {
      const row = person(player, side);
      if (row) row.started = true;
    }
    for (const { player } of lineup.substitutes ?? []) {
      const row = person(player, side);
      if (row) row.bench = true;
    }
  }
  let anyMinutes = false;
  for (const team of raw.players ?? []) {
    const side = sideOfTeam(team.team);
    for (const entry of team.players ?? []) {
      const row = person(entry.player, side);
      const minutes = entry.statistics?.[0]?.games?.minutes ?? null;
      if (row && minutes !== null) {
        row.minutes = minutes;
        anyMinutes = true;
      }
    }
  }
  if (people.size === 0) return { goals: counted, players: null };
  events.forEach((event, at) => {
    const side = sideOfTeam(event.team);
    const actors = [person(event.player, side), event.type === "subst" ? person(event.assist, side) : null];
    if (event.type !== "subst") return;
    for (const row of actors) if (row && row.bench && !row.started && row.cameOnAt === null) row.cameOnAt = at;
  });
  const players = [...people.values()].map(
    (row): Participant => ({
      id: row.id,
      side: row.side,
      names: row.names,
      cameOnAt: row.cameOnAt,
      played: row.started || row.cameOnAt !== null || (anyMinutes && row.minutes !== null && row.minutes > 0),
    }),
  );
  return { goals: counted, players };
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

  /** Up to 20 finished fixtures by id with their events, lineups and player numbers, for the goal-event markets. */
  async fixtureDetails(ids: string[]): Promise<RawFixtureDetail[]> {
    if (ids.length === 0) return [];
    const res = (await this.fetchJson("/fixtures", { ids: ids.slice(0, 20).join("-") })) as ApiResponse<RawFixtureDetail>;
    return res.response;
  }

  /** Corners and cards for one finished match, or null if the feed has no statistics for it. */
  async statistics(fixtureId: string, homeTeam: string): Promise<MatchStats | null> {
    const res = (await this.fetchJson("/fixtures/statistics", { fixture: fixtureId })) as ApiResponse<RawTeamStatistics>;
    return parseStatistics(res.response, homeTeam);
  }

  /** Every league with a season in progress, in one request. */
  async currentLeagues(): Promise<FeedLeague[]> {
    const res = (await this.fetchJson("/leagues", { current: "true" })) as ApiResponse<{ league: { id: number; name: string; type?: string }; country: { name: string } }>;
    return res.response.map((row) => ({ id: row.league.id, name: row.league.name, type: row.league.type === "Cup" ? "Cup" : "League", country: row.country.name }));
  }

  /** In-play odds for every match the feed is pricing live, in one request. */
  async liveOdds(): Promise<RawLiveOdds[]> {
    const res = (await this.fetchJson("/odds/live", {})) as ApiResponse<RawLiveOdds>;
    return res.response;
  }

  /** In-play odds for one match right now, or null if the feed isn't pricing it. */
  async liveOddsFor(fixtureId: string): Promise<RawLiveOdds | null> {
    const res = (await this.fetchJson("/odds/live", { fixture: fixtureId })) as ApiResponse<RawLiveOdds>;
    return res.response.find((row) => String(row.fixture.id) === fixtureId) ?? null;
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
/** `onQuota` gets the requests left on today's plan, from each answer's rate-limit header. */
export function httpFetchJson(host: string, apiKey: string, onQuota?: (left: number) => void): FetchJson {
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
    const left = Number(res.headers.get("x-ratelimit-requests-remaining"));
    if (onQuota && res.headers.has("x-ratelimit-requests-remaining") && Number.isFinite(left)) onQuota(left);
    if (!res.ok) throw new Error(`API-Football answered ${res.status} for ${path}`);
    const body = (await res.json()) as ApiResponse<unknown>;
    const errors = body.errors && typeof body.errors === "object" ? Object.values(body.errors as Record<string, string>) : [];
    if (errors.length > 0) throw new Error(`API-Football: ${errors.join("; ")}`);
    return body;
  };
}
