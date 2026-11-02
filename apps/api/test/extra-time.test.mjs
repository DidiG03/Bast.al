// Run with `npm test --workspace apps/api` (builds first). Extra time and
// penalties (odds/extra-time.ts): their markets open only in extra time, the
// 90-minute ones never then, betting closes near the end of extra time and for
// the shootout, and they settle on extra time's own goals and the shootout.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { marketInPhase, liveCutoffReached, gradeExtraTime, isExtraTimeMarket } = require("../dist/odds/extra-time.js");
const { parseFixture, parseLiveOdds } = require("../dist/odds/api-football.js");
const { selectionQuote, livePause } = require("../dist/odds/pricing.js");

test("phase: extra-time markets only in extra time, 90-minute markets never then, nothing in the shootout", () => {
  for (const key of ["et_winner", "et_double_chance", "et_goals_0_5", "to_qualify", "pen_winner"]) {
    assert.equal(isExtraTimeMarket(key), true);
    assert.equal(marketInPhase(key, "2H"), false, key);
    assert.equal(marketInPhase(key, "BT"), true, key);
    assert.equal(marketInPhase(key, "ET"), true, key);
    assert.equal(marketInPhase(key, "P"), false, key);
  }
  for (const key of ["match_winner", "goals_2_5", "corners_9_5", "correct_score"]) {
    assert.equal(isExtraTimeMarket(key), false);
    assert.equal(marketInPhase(key, "1H"), true, key);
    assert.equal(marketInPhase(key, "ET"), false, key);
    assert.equal(marketInPhase(key, "BT"), false, key);
    assert.equal(marketInPhase(key, "P"), false, key);
  }
});

test("cutoff: minute 89 in the 90 minutes, 118 in extra time, always in the shootout", () => {
  assert.equal(liveCutoffReached(88, "2H"), false);
  assert.equal(liveCutoffReached(89, "2H"), true);
  assert.equal(liveCutoffReached(90, "BT"), false, "the break before extra time is open");
  assert.equal(liveCutoffReached(105, "ET"), false);
  assert.equal(liveCutoffReached(118, "ET"), true);
  assert.equal(liveCutoffReached(120, "P"), true);
});

test("live board: a 90-minute market isn't bettable in extra time; an extra-time one is", () => {
  const now = new Date();
  const event = { sport: "football", status: "LIVE", startsAt: new Date(now.getTime() - 110 * 60_000), suspended: false, hidden: false, liveStopped: false, liveOddsAt: now, elapsed: 100, period: "ET" };
  const quote = (key, ev = event) => selectionQuote({ event: ev, market: { key, liveSuspended: false }, selection: { feedOdds: 2, liveOdds: 2, result: null }, baseMargin: 0, ownerMargin: 0, override: null, now });
  assert.equal(livePause(event, now), null);
  assert.equal(quote("et_winner").bettable, true);
  assert.equal(quote("match_winner").bettable, false);
  assert.equal(quote("et_winner", { ...event, period: "P", elapsed: 120 }).bettable, false);
  assert.equal(quote("et_winner", { ...event, period: "2H", elapsed: 80 }).bettable, false);
  assert.equal(quote("match_winner", { ...event, period: "2H", elapsed: 80 }).bettable, true);
});

test("feed: the extra-time markets are read from the live odds", () => {
  const raw = {
    fixture: { id: 9, status: { long: "Extra Time", elapsed: 100 } },
    status: { stopped: false, blocked: false, finished: false },
    odds: [
      { id: 2, name: "1x2 Extra Time", values: [{ value: "Home", odd: "3.1" }, { value: "Draw", odd: "1.6" }, { value: "Away", odd: "5.5" }] },
      { id: 250, name: "Extra Time Over/Under Line", values: [{ value: "Over", odd: "2.2", handicap: "0.5" }, { value: "Under", odd: "1.6", handicap: "0.5" }] },
      { id: 10, name: "To Qualify", values: [{ value: "Home", odd: "1.8" }, { value: "Away", odd: "2.0" }] },
      { id: 107, name: "Penalties Shootout Winner", values: [{ value: "Home", odd: "1.9" }, { value: "Away", odd: "1.9" }] },
      { id: 165, name: "Double Chance Extra Time", values: [{ value: "Home/Draw", odd: "1.2" }, { value: "Home/Away", odd: "2.3" }, { value: "Draw/Away", odd: "1.3" }] },
    ],
  };
  const parsed = parseLiveOdds(raw, "Roma", "Lazio");
  const keys = parsed.markets.map((m) => m.key);
  assert.deepEqual(keys.slice(0, 5), ["to_qualify", "et_winner", "et_double_chance", "et_goals_0_5", "pen_winner"], "first on the board, To qualify on top");
  assert.deepEqual(parsed.markets.find((m) => m.key === "et_winner").selections.map((s) => [s.key, s.name, s.odds]), [["home", "Roma", 3.1], ["draw", "Draw", 1.6], ["away", "Lazio", 5.5]]);
  assert.equal(parsed.markets.find((m) => m.key === "et_goals_0_5").name, "Extra time goals 0.5");
});

