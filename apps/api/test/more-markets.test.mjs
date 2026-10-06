// Run with `npm test --workspace apps/api` (builds first). The markets added
// across the sports: football handicaps and team markets, basketball's
// halves, quarters and team totals (read from a real API-Sports sample), and
// the greyhound Tricast, each read from the feed and settled.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseMarkets } from "../dist/odds/api-football.js";
import { gradeSelection } from "../dist/bets/grading.js";
import { gradeBasketball, parseApiSportsOdds, parseGame } from "../dist/odds/basketball.js";
import { parseNflGame } from "../dist/odds/nfl.js";
import { gradeRace, parseRace, raceMarkets, raceSettlePrice } from "../dist/odds/greyhounds.js";

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const bet = (name, values) => ({ id: 0, name, values: Object.entries(values).map(([value, odd]) => ({ value, odd: String(odd) })) });
const football = {
  fixture: { id: 1 },
  bookmakers: [
    {
      id: 8,
      name: "Bet365",
      bets: [
        bet("Asian Handicap", { "Home -1.5": 2.6, "Away -1.5": 1.5, "Home -0.5": 1.9, "Away -0.5": 1.95, "Home +0.5": 1.4, "Away +0.5": 2.9, "Home -0.25": 1.7, "Away -0.25": 2.1, "Home +1.5": 1.15, "Away +1.5": 5 }),
        bet("Handicap Result", { "Home -1": 3.4, "Draw -1": 3.6, "Away -1": 2.0, "Home +1": 1.3, "Draw +1": 4.8, "Away +1": 8 }),
        bet("Home Team Score a Goal", { Yes: 1.3, No: 3.2 }),
        bet("Win to Nil - Away", { Yes: 6, No: 1.1 }),
        bet("Home Team Total Goals(1st Half)", { "Over 0.5": 1.8, "Under 0.5": 1.95, "Over 1.5": 4.5, "Under 1.5": 1.18 }),
        bet("Double Chance - Second Half", { "Home/Draw": 1.3, "Home/Away": 1.4, "Draw/Away": 1.6 }),
        bet("Corners Asian Handicap", { "Home -1.5": 1.9, "Away -1.5": 1.9 }),
        bet("Home win both halves", { Yes: 4.5, No: 1.18 }),
      ],
    },
  ],
};

test("football: handicaps (half lines only), team to score, win to nil, half team goals", () => {
  const markets = parseMarkets(football, "Tirana", "Partizani", 8);
  const by = (key) => markets.find((m) => m.key === key);
  assert.deepEqual(["ah_m0_5", "ah_m1_5", "ah_p0_5"].every((key) => by(key)), true, "the three nearest the even line; -0.25 left out");
  assert.equal(by("ah_p1_5"), undefined);
  assert.deepEqual(by("ah_m1_5").selections.map((s) => [s.name, s.odds]), [["Tirana −1.5", 2.6], ["Partizani +1.5", 1.5]]);
  assert.deepEqual(by("eh_m1").selections.map((s) => [s.key, s.name]), [["home", "Tirana −1"], ["draw", "Draw (−1)"], ["away", "Partizani +1"]]);
  for (const key of ["home_scores", "win_to_nil_away", "h1_home_goals_0_5", "h1_home_goals_1_5", "h2_double_chance", "corners_ah_m1_5", "home_win_both_halves"]) assert.ok(by(key), key);
});

