import { type Built, type FeedBet, type FeedMarket, type Namer, comboLines, doubleChance, eitherTeam, fixed, halves, handicaps, oddEven, outcomes, sideName, yesNo } from "./api-football";
import { type Values, lineKey, linePairs, mainLines } from "./basketball";
import { type RawGameOdds, type RawTeamGame, type TeamGame, betsFrom, parseTeamGame, priced, teamPairPrices, whole } from "./team-sports";

/**
 * Handball: games, results and prices from API-Sports' handball API (the same
 * account as API-Football, its own quota of 100 requests a day on the free
 * plan).
 *
 * Every bet is on the 60 minutes of regular time, as bookmakers settle
 * handball: extra time and a penalty shootout in a cup tie don't count. The
 * result kept is the two halves added up, and the half-time score is the
 * first half's, so a handball game is stored and settled like a football
 * match: its markets use football's keys (match_winner, ah_m5_5, goals_55_5,
 * h1_winner …) and football's grading (bets/grading.ts), which has settled
 * them for a long time. Only half lines are offered on handicaps and totals,
 * so a bet never lands on the line; the European handicap ("Handicap result")
 * has whole lines with the draw as its own outcome.
 */

export const HANDBALL_PROVIDER = "api-sports-handball";

const STATUSES = {
  // Full time, after extra time, after penalties: the halves are regular time either way.
  finished: new Set(["FT", "AET", "AP"]),
  postponed: new Set(["POST", "PST"]),
  // Awarded without being played (or not finished) gives the stakes back.
  cancelled: new Set(["CANC", "ABD", "AW", "AWD", "WO"]),
};

export type HandballGame = TeamGame & {
  /** The score after 60 minutes, once it's over. */
  score: { home: number; away: number } | null;
  /** The first half's score, once it's over. */
  half: { home: number; away: number } | null;
  /** The score now, while it's being played. */
  live: { home: number; away: number } | null;
};

export function parseHandballGame(raw: RawTeamGame): HandballGame | null {
  const game = parseTeamGame(raw, STATUSES, "Handball");
  if (!game) return null;
  const first = { home: whole(raw.periods?.first?.home), away: whole(raw.periods?.first?.away) };
  const second = { home: whole(raw.periods?.second?.home), away: whole(raw.periods?.second?.away) };
  const total = { home: whole(raw.scores?.home), away: whole(raw.scores?.away) };
  const halves = [first.home, first.away, second.home, second.away].every((n) => n !== null);
  let score: HandballGame["score"] = null;
  let half: HandballGame["half"] = null;
  if (game.status === "finished") {
    const regular = halves ? { home: first.home! + second.home!, away: first.away! + second.away! } : null;
    const short = raw.status?.short;
    if (short === "FT") {
      // Full time: the halves should add up to the score; if they don't, the score stands without a half-time score.
      if (total.home !== null && total.away !== null) {
        score = { home: total.home, away: total.away };
        if (regular && regular.home === total.home && regular.away === total.away) half = { home: first.home!, away: first.away! };
      }
    } else if (regular) {
      // After extra time or penalties, only the halves say what regular time ended.
      score = regular;
      half = { home: first.home!, away: first.away! };
    }
  }
  const live = game.status === "live" && total.home !== null && total.away !== null ? { home: total.home, away: total.away } : null;
  return { ...game, score, half, live };
}

/** Over/under on a count whose lines move from game to game (55.5 goals): the most evenly priced half line and those nearest it. */
function aroundEven(prefix: string, name: (home: string, away: string, line: number) => string, shown: number) {
  return (values: Values, home: string, away: string): Built[] =>
    mainLines(linePairs(values, "Over", "Under"), true, shown).map((l) => ({
      key: `${prefix}_${lineKey(l.line)}`,
      name: name(home, away, l.line),
      selections: [
        { key: "over", name: `Over ${l.line}`, odds: l.a, sortOrder: 0 },
        { key: "under", name: `Under ${l.line}`, odds: l.b, sortOrder: 1 },
      ],
    }));
}

/** Half time / full time, whose values name the teams: every one of the 9 pairs, or nothing. */
function htFt(key: string, name: string) {
  return (values: Values, home: string, away: string): Built[] => {
    const prices = teamPairPrices(values, home, away);
    if (!prices) return [];
    const sides = ["home", "draw", "away"];
    const selections = sides.flatMap((ht) => sides.map((ft) => [ht, ft] as const)).map(([ht, ft], sortOrder) => ({
      key: `${ht}_${ft}`,
      name: `${sideName(ht, home, away)} / ${sideName(ft, home, away)}`,
      odds: prices.get(`${ht}_${ft}`) ?? NaN,
      sortOrder,
    }));
    return [{ key, name, selections }];
  };
}

type Builder = (values: Values, home: string, away: string) => Built[];
/** Football's builders read a bet as { name, values }. */
const asBet = (build: (bet: FeedBet, home: string, away: string) => Built[]): Builder => (values, home, away) => (values ? build({ name: "", values }, home, away) : []);
const named = (key: string, name: Namer, values: Array<[string, string, Namer]>) => asBet(fixed(key, name, values));

/**
 * The markets Bast.al offers for a handball game, matched on API-Sports'
 * handball bet names (see the test fixture handball-odds.json), in the order
 * Players see them. Each key is the one football uses for the same bet, so
 * football's grading settles it.
 */
