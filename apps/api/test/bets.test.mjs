// Run with `npm test --workspace apps/api` (builds first). Covers how bets
// are graded and paid, and reading final scores from the feed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { gradeSelection, payoutFor } from "../dist/bets/grading.js";
import { parseFixture, parseStatistics } from "../dist/odds/api-football.js";

test("match winner and double chance follow the 90-minute score", () => {
  assert.equal(gradeSelection("match_winner", "home", 2, 1), "WON");
  assert.equal(gradeSelection("match_winner", "draw", 2, 1), "LOST");
  assert.equal(gradeSelection("match_winner", "draw", 1, 1), "WON");
  assert.equal(gradeSelection("match_winner", "away", 0, 3), "WON");
  assert.equal(gradeSelection("double_chance", "home_draw", 1, 1), "WON");
  assert.equal(gradeSelection("double_chance", "home_away", 1, 1), "LOST");
  assert.equal(gradeSelection("double_chance", "draw_away", 0, 1), "WON");
});

test("goals and both-teams-score markets", () => {
  assert.equal(gradeSelection("goals_2_5", "over", 2, 1), "WON");
  assert.equal(gradeSelection("goals_2_5", "under", 2, 1), "LOST");
  assert.equal(gradeSelection("goals_2_5", "under", 1, 1), "WON");
  assert.equal(gradeSelection("btts", "yes", 1, 1), "WON");
  assert.equal(gradeSelection("btts", "no", 3, 0), "WON");
  assert.equal(gradeSelection("btts", "yes", 3, 0), "LOST");
});

test("more goal lines and team totals", () => {
  assert.equal(gradeSelection("goals_0_5", "over", 1, 0), "WON");
  assert.equal(gradeSelection("goals_0_5", "under", 0, 0), "WON");
  assert.equal(gradeSelection("goals_3_5", "over", 2, 1), "LOST");
  assert.equal(gradeSelection("goals_4_5", "over", 3, 2), "WON");
  assert.equal(gradeSelection("home_goals_1_5", "over", 2, 0), "WON");
  assert.equal(gradeSelection("away_goals_0_5", "under", 2, 0), "WON");
  assert.equal(gradeSelection("away_goals_0_5", "sideways", 2, 0), null);
});

test("full-time score markets", () => {
  assert.equal(gradeSelection("draw_no_bet", "home", 1, 1), "VOID");
  assert.equal(gradeSelection("draw_no_bet", "home", 2, 1), "WON");
  assert.equal(gradeSelection("draw_no_bet", "away", 2, 1), "LOST");
  assert.equal(gradeSelection("correct_score", "2-1", 2, 1), "WON");
  assert.equal(gradeSelection("correct_score", "1-2", 2, 1), "LOST");
  assert.equal(gradeSelection("exact_goals", "3", 2, 1), "WON");
  assert.equal(gradeSelection("exact_goals", "7+", 5, 2), "WON");
  assert.equal(gradeSelection("exact_goals", "7+", 5, 1), "LOST");
  assert.equal(gradeSelection("odd_even", "odd", 2, 1), "WON");
  assert.equal(gradeSelection("odd_even", "even", 0, 0), "WON");
  assert.equal(gradeSelection("clean_sheet_home", "yes", 1, 0), "WON");
  assert.equal(gradeSelection("clean_sheet_away", "yes", 1, 0), "LOST");
  assert.equal(gradeSelection("win_to_nil", "home", 2, 0), "WON");
  assert.equal(gradeSelection("win_to_nil", "home", 2, 1), "LOST");
  assert.equal(gradeSelection("win_to_nil", "away", 0, 0), "LOST");
  assert.equal(gradeSelection("result_btts", "home_yes", 2, 1), "WON");
  assert.equal(gradeSelection("result_btts", "draw_no", 0, 0), "WON");
  assert.equal(gradeSelection("result_btts", "home_no", 2, 1), "LOST");
});

