import { SelectionResult } from "@prisma/client";
import { type FeedMarket } from "./api-football";
import { type Line, type Values, lineKey, linePairs, mainLines, price, signed } from "./basketball";
import { type RawGameOdds, type RawTeamGame, type TeamGame, betsFrom, parseTeamGame, priced, teamPairPrices, whole } from "./team-sports";

/**
 * Volleyball: games, results and prices from API-Sports' volleyball API (the
 * same account as API-Football, its own quota of 100 requests a day on the
 * free plan). A match is the best of five sets; the 5th is played to 15.
 *
 * The result kept is the sets each team won (Event.resultHome/resultAway)
 * and every set's points (Event.fightResult, see VolleyballResult). The
 * markets:
 * - the match: winner, set handicap, correct score in sets, total sets, a
 *   4th and a 5th set, each team to win a set;
 * - points over the whole match: handicap, total, each team's, odd/even;
 * - the 1st set with the match (who wins each);
 * - the 1st, 2nd and 3rd sets (always played): winner, handicap, total
 *   points, each team's points, odd/even.
 * Only half lines are offered, so a bet never lands on the line. The points
 * markets settle on the sets' points; without them they wait for Super Admin.
 */

export const VOLLEYBALL_PROVIDER = "api-sports-volleyball";

const STATUSES = {
  finished: new Set(["FT"]),
  postponed: new Set(["POST", "PST"]),
  // Awarded without being played (or not finished) gives the stakes back.
  cancelled: new Set(["CANC", "ABD", "AW", "AWD", "WO"]),
};

const SET_NAMES = ["first", "second", "third", "fourth", "fifth"] as const;

/** What Event.fightResult keeps for a volleyball match: every set's points, as [home, away]. */
export type VolleyballResult = { sets: Array<[number, number]> };

export type VolleyballGame = TeamGame & {
  /** Sets won, once it's over. */
  score: { home: number; away: number } | null;
  /** Every set's points, once it's over, if the feed sent all of them and they agree with the sets won. */
  sets: VolleyballResult | null;
  /** Sets won so far, while it's being played. */
  live: { home: number; away: number } | null;
};

export function parseVolleyballGame(raw: RawTeamGame): VolleyballGame | null {
  const game = parseTeamGame(raw, STATUSES, "Volleyball");
  if (!game) return null;
  const won = { home: whole(raw.scores?.home), away: whole(raw.scores?.away) };
  const known = won.home !== null && won.away !== null;
  const score = game.status === "finished" && known ? { home: won.home!, away: won.away! } : null;
  return { ...game, score, sets: score ? setsOf(raw, score) : null, live: game.status === "live" && known ? { home: won.home!, away: won.away! } : null };
}

/** The played sets' points, if every one is there and their winners add up to the sets won. */
function setsOf(raw: RawTeamGame, score: { home: number; away: number }): VolleyballResult | null {
  const played = score.home + score.away;
  if (played < 1 || played > 5) return null;
  const sets: Array<[number, number]> = [];
  for (const name of SET_NAMES.slice(0, played)) {
    const home = whole(raw.periods?.[name]?.home);
    const away = whole(raw.periods?.[name]?.away);
    if (home === null || away === null || home === away) return null;
    sets.push([home, away]);
  }
  const homeSets = sets.filter(([h, a]) => h > a).length;
  return homeSets === score.home && played - homeSets === score.away ? { sets } : null;
}

export function volleyballResultOf(value: unknown): VolleyballResult | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as VolleyballResult).sets)) return null;
  return value as VolleyballResult;
}

type Built = Omit<FeedMarket, "sortOrder">;
type Selection = Built["selections"][number];

const two = (home: string, away: string, prices: Array<number | null>): Selection[] => [
  { key: "home", name: home, odds: prices[0] ?? NaN, sortOrder: 0 },
  { key: "away", name: away, odds: prices[1] ?? NaN, sortOrder: 1 },
];
const valueOf = (values: Values, value: string) => price(values?.find((v) => v.value === value)?.odd);