test("football: settling the new markets", () => {
  // Tirana 2-1 (1-0 at half time), corners 7-4.
  const g = (market, pick) => gradeSelection(market, pick, 2, 1, { home: 1, away: 0 }, { cornersHome: 7, cornersAway: 4, cardsHome: 1, cardsAway: 2 });
  assert.equal(g("ah_m0_5", "home"), "WON");
  assert.equal(g("ah_m1_5", "home"), "LOST", "won by one, not two");
  assert.equal(g("ah_m1_5", "away"), "WON");
  assert.equal(g("eh_m1", "draw"), "WON", "2-1 with -1 is a draw");
  assert.equal(g("eh_p1", "home"), "WON");
  assert.equal(g("h1_ah_m0_5", "home"), "WON");
  assert.equal(g("h1_eh_m1", "draw"), "WON");
  assert.equal(g("home_scores", "yes"), "WON");
  assert.equal(g("away_scores", "no"), "LOST");
  assert.equal(g("win_to_nil_home", "no"), "WON");
  assert.equal(g("h1_home_goals_0_5", "over"), "WON");
  assert.equal(g("h2_away_goals_0_5", "over"), "WON", "Partizani scored after the break");
  assert.equal(g("h2_double_chance", "draw_away"), "WON", "the 2nd half was 1-1");
  assert.equal(g("home_win_both_halves", "yes"), "LOST");
  assert.equal(g("corners_ah_m2_5", "home"), "WON", "7 - 2.5 beats 4");
  assert.equal(gradeSelection("corners_ah_m2_5", "home", 2, 1, null, null), null, "waits for the statistics");
});

test("basketball: the real sample gives halves, quarters, team totals and more", async () => {
  const odds = (await load("basketball-odds.json")).response.find((g) => g.game.id === 509592);
  const keys = parseApiSportsOdds(odds, "Verona", "Olimpia Milano", 4).map((m) => m.key);
  for (const key of ["bb_3way", "bb_double_chance", "bb_odd_even", "bb_ht_ft", "bb_highest_half", "bb_home_total_81_5", "bb_h1_winner", "bb_h1_3way", "bb_h1_handicap_4_5", "bb_h1_total_84_5", "bb_h2_total_82_5", "bb_q1_winner", "bb_q1_3way", "bb_q1_total_43_5", "bb_q4_handicap_1_5", "bb_q3_odd_even", "bb_q1_away_total_22_5"]) {
    assert.ok(keys.includes(key), key);
  }
  assert.ok(keys.length > 70);
});

test("basketball and NFL: quarter scores are read with the result", async () => {
  const games = (await load("basketball-games.json")).response;
  const finished = games.map(parseGame).find((g) => g?.status === "finished" && g.periods);
  assert.equal(finished.periods.quarters.length, 4);
  const sum = finished.periods.quarters.reduce((t, [h, a]) => [t[0] + h, t[1] + a], [0, 0]);
  assert.deepEqual([sum[0] + (finished.periods.overtime?.[0] ?? 0), sum[1] + (finished.periods.overtime?.[1] ?? 0)], [finished.score.home, finished.score.away]);
  const nfl = (await load("nfl-games.json")).response.map(parseNflGame).find((g) => g?.status === "finished");
  assert.deepEqual(nfl.periods, { quarters: [[0, 10], [0, 13], [7, 14], [8, 10]], overtime: null });
});