test("half markets settle on the half-time score, and wait without one", () => {
  const ht = { home: 1, away: 0 }; // 1-0 at half time, 2-2 at full time: second half 1-2
  assert.equal(gradeSelection("h1_winner", "home", 2, 2, ht), "WON");
  assert.equal(gradeSelection("h2_winner", "away", 2, 2, ht), "WON");
  assert.equal(gradeSelection("ht_ft", "home_draw", 2, 2, ht), "WON");
  assert.equal(gradeSelection("ht_ft", "home_home", 2, 2, ht), "LOST");
  assert.equal(gradeSelection("h1_double_chance", "home_draw", 2, 2, ht), "WON");
  assert.equal(gradeSelection("h1_goals_0_5", "over", 2, 2, ht), "WON");
  assert.equal(gradeSelection("h2_goals_2_5", "over", 2, 2, ht), "WON");
  assert.equal(gradeSelection("h1_btts", "no", 2, 2, ht), "WON");
  assert.equal(gradeSelection("h2_btts", "yes", 2, 2, ht), "WON");
  assert.equal(gradeSelection("h1_correct_score", "1-0", 2, 2, ht), "WON");
  assert.equal(gradeSelection("highest_half", "second", 2, 2, ht), "WON");
  assert.equal(gradeSelection("highest_half", "equal", 2, 0, { home: 1, away: 0 }), "WON");
  assert.equal(gradeSelection("win_both_halves", "home", 2, 2, ht), "LOST");
  assert.equal(gradeSelection("win_either_half", "away", 2, 2, ht), "WON");
  assert.equal(gradeSelection("h1_winner", "home", 2, 2), null);
  assert.equal(gradeSelection("h2_goals_0_5", "over", 2, 2), null);
});

test("corner and card markets settle on match stats, and wait without them", () => {
  const stats = { cornersHome: 3, cornersAway: 13, cardsHome: 3, cardsAway: 0 }; // Fulham 1-1 Man United
  assert.equal(gradeSelection("corners_9_5", "over", 1, 1, null, stats), "WON");
  assert.equal(gradeSelection("corners_16_5", "under", 1, 1, null, stats), "WON");
  assert.equal(gradeSelection("home_corners_3_5", "under", 1, 1, null, stats), "WON");
  assert.equal(gradeSelection("away_corners_5_5", "over", 1, 1, null, stats), "WON");
  assert.equal(gradeSelection("cards_3_5", "over", 1, 1, null, stats), "LOST");
  assert.equal(gradeSelection("home_cards_2_5", "over", 1, 1, null, stats), "WON");
  assert.equal(gradeSelection("away_cards_0_5", "under", 1, 1, null, stats), "WON");
  assert.equal(gradeSelection("corners_9_5", "over", 1, 1), null);
  assert.equal(gradeSelection("cards_3_5", "over", 1, 1, { home: 0, away: 0 }), null);
});

test("combo markets: result and goals, goals and both teams score", () => {
  assert.equal(gradeSelection("result_goals_2_5", "home_over", 3, 1), "WON");
  assert.equal(gradeSelection("result_goals_2_5", "home_over", 2, 0), "LOST", "a home win, but under 2.5");
  assert.equal(gradeSelection("result_goals_2_5", "draw_under", 1, 1), "WON");
  assert.equal(gradeSelection("result_goals_2_5", "away_under", 1, 1), "LOST");
  assert.equal(gradeSelection("goals_btts_2_5", "over_yes", 2, 1), "WON");
  assert.equal(gradeSelection("goals_btts_2_5", "over_no", 3, 0), "WON");
  assert.equal(gradeSelection("goals_btts_2_5", "under_yes", 1, 1), "WON");
  assert.equal(gradeSelection("goals_btts_2_5", "under_no", 1, 1), "LOST");
  assert.equal(gradeSelection("goals_btts_2_5", "sideways", 1, 1), null);
});

