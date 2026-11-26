// Every goal, goal SportScore shows first ("ahead") and penalty pauses the
// match result and every other main market; the matcher pairs the team names
// lower leagues, reserve, women's and youth sides use.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { hitBy, EVENT_PAUSES, eventPause } = require("../dist/odds/live-guard.js");
const { teamScore, matchTrackerFixture } = require("../dist/tracker/tracker-match.js");

const MAIN = ["match_winner", "double_chance", "draw_no_bet", "goals_2_5", "btts", "correct_score", "ah_home_-0_5", "h1_winner", "next_goal_2", "corners_9_5", "cards_3_5"];

test("a goal, an early goal and a penalty pause every market, the match result (1X2) first among them", () => {
  for (const reason of ["goal", "ahead", "penalty"]) {
    for (const key of MAIN) assert.equal(hitBy(reason, key), true, `${reason} pauses ${key}`);
    assert.ok(EVENT_PAUSES.has(reason), `${reason} lasts until fresh prices`);
    const pause = eventPause({ reason, marketKey: "match_winner", pricedSinceEvent: true, now: new Date() });
    assert.ok(pause && pause.until > new Date(), `${reason}: 1X2 paused even when this reading priced it`);
  }
  // A VAR check and a red card pause 1X2 too.
  for (const reason of ["var", "red"]) assert.equal(hitBy(reason, "match_winner"), true);
});

test("team names: Turkish -spor, U-21 spellings, reserve and women's sides", () => {
  assert.equal(teamScore("Aksaray", "Aksarayspor"), 1);
  assert.equal(teamScore("Aksaray Belediyespor", "Aksaray Belediyespor"), 1);
  assert.equal(teamScore("Croatia U-21", "Croatia U21"), 1);
  assert.equal(teamScore("Spain Sub-21", "Spain U21"), 1);
  assert.equal(teamScore("Bengaluru B", "Bengaluru II"), 1, "B and II are the same reserve side");
  assert.equal(teamScore("Barcelona Reserves", "Barcelona B"), 1);
  assert.equal(teamScore("Bengaluru B", "Bengaluru"), 0, "a reserve side is never the first team");
  assert.equal(teamScore("Real Madrid W", "Real Madrid Women"), 1);
  assert.ok(teamScore("Bayern Frauen", "Bayern Munich W") >= 0.85);
  assert.equal(teamScore("Inter W", "Inter"), 0, "a women's side is never the men's");
  const at = "2026-11-18T12:00:00Z";
  const fx = (id, h, a) => ({ externalId: id, homeTeam: h, awayTeam: a, kickoff: new Date(at) });
  assert.equal(matchTrackerFixture({ homeTeam: "Real Madrid W", awayTeam: "Inter W", startsAt: new Date(at) }, [fx("rm-w", "Real Madrid Women", "Inter Women"), fx("rm", "Real Madrid", "Inter")])?.externalId, "rm-w");
});

test("a 3-way market at the same price on every outcome (2.75/2.75/2.75) is the bookmaker's placeholder: held", () => {
  const { placeholderHeld } = require("../dist/odds/api-football.js");
  const market = (prices) => ({ key: "match_winner", name: "Match winner", sortOrder: 0, suspended: false, selections: prices.map((odds, i) => ({ key: ["home", "draw", "away"][i], name: "x", odds, sortOrder: i })) });
  const flat = placeholderHeld(market([2.75, 2.75, 2.75]));
  assert.equal(flat.suspended, true);
  assert.ok(flat.selections.every((selection) => selection.held));
  assert.equal(placeholderHeld(market([2.75, 3.1, 2.6])).suspended, false, "real prices stay");
  const lines = { ...market([1.9, 1.9]), key: "goals_2_5" };
  assert.equal(placeholderHeld(lines).suspended, false, "an even two-way line is a real price");
});

test("no live bets while the score on the board is older than the one the feed has confirmed", () => {
  const { livePause, eventOpen, scoreBehind } = require("../dist/odds/pricing.js");
  const now = new Date();
  const live = { status: "LIVE", startsAt: new Date(now.getTime() - 80 * 60_000), suspended: false, hidden: false, liveStopped: false, liveOddsAt: now, elapsed: 80, period: "2H", homeScore: 2, awayScore: 0 };
  assert.equal(livePause({ ...live, liveScoreAhead: "3:0" }, now), "score");
  assert.equal(eventOpen({ ...live, liveScoreAhead: "3:0" }, now), false);
  assert.equal(scoreBehind({ ...live, liveScoreAhead: "2:0" }), false);
  assert.equal(livePause({ ...live, liveScoreAhead: null }, now), null);
});

test("the match minute follows the bookmaker's clock to the second, and never steps back", () => {
  const { minuteFrom } = require("../dist/odds/odds-sync.service.js");
  const now = new Date("2026-11-24T20:00:00Z");
  const at = minuteFrom("61:57", 61, 60, now);
  assert.equal(at.elapsed, 62, "61:57 played: the 62nd minute");
  assert.equal(at.elapsedAt.getTime(), now.getTime() - 57_000, "from when that minute began");
  assert.deepEqual(minuteFrom("50:10", 51, 62, now), {}, "an earlier minute is never saved");
  assert.equal(minuteFrom(null, 63, 62, now).elapsed, 63, "no clock: the feed's minute");
  assert.equal(minuteFrom("10:00", 63, 62, now).elapsed, 63, "a clock far from the feed's minute is ignored");
});

test("an Owner's percentage on a match: up or down, to the cent, never over 10% above the feed or under 1.01", () => {
  const { adjustPrice } = require("../dist/odds/pricing.js");
  assert.equal(adjustPrice(2.0, 5, 2.2), 2.1);
  assert.equal(adjustPrice(2.0, -10, 2.2), 1.8);
  assert.equal(adjustPrice(2.0, 0, 2.2), 2.0);
  assert.equal(adjustPrice(2.0, 50, 2.2), 2.42, "capped at 10% above the feed (2.20 × 1.10)");
  assert.equal(adjustPrice(1.02, -50, 1.1), 1.01);
});