/** Over/under lines, the most evenly priced half line and those nearest it. */
function overUnder(values: Values, prefix: string, name: (line: number) => string, shown: number): Built[] {
  return mainLines(linePairs(values, "Over", "Under"), true, shown).map((l: Line) => ({
    key: `${prefix}_${lineKey(l.line)}`,
    name: name(l.line),
    selections: [
      { key: "over", name: `Over ${l.line}`, odds: l.a, sortOrder: 0 },
      { key: "under", name: `Under ${l.line}`, odds: l.b, sortOrder: 1 },
    ],
  }));
}

/** Handicap lines, "Home -1.5" and "Away -1.5" both the home team's line (as everywhere in API-Sports' odds). */
function handicap(values: Values, prefix: string, name: (line: string) => string, home: string, away: string, shown: number): Built[] {
  return mainLines(linePairs(values, "Home", "Away"), true, shown).map((l: Line) => ({
    key: `${prefix}_${lineKey(l.line)}`,
    name: name(signed(l.line)),
    selections: [
      { key: "home", name: `${home} ${signed(l.line)}`, odds: l.a, sortOrder: 0 },
      { key: "away", name: `${away} ${signed(-l.line)}`, odds: l.b, sortOrder: 1 },
    ],
  }));
}

const yesNo = (values: Values): Selection[] => [
  { key: "yes", name: "Yes", odds: valueOf(values, "Yes") ?? NaN, sortOrder: 0 },
  { key: "no", name: "No", odds: valueOf(values, "No") ?? NaN, sortOrder: 1 },
];
const oddEven = (values: Values): Selection[] => [
  { key: "odd", name: "Odd", odds: valueOf(values, "Odd") ?? NaN, sortOrder: 0 },
  { key: "even", name: "Even", odds: valueOf(values, "Even") ?? NaN, sortOrder: 1 },
];

/** The sets markets are for the first three, which every match plays. */
const SETS = [
  { n: 1, label: "1st set", feed: "1st Set", total: ["Over/Under (1st Set)", "Over/Under by Games (1st Set)"] },
  { n: 2, label: "2nd set", feed: "2nd Set", total: ["Over/Under by Games (2nd Set)", "Over/Under (2nd Set)"] },
  { n: 3, label: "3rd set", feed: "3rd Set", total: ["Over/Under by Games (3rd Set)", "Over/Under (3rd Set)"] },
] as const;

/**
 * API-Sports' prices for a volleyball match, by its bet names (see the test
 * fixture volleyball-odds.json): every market it prices in full, each from
 * the preferred bookmaker or else the first other one that has it.
 */