test("team exact goals, goal ranges, winning margin and odd/even per team", () => {
  assert.equal(gradeSelection("home_exact_goals", "2", 2, 0), "WON");
  assert.equal(gradeSelection("home_exact_goals", "3+", 4, 0), "WON");
  assert.equal(gradeSelection("away_exact_goals", "0", 2, 1), "LOST");
  assert.equal(gradeSelection("goal_range", "0-1", 1, 0), "WON");
  assert.equal(gradeSelection("goal_range", "2-3", 2, 1), "WON");
  assert.equal(gradeSelection("goal_range", "4+", 2, 1), "LOST");
  assert.equal(gradeSelection("winning_margin", "home_1", 2, 1), "WON");
  assert.equal(gradeSelection("winning_margin", "away_4+", 0, 5), "WON");
  assert.equal(gradeSelection("winning_margin", "away_2", 0, 3), "LOST");
  assert.equal(gradeSelection("winning_margin", "score_draw", 1, 1), "WON");
  assert.equal(gradeSelection("winning_margin", "score_draw", 0, 0), "LOST");
  assert.equal(gradeSelection("winning_margin", "no_goal", 0, 0), "WON");
  assert.equal(gradeSelection("home_odd_even", "odd", 3, 0), "WON");
  assert.equal(gradeSelection("away_odd_even", "even", 3, 0), "WON", "0 is even");
});

test("half extras: exact goals and odd/even per half, scoring in both halves, each team's best half", () => {
  const half = { home: 1, away: 0 };
  assert.equal(gradeSelection("h1_exact_goals", "1", 2, 1, half), "WON");
  assert.equal(gradeSelection("h2_exact_goals", "2", 2, 1, half), "WON");
  assert.equal(gradeSelection("h2_exact_goals", "5+", 2, 1, half), "LOST");
  assert.equal(gradeSelection("h1_odd_even", "odd", 2, 1, half), "WON");
  assert.equal(gradeSelection("h2_odd_even", "even", 2, 1, half), "WON");
  assert.equal(gradeSelection("score_both_halves", "home", 2, 1, half), "WON");
  assert.equal(gradeSelection("score_both_halves", "away", 2, 1, half), "LOST");
  assert.equal(gradeSelection("home_highest_half", "equal", 2, 1, half), "WON");
  assert.equal(gradeSelection("away_highest_half", "second", 2, 1, half), "WON");
  assert.equal(gradeSelection("h1_exact_goals", "1", 2, 1), null, "waits for the half-time score");
});

test("most corners and corner ranges settle on the match stats", () => {
  const stats = { cornersHome: 6, cornersAway: 3, cardsHome: 1, cardsAway: 2 };
  assert.equal(gradeSelection("corners_1x2", "home", 0, 0, null, stats), "WON");
  assert.equal(gradeSelection("corners_1x2", "draw", 0, 0, null, stats), "LOST");
  assert.equal(gradeSelection("corners_range", "9-11", 0, 0, null, stats), "WON");
  assert.equal(gradeSelection("corners_range", "u6", 0, 0, null, stats), "LOST");
  assert.equal(gradeSelection("corners_range", "o14", 0, 0, null, { ...stats, cornersHome: 12 }), "WON");
  assert.equal(gradeSelection("corners_range", "9-11", 0, 0), null, "waits for the stats");
});

test("an unknown market is left for Super Admin", () => {
  assert.equal(gradeSelection("corners", "over", 1, 0), null);
  assert.equal(gradeSelection("match_winner", "nobody", 1, 0), null);
});

test("a win pays stake x odds rounded down, a void refunds, a loss pays nothing", () => {
  const stake = new Prisma.Decimal("10.00");
  assert.equal(payoutFor("WON", stake, new Prisma.Decimal("2.15")).toFixed(2), "21.50");
  assert.equal(payoutFor("WON", new Prisma.Decimal("3.33"), new Prisma.Decimal("1.99")).toFixed(2), "6.62");
  assert.equal(payoutFor("VOID", stake, new Prisma.Decimal("2.15")).toFixed(2), "10.00");
  assert.equal(payoutFor("LOST", stake, new Prisma.Decimal("2.15")).toFixed(2), "0.00");
});

const raw = (short, goals, fulltime) => ({
  fixture: { id: 1, date: "2026-09-28T18:00:00Z", status: { short, elapsed: 90 } },
  league: { id: 1, name: "L", country: "Albania", season: 2026 },
  teams: { home: { name: "A" }, away: { name: "B" } },
  goals,
  score: { fulltime },
});

