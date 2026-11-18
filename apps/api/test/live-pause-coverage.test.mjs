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
