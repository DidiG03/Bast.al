// Run with `npm test --workspace apps/api` (builds first). Volleyball and
// handball from API-Sports (src/odds/volleyball.ts, handball.ts), on samples
// of the real feeds (fixtures/volleyball-*.json, handball-*.json): games and
// results read correctly, every market priced from the right side of each
// line, and every market settled correctly (volleyball by its own grading,
// handball by football's, on the 60 minutes).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseVolleyballGame, parseVolleyballOdds, gradeVolleyball } = require("../dist/odds/volleyball.js");
const { parseHandballGame, parseHandballOdds } = require("../dist/odds/handball.js");
const { teamPairPrices } = require("../dist/odds/team-sports.js");
const { gradeSelection } = require("../dist/bets/grading.js");

const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).response;
const vbGames = read("volleyball-games.json");
const vbOdds = read("volleyball-odds.json");
const hbGames = read("handball-games.json");
const hbOdds = read("handball-odds.json");
const market = (markets, key) => markets.find((m) => m.key === key);
const prices = (m) => Object.fromEntries(m.selections.map((s) => [s.key, s.odds]));

test("volleyball: finished, live and coming matches, with every set's points", () => {
  const fiveSets = parseVolleyballGame(vbGames.find((g) => g.id === 208029));
  assert.equal(fiveSets.status, "finished");
  assert.deepEqual(fiveSets.score, { home: 2, away: 3 });
  assert.deepEqual(fiveSets.sets.sets, [[25, 22], [23, 25], [25, 21], [19, 25], [11, 15]]);
  const fourSets = parseVolleyballGame(vbGames.find((g) => g.id === 210813));
  assert.deepEqual([fourSets.score, fourSets.sets.sets.length], [{ home: 1, away: 3 }, 4]);
  const live = parseVolleyballGame(vbGames.find((g) => g.id === 212595));
  assert.deepEqual([live.status, live.live, live.score], ["live", { home: 0, away: 1 }, null]);
  const coming = parseVolleyballGame(vbGames.find((g) => g.id === 213932));
  assert.deepEqual([coming.status, coming.home, coming.away, coming.league], ["upcoming", "Altekma", "Gaziantep Genclik", "Turkish Cup"]);
  // Set points whose winners don't add up to the sets won aren't kept.
  const raw = structuredClone(vbGames.find((g) => g.id === 208029));
  raw.periods.fifth = { home: 15, away: 11 };
  assert.equal(parseVolleyballGame(raw).sets, null);
  assert.equal(parseVolleyballGame({ ...raw, status: { short: "AW" } }).status, "cancelled");
  assert.equal(parseVolleyballGame({ ...raw, status: { short: "POST" } }).status, "postponed");
});

test("volleyball: the markets, each line's two sides from the same line", () => {
  const raw = vbOdds.find((o) => o.game.id === 213932);
  const markets = parseVolleyballOdds(raw, "Altekma", "Gaziantep Genclik", 4);
  assert.deepEqual(prices(market(markets, "vb_winner")), { home: 1.44, away: 2.62 }, "Bet365's prices first");
  // "Home -1.5"@1.90 and "Away -1.5"@1.80 are the two sides of the home team's −1.5 sets.
  const sets = market(markets, "vb_sets_handicap_m1_5");
  assert.deepEqual(prices(sets), { home: 1.9, away: 1.8 });
  assert.deepEqual(sets.selections.map((s) => s.name), ["Altekma −1.5", "Gaziantep Genclik +1.5"]);
  assert.deepEqual(prices(market(markets, "vb_correct_score")), { "3-0": 3.4, "3-1": 4, "2-3": 6.5, "1-3": 7, "0-3": 8 }, "the scorelines Bet365 prices");
  assert.deepEqual(prices(market(markets, "vb_sets_total_3_5")), { over: 1.46, under: 2.45 });
  // The 1st set and the match, from team names: "Altekma/Altekma" 1.74.
  // "Gaziantep Genclik/Altekma" 4.60 is the away team taking the 1st set and the home team the match.
  assert.deepEqual(prices(market(markets, "vb_s1_match")), { home_home: 1.74, home_away: 8.2, away_home: 4.6, away_away: 4.55 });
  assert.ok(market(markets, "vb_points_handicap_m8_5"));
  assert.ok(market(markets, "vb_s1_winner") && market(markets, "vb_s2_total_45_5") && market(markets, "vb_s1_odd_even"));
  // Only half lines: no market lands on a whole number.
  assert.ok(markets.filter((m) => /handicap|total|points_/.test(m.key)).every((m) => /_5$/.test(m.key)));
  for (const m of markets) assert.ok(m.selections.every((s) => s.odds > 1), m.key);
});

