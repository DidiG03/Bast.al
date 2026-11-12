// Corners Over / Exactly / Under and the rest of the match: parsed from the
// live feed, settled, and guarded during play.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseLiveOdds, unknownLiveBets } = require("../dist/odds/api-football.js");
const { gradeSelection } = require("../dist/bets/grading.js");
const { countLineDead, isCountMarket } = require("../dist/odds/count-guard.js");
const { liveScoreBlocked } = require("../dist/odds/live-score-guard.js");
const { goalsHelp, cornerHelps } = require("../dist/bets/late.js");

const reading = (odds, home = 1, away = 1) => ({ fixture: { id: 7, status: { elapsed: 60 } }, teams: { home: { goals: home }, away: { goals: away } }, status: {}, odds });

test("Match Corners becomes Over / Exactly / Under at its whole line", () => {
  const parsed = parseLiveOdds(
    reading([{ id: 1, name: "Match Corners", values: [{ value: "Over", handicap: "8", odd: "2.10" }, { value: "Exactly", handicap: "8", odd: "6.00" }, { value: "Under", handicap: "8", odd: "1.80" }] }]),
    "Italy",
    "France",
  );
  const market = parsed.markets.find((m) => m.key === "corners_3way_8");
  assert.ok(market, "the 3-way market is there");
  assert.equal(market.name, "Total corners 3-way 8");
  assert.deepEqual(market.selections.map((s) => [s.key, s.odds]), [["over", 2.1], ["exact", 6], ["under", 1.8]]);
  assert.equal(market.suspended, false);
});

test("the rest of the match is keyed by the score it's priced at", () => {
  const parsed = parseLiveOdds(reading([{ id: 2, name: "Rest of the Match", values: [{ value: "Home", odd: "4.75" }, { value: "Draw", odd: "3.20" }, { value: "Away", odd: "1.83" }] }], 1, 1), "Italy", "France");
  const market = parsed.markets.find((m) => m.key === "rest_1_1");
  assert.ok(market);
  assert.equal(market.name, "Rest of the match (1:1)");
  assert.deepEqual(market.selections.map((s) => s.key), ["home", "draw", "away"]);
  // Without the score, no key could say what the prices are for.
  const noScore = parseLiveOdds({ ...reading([{ id: 2, name: "Rest of the Match", values: [{ value: "Home", odd: "2" }, { value: "Draw", odd: "3" }, { value: "Away", odd: "4" }] }]), teams: {} }, "A", "B");
  assert.equal(noScore.markets.length, 0);
});

test("an in-play market we don't offer is reported by name", () => {
  assert.deepEqual(unknownLiveBets(reading([{ id: 9, name: "Race to the 5th Corner", values: [] }, { id: 1, name: "Fulltime Result", values: [] }])), ["Race to the 5th Corner"]);
});

test("corners 3-way and the rest of the match settle", () => {
  const stats = { cornersHome: 5, cornersAway: 3, cardsHome: 0, cardsAway: 0 };
  assert.equal(gradeSelection("corners_3way_8", "exact", 1, 1, null, stats), "WON");
  assert.equal(gradeSelection("corners_3way_8", "over", 1, 1, null, stats), "LOST");
  assert.equal(gradeSelection("corners_3way_8", "under", 1, 1, null, stats), "LOST");
  assert.equal(gradeSelection("corners_3way_7", "over", 1, 1, null, stats), "WON");
  assert.equal(gradeSelection("corners_3way_8", "over", 1, 1, null, null), null, "waits for the statistics");
  // From 1:1, a 2:1 final means the home side won the rest of the match.
  assert.equal(gradeSelection("rest_1_1", "home", 2, 1), "WON");
  assert.equal(gradeSelection("rest_1_1", "draw", 1, 1), "WON");
  assert.equal(gradeSelection("rest_0_1", "away", 2, 2), "LOST");
  assert.equal(gradeSelection("rest_2_0", "home", 1, 0), null, "a corrected score below the line goes to Super Admin");
  assert.equal(gradeSelection("h1_rest_0_1", "home", 3, 1, { home: 1, away: 1 }), "WON");
  assert.equal(gradeSelection("h1_rest_0_1", "home", 3, 1, null), null);
});

test("during play: decided corners outcomes and a rest market at another score are closed", () => {
  assert.equal(isCountMarket("corners_3way_8"), true);
  assert.equal(countLineDead("corners_3way_8", "over", 9), true);
  assert.equal(countLineDead("corners_3way_8", "exact", 8), false);
  assert.equal(countLineDead("corners_3way_8", "under", 8), true);
  assert.equal(countLineDead("corners_3way_8", "under", 7), false);
  assert.equal(liveScoreBlocked("rest_1_1", { home: 1, away: 1 }, "2H"), false);
  assert.equal(liveScoreBlocked("rest_1_1", { home: 2, away: 1 }, "2H"), true);
  assert.equal(liveScoreBlocked("h1_rest_0_0", { home: 0, away: 0 }, "1H"), false);
  assert.equal(liveScoreBlocked("h1_rest_0_0", { home: 0, away: 0 }, "2H"), true);
});

test("late check: a goal or a corner after the bet voids it only where it helped", () => {
  assert.equal(goalsHelp("rest_1_1", "home", { home: 1, away: 1 }, ["home"]), true);
  assert.equal(goalsHelp("rest_1_1", "away", { home: 1, away: 1 }, ["home"]), false);
  assert.equal(cornerHelps("corners_3way_8", "over", "either"), true);
  assert.equal(cornerHelps("corners_3way_8", "exact", "either"), true);
  assert.equal(cornerHelps("corners_3way_8", "under", "either"), false);
});
