// Run with `npm test --workspace apps/api` (builds first). Covers how bets
// are graded and paid, and reading final scores from the feed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { gradeSelection, payoutFor } from "../dist/bets/grading.js";
import { parseFixture } from "../dist/odds/api-football.js";

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