test("volleyball: every market settles on the sets won and the sets' points", () => {
  // 2–3: 25-22, 23-25, 25-21, 19-25, 11-15. Points 103–108.
  const result = parseVolleyballGame(vbGames.find((g) => g.id === 208029)).sets;
  const g = (key, sel, r = result) => gradeVolleyball(key, sel, 2, 3, r);
  assert.equal(g("vb_winner", "away"), "WON");
  assert.equal(g("vb_winner", "home"), "LOST");
  assert.equal(g("vb_sets_handicap_m1_5", "away"), "WON", "home −1.5 sets: 0.5–3");
  assert.equal(g("vb_sets_handicap_1_5", "home"), "WON", "home +1.5 sets: 3.5–3");
  assert.equal(g("vb_correct_score", "2-3"), "WON");
  assert.equal(g("vb_correct_score", "3-2"), "LOST");
  assert.equal(g("vb_sets_total_4_5", "over"), "WON");
  assert.equal(g("vb_4th_set", "yes"), "WON");
  assert.equal(g("vb_5th_set", "no"), "LOST");
  assert.equal(g("vb_home_wins_set", "yes"), "WON");
  assert.equal(g("vb_points_total_210_5", "over"), "WON", "211 points");
  assert.equal(g("vb_points_total_211_5", "under"), "WON");
  assert.equal(g("vb_points_handicap_m4_5", "away"), "WON", "103 − 4.5 against 108");
  assert.equal(g("vb_points_handicap_5_5", "home"), "WON", "103 + 5.5 against 108");
  assert.equal(g("vb_home_points_102_5", "over"), "WON");
  assert.equal(g("vb_away_points_108_5", "under"), "WON");
  assert.equal(g("vb_odd_even", "odd"), "WON", "211");
  assert.equal(g("vb_s1_match", "home_away"), "WON", "won the 1st set, lost the match");
  assert.equal(g("vb_s1_winner", "home"), "WON");
  assert.equal(g("vb_s2_handicap_m1_5", "away"), "WON", "23 − 1.5 against 25");
  assert.equal(g("vb_s3_total_45_5", "over"), "WON", "46");
  assert.equal(g("vb_s3_home_points_24_5", "over"), "WON");
  assert.equal(g("vb_s1_away_points_22_5", "under"), "WON");
  assert.equal(g("vb_s2_odd_even", "even"), "WON", "48");
  // Without the set points, or with ones that don't fit the sets won, the points markets wait.
  assert.equal(g("vb_points_total_210_5", "over", null), null);
  assert.equal(gradeVolleyball("vb_s1_winner", "home", 3, 2, result), null);
  assert.equal(g("vb_winner", "away", null), "WON", "the sets markets don't need them");
  assert.equal(g("vb_unknown", "home"), null);
});

test("handball: results on the 60 minutes, and the half-time score", () => {
  const ft = parseHandballGame(hbGames.find((g) => g.id === 202903));
  assert.deepEqual([ft.status, ft.score, ft.half], ["finished", { home: 22, away: 35 }, { home: 12, away: 15 }]);
  const cancelled = parseHandballGame(hbGames.find((g) => g.id === 193811));
  assert.deepEqual([cancelled.status, cancelled.score], ["cancelled", null]);
  // After extra time the score includes it; regular time is the two halves.
  const base = hbGames.find((g) => g.id === 202903);
  const aet = parseHandballGame({ ...base, status: { short: "AET" }, scores: { home: 33, away: 31 }, periods: { first: { home: 14, away: 13 }, second: { home: 14, away: 15 } } });
  assert.deepEqual([aet.score, aet.half], [{ home: 28, away: 28 }, { home: 14, away: 13 }]);
  const pens = parseHandballGame({ ...base, status: { short: "AP" }, scores: { home: 36, away: 35 }, periods: { first: { home: 14, away: 13 }, second: { home: 14, away: 15 } } });
  assert.deepEqual(pens.score, { home: 28, away: 28 });
  assert.equal(parseHandballGame({ ...base, status: { short: "AET" }, periods: {} }).score, null, "no halves after extra time: waits for Super Admin");
  // Halves that don't add up to the full-time score: the score stands, without a half-time score.
  const odd = parseHandballGame({ ...base, periods: { first: { home: 12, away: 15 }, second: { home: 9, away: 20 } } });
  assert.deepEqual([odd.score, odd.half], [{ home: 22, away: 35 }, null]);
  const live = parseHandballGame({ ...base, status: { short: "2H" }, scores: { home: 20, away: 25 } });
  assert.deepEqual([live.status, live.live, live.score], ["live", { home: 20, away: 25 }, null]);
});