export function parseVolleyballOdds(raw: RawGameOdds, home: string, away: string, bookmakerId: number): FeedMarket[] {
  const bet = betsFrom(raw, bookmakerId);
  const any = (...names: string[]) => names.map(bet).find((values) => values) ?? null;
  const out: FeedMarket[] = [];
  const seen = new Set<string>();
  const add = (markets: Built[], sortOrder: number) => {
    for (const market of priced(markets, sortOrder)) if (!seen.has(market.key) && seen.add(market.key)) out.push(market);
  };

  const winner = bet("Home/Away");
  add([{ key: "vb_winner", name: "Winner", selections: two(home, away, [valueOf(winner, "Home"), valueOf(winner, "Away")]) }], 0);
  add(handicap(bet("Asian Handicap (Sets)"), "vb_sets_handicap", (line) => `Set handicap ${home} ${line}`, home, away, 3), 10);
  const correct = bet("Correct Score");
  const scores = ["3:0", "3:1", "3:2", "2:3", "1:3", "0:3"];
  // The scorelines the bookmaker prices (it may leave one out), like football's correct score.
  const lines = scores.map((s, sortOrder) => ({ key: s.replace(":", "-"), name: s.replace(":", "–"), odds: valueOf(correct, s) ?? NaN, sortOrder })).filter((s) => Number.isFinite(s.odds));
  add([{ key: "vb_correct_score", name: "Correct score (sets)", selections: lines }], 20);
  add(overUnder(bet("Over/Under"), "vb_sets_total", (line) => `Total sets ${line}`, 2), 30);
  add([{ key: "vb_4th_set", name: "Will there be a 4th set", selections: yesNo(bet("Will There Be A 4th Set")) }], 40);
  add([{ key: "vb_5th_set", name: "Will there be a 5th set", selections: yesNo(bet("Will There Be A 5th Set")) }], 41);
  add([{ key: "vb_home_wins_set", name: `${home} to win a set`, selections: yesNo(bet("Home To Win A Set")) }], 42);
  add([{ key: "vb_away_wins_set", name: `${away} to win a set`, selections: yesNo(bet("Away To Win A Set")) }], 43);
  // The 1st set and the match, whose values name the teams.
  const pair = teamPairPrices(bet("HT/FT Double"), home, away);
  if (pair && [...pair.keys()].every((key) => !key.includes("draw"))) {
    const sides = ["home", "away"] as const;
    const name = (side: string) => (side === "home" ? home : away);
    add([{ key: "vb_s1_match", name: "1st set / match", selections: sides.flatMap((s1) => sides.map((m) => [s1, m] as const)).map(([s1, m], sortOrder) => ({ key: `${s1}_${m}`, name: `${name(s1)} / ${name(m)}`, odds: pair.get(`${s1}_${m}`) ?? NaN, sortOrder })) }], 50);
  }
  // Points over the whole match.
  add(handicap(bet("Asian Handicap (Games)"), "vb_points_handicap", (line) => `Points handicap ${home} ${line}`, home, away, 5), 60);
  add(overUnder(bet("Over/Under by Games in Match"), "vb_points_total", (line) => `Total points ${line}`, 5), 70);
  add(overUnder(bet("Total - Home"), "vb_home_points", (line) => `${home} points ${line}`, 3), 80);
  add(overUnder(bet("Total - Away"), "vb_away_points", (line) => `${away} points ${line}`, 3), 85);
  add([{ key: "vb_odd_even", name: "Total points odd/even", selections: oddEven(bet("Odd/Even")) }], 90);
  // The first three sets.
  SETS.forEach((set, index) => {
    const base = 100 + index * 30;
    const setWinner = bet(`Home/Away (${set.feed})`);
    add([{ key: `vb_s${set.n}_winner`, name: `${set.label} winner`, selections: two(home, away, [valueOf(setWinner, "Home"), valueOf(setWinner, "Away")]) }], base);
    add(handicap(bet(`Asian Handicap (${set.feed})`), `vb_s${set.n}_handicap`, (line) => `${set.label} handicap ${home} ${line}`, home, away, 3), base + 2);
    add(overUnder(any(...set.total), `vb_s${set.n}_total`, (line) => `${set.label} total points ${line}`, 3), base + 8);
    add(overUnder(bet(`Home Team Total (${set.feed})`), `vb_s${set.n}_home_points`, (line) => `${home} ${set.label} points ${line}`, 3), base + 14);
    add(overUnder(bet(`Away Team Total (${set.feed})`), `vb_s${set.n}_away_points`, (line) => `${away} ${set.label} points ${line}`, 3), base + 20);
    add([{ key: `vb_s${set.n}_odd_even`, name: `${set.label} points odd/even`, selections: oddEven(bet(`Odd/Even (${set.feed})`)) }], base + 26);
  });
  return out.sort((a, b) => a.sortOrder - b.sortOrder);
}

export const isVolleyballMarket = (marketKey: string) => marketKey.startsWith("vb_");

/**
 * One outcome's result from the sets each team won and, for the points
 * markets, every set's points (null without them: those bets wait for Super
 * Admin). Lines are half points, so there's no push; a whole line, which
 * isn't offered, would be void on landing.
 */