test("bets settle on the 90-minute score, not extra time", () => {
  assert.deepEqual(parseFixture(raw("FT", { home: 2, away: 1 }, { home: 2, away: 1 })).result, { home: 2, away: 1 });
  assert.deepEqual(parseFixture(raw("AET", { home: 2, away: 1 }, { home: 1, away: 1 })).result, { home: 1, away: 1 });
  assert.equal(parseFixture(raw("2H", { home: 2, away: 1 }, { home: null, away: null })).result, null);
});

test("the half-time score is kept once the match has finished", () => {
  const finished = { ...raw("FT", { home: 2, away: 1 }, { home: 2, away: 1 }), score: { halftime: { home: 1, away: 1 }, fulltime: { home: 2, away: 1 } } };
  assert.deepEqual(parseFixture(finished).halfTime, { home: 1, away: 1 });
  assert.equal(parseFixture(raw("FT", { home: 2, away: 1 }, { home: 2, away: 1 })).halfTime, null);
});

const d = (v) => new Prisma.Decimal(v);
const legs = (...pairs) => pairs.map(([odds, result]) => ({ odds: d(odds), result }));

test("accumulator odds multiply and round down", async () => {
  const { combinedOdds } = await import("../dist/bets/grading.js");
  assert.equal(combinedOdds([d("1.91"), d("2.05"), d("1.50")]).toFixed(2), "5.87");
});

test("an accumulator loses on any lost leg and waits on open legs", async () => {
  const { accumulatorOutcome } = await import("../dist/bets/grading.js");
  assert.equal(accumulatorOutcome(legs(["2.00", "WON"], ["3.00", "LOST"], ["1.50", null])).status, "LOST");
  assert.equal(accumulatorOutcome(legs(["2.00", "WON"], ["3.00", null])).status, "OPEN");
  const won = accumulatorOutcome(legs(["2.00", "WON"], ["3.00", "WON"]));
  assert.deepEqual([won.status, won.odds.toFixed(2)], ["WON", "6.00"]);
});

test("a void leg drops out and an all-void accumulator is refunded", async () => {
  const { accumulatorOutcome } = await import("../dist/bets/grading.js");
  const oneVoid = accumulatorOutcome(legs(["2.00", "WON"], ["3.00", "VOID"], ["1.50", "WON"]));
  assert.deepEqual([oneVoid.status, oneVoid.odds.toFixed(2)], ["WON", "3.00"]);
  assert.equal(accumulatorOutcome(legs(["2.00", "VOID"], ["3.00", "VOID"])).status, "VOID");
});

test("a match that went to extra time is flagged", () => {
  assert.equal(parseFixture(raw("AET", { home: 2, away: 1 }, { home: 1, away: 1 })).extraTime, true);
  assert.equal(parseFixture(raw("FT", { home: 2, away: 1 }, { home: 2, away: 1 })).extraTime, false);
});

const teamStats = (id, name, corners, yellow, red) => ({
  team: { id, name },
  statistics: [
    { type: "Shots on Goal", value: 4 },
    { type: "Corner Kicks", value: corners },
    { type: "Yellow Cards", value: yellow },
    { type: "Red Cards", value: red },
  ],
});

test("corners and cards are read from match statistics", () => {
  // Real numbers from Fulham 1-1 Manchester United; null means none.
  const fulham = teamStats(36, "Fulham", 3, 3, null);
  const united = teamStats(33, "Manchester United", 13, 0, null);
  assert.deepEqual(parseStatistics([fulham, united], "Fulham"), { cornersHome: 3, cornersAway: 13, cardsHome: 3, cardsAway: 0 });
  // Order flipped in the feed: matched on the home team's name.
  assert.deepEqual(parseStatistics([united, fulham], "Fulham"), { cornersHome: 3, cornersAway: 13, cardsHome: 3, cardsAway: 0 });
  // A red counts as one card on top of the yellows.
  assert.equal(parseStatistics([teamStats(1, "A", 5, 2, 1), teamStats(2, "B", 4, null, null)], "A").cardsHome, 3);
});

test("no statistics means no numbers, not zeros", () => {
  assert.equal(parseStatistics([], "Fulham"), null);
  assert.equal(parseStatistics([{ team: { id: 1, name: "A" }, statistics: [] }, { team: { id: 2, name: "B" }, statistics: [] }], "A"), null);
});