test("basketball: settling by period", () => {
  // 87-97: quarters 27-25, 17-36, 16-21, 27-15; 1st half 44-61, 2nd half 43-36.
  const periods = { quarters: [[27, 25], [17, 36], [16, 21], [27, 15]], overtime: null };
  const g = (market, pick) => gradeBasketball(market, pick, 87, 97, periods);
  assert.equal(g("bb_3way", "away"), "WON");
  assert.equal(g("bb_double_chance", "draw_away"), "WON");
  assert.equal(g("bb_odd_even", "even"), "WON", "184");
  assert.equal(g("bb_home_total_86_5", "over"), "WON");
  assert.equal(g("bb_ht_ft", "away_away"), "WON");
  assert.equal(g("bb_highest_half", "first"), "WON", "105 to 79");
  assert.equal(g("bb_h1_winner", "away"), "WON");
  assert.equal(g("bb_h2_3way", "home"), "WON", "43-36");
  assert.equal(g("bb_h1_handicap_17_5", "home"), "WON", "44 + 17.5 beats 61");
  assert.equal(g("bb_h1_handicap_16_5", "home"), "LOST", "44 + 16.5 falls short of 61");
  assert.equal(g("bb_h1_total_104_5", "over"), "WON");
  assert.equal(g("bb_q1_winner", "home"), "WON");
  assert.equal(g("bb_q2_odd_even", "odd"), "WON", "53");
  assert.equal(g("bb_q4_home_total_26_5", "over"), "WON");
  assert.equal(g("bb_q3_away_total_21_5", "under"), "WON");
  assert.equal(g("bb_q4_handicap_m11_5", "home"), "WON", "27 - 11.5 beats 15");
  assert.equal(gradeBasketball("bb_q1_winner", "home", 87, 97, { quarters: [[20, 20], [1, 1], [1, 1], [65, 75]], overtime: null }), "VOID", "a tied quarter");
  assert.equal(gradeBasketball("bb_h1_total_104_5", "over", 87, 97, null), null, "waits for the quarters");
  assert.equal(gradeBasketball("bb_home_total_86_5", "over", 87, 97, null), "WON", "team totals need only the score");
  // Overtime counts in the 2nd half, not in regulation time.
  const ot = { quarters: [[20, 20], [20, 20], [20, 20], [20, 20]], overtime: [10, 5] };
  assert.equal(gradeBasketball("bb_3way", "draw", 90, 85, ot), "WON");
  assert.equal(gradeBasketball("bb_h2_winner", "home", 90, 85, ot), "WON");
});

const racecard = {
  race_id: 1,
  track: { name: "Romford" },
  scheduled_start: { utc: "2026-10-06T12:00:00Z" },
  runners: [1, 2, 3, 4, 5, 6].map((trap) => ({ trap, dog_id: 100 + trap, dog_name: `Dog ${trap}`, runner_status: trap === 6 ? "withdrawn" : "runner" })),
};

test("greyhounds: a Tricast on fields of up to six, every 1st-2nd-3rd in order", () => {
  const tricast = raceMarkets(parseRace(racecard)).find((m) => m.key === "race_tricast");
  assert.equal(tricast.selections.length, 120);
  assert.equal(tricast.selections.filter((s) => !s.withdrawn).length, 60, "five dogs running");
  const big = { ...racecard, runners: [...racecard.runners, { trap: 7, dog_id: 107, dog_name: "Dog 7" }, { trap: 8, dog_id: 108, dog_name: "Dog 8" }] };
  assert.equal(raceMarkets(parseRace(big)).find((m) => m.key === "race_tricast"), undefined, "eight dogs: no Tricast");
});

test("greyhounds: settling a Tricast at the official dividend", () => {
  const result = parseRace({
    ...racecard,
    result: { result_status: "final", tricast_dividend: "84.30", forecast_dividend: "12.10", positions: [{ position: 1, dog_id: 103 }, { position: 2, dog_id: 101 }, { position: 3, dog_id: 105 }, { position: 4, dog_id: 102 }] },
  }).result;
  assert.equal(gradeRace("race_tricast", "d103-d101-d105", result, false), "WON");
  assert.equal(gradeRace("race_tricast", "d103-d105-d101", result, false), "LOST");
  assert.equal(gradeRace("race_tricast", "d103-d101-d106", result, true), "VOID", "names a withdrawn dog");
  assert.equal(raceSettlePrice("race_tricast", "d103-d101-d105", result, 5, 2000), 80.08, "84.30 less 5%");
  const deadHeat = { ...result, positions: [{ dogId: 103, position: 1, sp: null }, { dogId: 101, position: 2, sp: null }, { dogId: 105, position: 3, sp: null }, { dogId: 102, position: 3, sp: null }] };
  assert.equal(gradeRace("race_tricast", "d103-d101-d105", deadHeat, false), null, "a dead heat for 3rd waits");
});