export function gradeVolleyball(marketKey: string, selectionKey: string, homeSets: number, awaySets: number, result: VolleyballResult | null): SelectionResult | null {
  const won = (yes: boolean) => (yes ? SelectionResult.WON : SelectionResult.LOST);
  const margin = (value: number) => (value > 0 ? SelectionResult.WON : value < 0 ? SelectionResult.LOST : SelectionResult.VOID);
  const side = (home: number, away: number) => (selectionKey === "home" ? margin(home - away) : selectionKey === "away" ? margin(away - home) : null);
  const overUnder = (count: number, line: number) => (selectionKey === "over" ? margin(count - line) : selectionKey === "under" ? margin(line - count) : null);
  const yesNo = (happened: boolean) => (selectionKey === "yes" ? won(happened) : selectionKey === "no" ? won(!happened) : null);
  const oddEven = (count: number) => (selectionKey === "odd" || selectionKey === "even" ? won((count % 2 === 1) === (selectionKey === "odd")) : null);
  const line = (() => {
    const m = /_(m?)(\d+)_(\d)$/.exec(marketKey);
    return m ? (m[1] ? -1 : 1) * Number(`${m[2]}.${m[3]}`) : null;
  })();
  const played = homeSets + awaySets;

  // The match, from the sets won.
  if (marketKey === "vb_winner") return side(homeSets, awaySets);
  if (marketKey.startsWith("vb_sets_handicap_")) return line === null ? null : side(homeSets + line, awaySets);
  if (marketKey === "vb_correct_score") {
    const m = /^(\d)-(\d)$/.exec(selectionKey);
    return m ? won(Number(m[1]) === homeSets && Number(m[2]) === awaySets) : null;
  }
  if (marketKey.startsWith("vb_sets_total_")) return line === null ? null : overUnder(played, line);
  if (marketKey === "vb_4th_set") return yesNo(played >= 4);
  if (marketKey === "vb_5th_set") return yesNo(played >= 5);
  if (marketKey === "vb_home_wins_set") return yesNo(homeSets > 0);
  if (marketKey === "vb_away_wins_set") return yesNo(awaySets > 0);

  // Everything else needs the sets' points, and they have to agree with the sets won.
  const sets = result?.sets ?? null;
  if (!sets || sets.length !== played || sets.filter(([h, a]) => h > a).length !== homeSets) return null;
  const total = sets.reduce((sum, [h, a]) => ({ home: sum.home + h, away: sum.away + a }), { home: 0, away: 0 });
  const setWinner = (n: number) => (sets[n - 1][0] > sets[n - 1][1] ? "home" : "away");

  if (marketKey === "vb_s1_match") {
    const [first, match] = selectionKey.split("_");
    if (!["home", "away"].includes(first) || !["home", "away"].includes(match)) return null;
    return won(setWinner(1) === first && (homeSets > awaySets ? "home" : "away") === match);
  }
  if (marketKey.startsWith("vb_points_handicap_")) return line === null ? null : side(total.home + line, total.away);
  if (marketKey.startsWith("vb_points_total_")) return line === null ? null : overUnder(total.home + total.away, line);
  if (marketKey.startsWith("vb_home_points_")) return line === null ? null : overUnder(total.home, line);
  if (marketKey.startsWith("vb_away_points_")) return line === null ? null : overUnder(total.away, line);
  if (marketKey === "vb_odd_even") return oddEven(total.home + total.away);

  const set = /^vb_s([1-3])_(winner|handicap|total|home_points|away_points|odd_even)/.exec(marketKey);
  if (!set) return null;
  const [home, away] = sets[Number(set[1]) - 1];
  switch (set[2]) {
    case "winner":
      return side(home, away);
    case "handicap":
      return line === null ? null : side(home + line, away);
    case "total":
      return line === null ? null : overUnder(home + away, line);
    case "home_points":
      return line === null ? null : overUnder(home, line);
    case "away_points":
      return line === null ? null : overUnder(away, line);
    case "odd_even":
      return oddEven(home + away);
  }
  return null;
}