const MARKETS: Array<[feedNames: string[], build: Builder]> = [
  [["3Way Result"], named("match_winner", () => "Result (60 minutes)", outcomes)],
  [["Double Chance"], named("double_chance", () => "Double chance", doubleChance)],
  // "Home/Away" is priced as draw no bet: a draw after 60 minutes gives the stake back.
  [["Home/Away"], named("draw_no_bet", () => "Draw no bet", eitherTeam)],
  [["Asian Handicap"], asBet(handicaps("ah", (home, line) => `Asian handicap ${home} ${line}`, false, 5))],
  [["Handicap Result"], asBet(handicaps("eh", (home, line) => `Handicap ${home} ${line}`, true, 3))],
  [["Over/Under"], aroundEven("goals", (_h, _a, line) => `Total goals ${line}`, 5)],
  [["Total - Home"], aroundEven("home_goals", (home, _a, line) => `${home} goals ${line}`, 3)],
  [["Total - Away"], aroundEven("away_goals", (_h, away, line) => `${away} goals ${line}`, 3)],
  [["Odd/Even"], named("odd_even", () => "Total goals odd/even", oddEven)],
  [["Home Odd/Even"], named("home_odd_even", (home) => `${home} goals odd/even`, oddEven)],
  [["Away Odd/Even"], named("away_odd_even", (_h, away) => `${away} goals odd/even`, oddEven)],
  [
    ["Result/Total Goals"],
    asBet(
      comboLines(
        "result_goals",
        (line) => `Result and total goals ${line}`,
        (value) => {
          const m = /^(Home|Draw|Away)\/(Over|Under) (\d+(?:\.\d+)?)$/.exec(value);
          return m ? [m[1].toLowerCase(), m[2].toLowerCase(), m[3]] : null;
        },
        (side, ou, line, home, away) => `${sideName(side, home, away)} / ${ou === "over" ? "Over" : "Under"} ${line}`,
        { left: ["home", "draw", "away"], right: ["over", "under"] },
      ),
    ),
  ],
  [["HT/FT Double"], htFt("ht_ft", "Half time / full time")],
  [["Highest Scoring Half"], named("highest_half", () => "Highest scoring half", halves)],
  [["Win Both Halves"], named("win_both_halves", () => "Win both halves", eitherTeam)],
  [["To Win Either Half"], named("win_either_half", () => "Win either half", eitherTeam)],
  [["Home win both halves"], named("home_win_both_halves", (home) => `${home} to win both halves`, yesNo)],
  [["Away win both halves"], named("away_win_both_halves", (_h, away) => `${away} to win both halves`, yesNo)],
  // The first half.
  [["1st Half 3Way Result"], named("h1_winner", () => "1st half result", outcomes)],
  [["Double Chance - 1st Half"], named("h1_double_chance", () => "1st half double chance", doubleChance)],
  [["Draw No Bet (1st Half)"], named("h1_draw_no_bet", () => "1st half draw no bet", eitherTeam)],
  [["Asian Handicap First Half"], asBet(handicaps("h1_ah", (home, line) => `1st half Asian handicap ${home} ${line}`, false, 3))],
  [["Handicap Result 1st Half"], asBet(handicaps("h1_eh", (home, line) => `1st half handicap ${home} ${line}`, true, 3))],
  [["Over/Under 1st Half"], aroundEven("h1_goals", (_h, _a, line) => `1st half goals ${line}`, 3)],
  [["Home Team Total Goals(1st Half)"], aroundEven("h1_home_goals", (home, _a, line) => `${home} 1st half goals ${line}`, 3)],
  [["Away Team Total Goals(1st Half)"], aroundEven("h1_away_goals", (_h, away, line) => `${away} 1st half goals ${line}`, 3)],
  [["Odd/Even 1st Half"], named("h1_odd_even", () => "1st half goals odd/even", oddEven)],
  // The second half (its own goals, not the match's).
  [["2nd Half 3Way Result"], named("h2_winner", () => "2nd half result", outcomes)],
  [["Double Chance - 2nd Half"], named("h2_double_chance", () => "2nd half double chance", doubleChance)],
  [["Draw No Bet (2nd Half)"], named("h2_draw_no_bet", () => "2nd half draw no bet", eitherTeam)],
  [["Asian Handicap (2nd Half)"], asBet(handicaps("h2_ah", (home, line) => `2nd half Asian handicap ${home} ${line}`, false, 3))],
  [["European Handicap (2nd Half)"], asBet(handicaps("h2_eh", (home, line) => `2nd half handicap ${home} ${line}`, true, 3))],
  [["Over/Under 2nd Half"], aroundEven("h2_goals", (_h, _a, line) => `2nd half goals ${line}`, 3)],
  [["Home Team Total Goals(2nd Half)"], aroundEven("h2_home_goals", (home, _a, line) => `${home} 2nd half goals ${line}`, 3)],
  [["Away Team Total Goals(2nd Half)"], aroundEven("h2_away_goals", (_h, away, line) => `${away} 2nd half goals ${line}`, 3)],
  [["Odd/Even (2nd Half)"], named("h2_odd_even", () => "2nd half goals odd/even", oddEven)],
];

/** API-Sports' prices for a handball game: every market above that its bookmakers price in full. */
export function parseHandballOdds(raw: RawGameOdds, home: string, away: string, bookmakerId: number): FeedMarket[] {
  const bet = betsFrom(raw, bookmakerId);
  const seen = new Set<string>();
  return MARKETS.flatMap(([names, build], index) => {
    const values = names.map(bet).find((v) => v) ?? null;
    return priced(build(values, home, away), index * 10).filter((market) => !seen.has(market.key) && Boolean(seen.add(market.key)));
  });
}