test("handball: the markets use football's keys, each line's two sides from the same line", () => {
  const raw = hbOdds.find((o) => o.game.id === 203079);
  const markets = parseHandballOdds(raw, "CSM Bucuresti", "Minaur Baia Mare", 4);
  assert.deepEqual(prices(market(markets, "match_winner")), { home: 1.95, draw: 8, away: 2.15 });
  assert.equal(market(markets, "match_winner").name, "Result (60 minutes)");
  assert.deepEqual(prices(market(markets, "draw_no_bet")), { home: 1.75, away: 1.95 });
  assert.deepEqual(prices(market(markets, "ah_m0_5")), { home: 1.95, away: 1.75 }, "home −0.5 is a home win: 1.95 like the result");
  assert.deepEqual(prices(market(markets, "eh_m1")), { home: 2.35, draw: 13, away: 1.75 });
  assert.deepEqual(prices(market(markets, "goals_55_5")), { over: 1.85, under: 1.85 });
  // Half time / full time names the teams, "Baia Mare" for Minaur Baia Mare.
  const htft = prices(market(markets, "ht_ft"));
  assert.deepEqual([htft.home_home, htft.away_home, htft.home_away, htft.draw_draw], [2.5, 8.5, 9, 35]);
  assert.deepEqual(prices(market(markets, "highest_half")), { first: 2.15, second: 1.8, equal: 13 });
  assert.ok(["h1_winner", "h1_double_chance", "h1_draw_no_bet", "h2_winner", "h2_draw_no_bet", "result_goals_55_5"].every((key) => market(markets, key)));
  for (const m of markets) assert.ok(m.selections.every((s) => s.odds > 1), m.key);
  const other = parseHandballOdds(hbOdds.find((o) => o.game.id === 194187), "Sonderjyske W", "Skanderborg W", 4);
  assert.ok(market(other, "ah_m5_5") && market(other, "eh_m6") && market(other, "home_odd_even"));
});

test("handball: football's grading settles every market on the 60 minutes", () => {
  // 28–27, 15–12 at half time, so 13–15 in the 2nd half.
  const g = (key, sel) => gradeSelection(key, sel, 28, 27, { home: 15, away: 12 });
  assert.equal(g("match_winner", "home"), "WON");
  assert.equal(g("draw_no_bet", "home"), "WON");
  assert.equal(gradeSelection("draw_no_bet", "home", 28, 28, { home: 15, away: 12 }), "VOID", "a draw after 60 minutes gives the stake back");
  assert.equal(g("ah_m0_5", "home"), "WON");
  assert.equal(g("ah_m1_5", "away"), "WON");
  assert.equal(g("eh_m1", "draw"), "WON", "28 − 1 = 27");
  assert.equal(g("goals_55_5", "under"), "WON", "55 goals");
  assert.equal(g("goals_54_5", "over"), "WON");
  assert.equal(g("home_goals_27_5", "over"), "WON");
  assert.equal(g("odd_even", "odd"), "WON");
  assert.equal(g("ht_ft", "home_home"), "WON");
  assert.equal(g("highest_half", "first"), "LOST", "27 and 28");
  assert.equal(g("h1_winner", "home"), "WON");
  assert.equal(g("h1_ah_m2_5", "home"), "WON");
  assert.equal(g("h2_winner", "away"), "WON");
  assert.equal(g("h2_draw_no_bet", "away"), "WON");
  assert.equal(gradeSelection("h1_draw_no_bet", "home", 28, 27, { home: 14, away: 14 }), "VOID");
  assert.equal(g("h2_ah_p1_5", "home"), "LOST", "13 + 1.5 against 15");
  assert.equal(g("h2_eh_m1", "away"), "WON");
  assert.equal(g("result_goals_55_5", "home_under"), "WON");
  assert.equal(g("win_either_half", "away"), "WON");
});

test("team names in a bookmaker's values are matched only when they're clear", () => {
  const values = [
    { value: "Baia Mare/CSM Bucuresti", odd: "8.50" },
    { value: "Draw/Draw", odd: "35" },
  ];
  assert.deepEqual([...teamPairPrices(values, "CSM Bucuresti", "Minaur Baia Mare")], [["away_home", 8.5], ["draw_draw", 35]]);
  // A name that fits both teams can't be placed.
  assert.equal(teamPairPrices([{ value: "Bucuresti/Draw", odd: "3" }], "CSM Bucuresti", "Dinamo Bucuresti"), null);
  assert.equal(teamPairPrices([{ value: "Someone/Draw", odd: "3" }], "CSM Bucuresti", "Minaur Baia Mare"), null);
});