test("feed: a finished match's extra-time goals and shootout", () => {
  const fixture = (short, goals, score) => parseFixture({ fixture: { id: 1, date: "2026-11-02T20:00:00Z", status: { short, elapsed: 120 } }, league: { id: 2, name: "Cup", country: "World", season: 2026 }, teams: { home: { name: "A" }, away: { name: "B" } }, goals, score });
  const pen = fixture("PEN", { home: 2, away: 2 }, { fulltime: { home: 1, away: 1 }, extratime: { home: 1, away: 1 }, penalty: { home: 4, away: 3 } });
  assert.deepEqual(pen.result, { home: 1, away: 1 }, "the 90 minutes, as before");
  assert.deepEqual(pen.extraTimeScore, { home: 1, away: 1 });
  assert.deepEqual(pen.penalties, { home: 4, away: 3 });
  const aet = fixture("AET", { home: 3, away: 2 }, { fulltime: { home: 2, away: 2 }, extratime: { home: 1, away: 0 }, penalty: { home: null, away: null } });
  assert.deepEqual(aet.extraTimeScore, { home: 1, away: 0 });
  assert.equal(aet.penalties, null);
  const ft = fixture("FT", { home: 1, away: 0 }, { fulltime: { home: 1, away: 0 } });
  assert.equal(ft.extraTimeScore, null);
  assert.equal(ft.penalties, null);
});

test("settling: on extra time's own goals, then the shootout", () => {
  const pens = { extraTime: true, extraTimeScore: { home: 1, away: 1 }, penalties: { home: 4, away: 3 } };
  const aet = { extraTime: true, extraTimeScore: { home: 0, away: 1 }, penalties: null };
  const none = { extraTime: false, extraTimeScore: null, penalties: null };
  assert.equal(gradeExtraTime("et_winner", "draw", pens), "WON");
  assert.equal(gradeExtraTime("et_winner", "home", pens), "LOST");
  assert.equal(gradeExtraTime("et_winner", "away", aet), "WON");
  assert.equal(gradeExtraTime("et_double_chance", "draw_away", aet), "WON");
  assert.equal(gradeExtraTime("et_double_chance", "home_draw", aet), "LOST");
  assert.equal(gradeExtraTime("et_goals_1_5", "over", pens), "WON");
  assert.equal(gradeExtraTime("et_goals_1_5", "under", aet), "WON");
  assert.equal(gradeExtraTime("to_qualify", "home", pens), "WON", "level after extra time: the shootout decides");
  assert.equal(gradeExtraTime("to_qualify", "away", aet), "WON", "extra time decided it");
  assert.equal(gradeExtraTime("pen_winner", "home", pens), "WON");
  assert.equal(gradeExtraTime("pen_winner", "away", pens), "LOST");
  assert.equal(gradeExtraTime("pen_winner", "home", aet), "VOID", "no shootout");
  assert.equal(gradeExtraTime("et_winner", "home", none), "VOID", "no extra time");
  // A number missing: wait for Super Admin.
  assert.equal(gradeExtraTime("to_qualify", "home", { extraTime: true, extraTimeScore: { home: 1, away: 1 }, penalties: null }), null);
  assert.equal(gradeExtraTime("et_winner", "home", { extraTime: true, extraTimeScore: null, penalties: null }), null);
});
