// Run with `npm test --workspace apps/api` (builds first). Live markets that
// can't take a bet at the current score (odds/live-score-guard.ts): decided by
// the goals already in, or (handicaps) priced for the rest of the match while
// we settle on the whole match.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { liveScoreBlocked } = require("../dist/odds/live-score-guard.js");
const { selectionQuote } = require("../dist/odds/pricing.js");
const s = (home, away) => ({ home, away });

test("first team to score, first goalscorer and the Nth goal close once decided", () => {
  assert.equal(liveScoreBlocked("first_team_score", s(0, 0), "1H"), false);
  assert.equal(liveScoreBlocked("first_team_score", s(1, 0), "1H"), true);
  assert.equal(liveScoreBlocked("scorer_first", s(0, 1), "2H"), true);
  assert.equal(liveScoreBlocked("nth_goal_2", s(1, 0), "1H"), false);
  assert.equal(liveScoreBlocked("nth_goal_2", s(1, 1), "1H"), true);
  assert.equal(liveScoreBlocked("scorer_anytime", s(3, 2), "2H"), false, "not decided by the score");
  assert.equal(liveScoreBlocked("match_winner", s(3, 0), "2H"), false);
});

test("handicaps take live bets only at a level score (rest-of-match and whole-match agree then)", () => {
  assert.equal(liveScoreBlocked("ah_m0_5", s(0, 0), "1H"), false);
  assert.equal(liveScoreBlocked("ah_m0_5", s(1, 1), "2H"), false);
  assert.equal(liveScoreBlocked("ah_m0_5", s(1, 0), "2H"), true);
  assert.equal(liveScoreBlocked("eh_p1", s(0, 2), "2H"), true);
  assert.equal(liveScoreBlocked("h1_ah_m0_5", s(0, 0), "1H"), false);
  assert.equal(liveScoreBlocked("h1_ah_m0_5", s(0, 0), "2H"), true, "the 1st half is over");
  assert.equal(liveScoreBlocked("h2_ah_m0_5", s(0, 0), "2H"), true);
  assert.equal(liveScoreBlocked("corners_ah_m1_5", s(0, 0), "1H"), true);
  assert.equal(liveScoreBlocked("ah_m0_5", s(null, null), "1H"), true, "unknown score");
});

test("the board and bet placement see it: blocked markets aren't bettable", () => {
  const now = new Date();
  const event = { sport: "football", status: "LIVE", startsAt: new Date(now.getTime() - 50 * 60_000), suspended: false, hidden: false, liveStopped: false, liveOddsAt: now, elapsed: 50, period: "2H", homeScore: 1, awayScore: 0 };
  const quote = (key) => selectionQuote({ event, market: { key, liveSuspended: false }, selection: { feedOdds: 2, liveOdds: 2, result: null }, baseMargin: 0, ownerMargin: 0, override: null, now });
  assert.equal(quote("ah_m0_5").bettable, false);
  assert.equal(quote("first_team_score").bettable, false);
  assert.equal(quote("nth_goal_2").bettable, true);
  assert.equal(quote("match_winner").bettable, true);
});
