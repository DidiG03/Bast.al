// Run with `npm test --workspace apps/api` (builds first). Tennis: reading
// API-Tennis' matches and odds, and settling match winner, 1st set winner and
// set betting, retirements included.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gradeTennis, parseTennisMatch, parseTennisOdds, setFinished, setsWon } from "../dist/odds/tennis.js";

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).result;
const matches = await load("tennis-fixtures.json");
const odds = await load("tennis-odds.json");
const match = (key) => parseTennisMatch(matches.find((m) => m.event_key === key));

test("a match is read with its tour, tournament, round, players and start in UTC", () => {
  const m = match("12077001");
  assert.deepEqual(
    [m.externalId, m.tour, m.tournament, m.round, m.home, m.away, m.startsAt.toISOString(), m.status, m.result],
    ["12077001", "ATP Singles", "Shanghai", "Shanghai - 1/8-finals", "J. Sinner", "B. Shelton", "2026-10-07T11:30:00.000Z", "upcoming", null],
  );
});

test("a finished match keeps every set, tie-breaks read as the games", () => {
  const m = match("12077002");
  assert.equal(m.status, "finished");
  assert.deepEqual(m.result, { outcome: "home", sets: [[4, 6], [7, 6], [6, 2]], completed: true });
  assert.deepEqual(setsWon(m.result), { home: 2, away: 1 });
});

test("a retirement, a walkover and a live match", () => {
  const retired = match("12077003");
  assert.equal(retired.status, "retired");
  assert.deepEqual(retired.result, { outcome: "away", sets: [[6, 3], [1, 2]], completed: false });
  assert.deepEqual(setsWon(retired.result), { home: 1, away: 0 }, "the unfinished set doesn't count");
  assert.equal(match("12077004").status, "cancelled");
  const live = match("12077005");
  assert.equal(live.status, "live");
  assert.equal(live.result, null);
});

test("prices: the chosen bookmaker, else one that prices the whole market", () => {
  const markets = parseTennisOdds(odds["12077001"], "J. Sinner", "B. Shelton", "bet365");
  assert.deepEqual(markets.map((m) => m.key).slice(0, 3), ["tn_winner", "tn_set1", "tn_sets"]);
  assert.deepEqual(markets[0].selections.map((s) => [s.key, s.name, s.odds]), [["home", "J. Sinner", 1.44], ["away", "B. Shelton", 2.75]]);
  assert.deepEqual(markets[1].selections.map((s) => s.odds), [1.5, 2.5], "bwin, the only one with the 1st set");
  assert.deepEqual(
    markets[2].selections.map((s) => [s.key, s.name, s.odds]),
    [["2_0", "J. Sinner 2-0", 2.1], ["2_1", "J. Sinner 2-1", 3.75], ["0_2", "B. Shelton 2-0", 6], ["1_2", "B. Shelton 2-1", 5.5]],
  );
  assert.deepEqual(parseTennisOdds(odds["12077009"], "A", "B", "bet365"), [], "half a market isn't offered");
});

test("settling a finished match", () => {
  const result = match("12077002").result;
  assert.equal(gradeTennis("tn_winner", "home", result), "WON");
  assert.equal(gradeTennis("tn_winner", "away", result), "LOST");
  assert.equal(gradeTennis("tn_set1", "away", result), "WON");
  assert.equal(gradeTennis("tn_sets", "2_1", result), "WON");
  assert.equal(gradeTennis("tn_sets", "2_0", result), "LOST");
  assert.equal(gradeTennis("tn_winner", "home", null), null);
});

test("a retirement: the 1st set stands once finished, the rest is void", () => {
  const result = match("12077003").result;
  assert.equal(gradeTennis("tn_set1", "home", result), "WON");
  assert.equal(gradeTennis("tn_winner", "away", result), "VOID");
  assert.equal(gradeTennis("tn_sets", "0_2", result), "VOID");
  assert.equal(gradeTennis("tn_set1", "home", { outcome: "away", sets: [[3, 2]], completed: false }), "VOID", "retired during the 1st set");
});

test("when a set is over", () => {
  assert.equal(setFinished(6, 4), true);
  assert.equal(setFinished(7, 6), true);
  assert.equal(setFinished(6, 5), false);
  assert.equal(setFinished(10, 8), true, "a match tie-break");
  assert.equal(setFinished(5, 3), false);
});

test("more markets: straight sets, 1st set score, total games and games handicap", () => {
  const markets = parseTennisOdds(odds["12077001"], "J. Sinner", "B. Shelton", "bet365");
  const keys = markets.map((m) => m.key);
  assert.deepEqual(keys, ["tn_winner", "tn_set1", "tn_sets", "tn_straight_home", "tn_straight_away", "tn_set1_score", "tn_games_20_5", "tn_games_21_5", "tn_games_22_5", "tn_set1_games_9_5", "tn_handicap_m4_5", "tn_handicap_m3_5"]);
  const by = (key) => markets.find((m) => m.key === key);
  assert.deepEqual(by("tn_straight_home").selections.map((s) => [s.key, s.odds]), [["yes", 1.95], ["no", 1.8]]);
  assert.equal(by("tn_straight_away").name, "B. Shelton to win in straight sets");
  assert.deepEqual(by("tn_set1_score").selections.map((s) => s.name).slice(0, 5), ["J. Sinner 6-3", "J. Sinner 6-4", "J. Sinner 7-5", "J. Sinner 7-6", "B. Shelton 6-3"], "1:0 isn't a set score");
  assert.deepEqual(by("tn_games_21_5").selections.map((s) => [s.name, s.odds]), [["Over 21.5", 1.8], ["Under 21.5", 1.95]], "the even line and those nearest; whole lines left out");
  assert.deepEqual(by("tn_handicap_m3_5").selections.map((s) => [s.name, s.odds]), [["J. Sinner −3.5", 1.85], ["B. Shelton +3.5", 1.9]]);
});

test("settling the new markets", () => {
  // Swiatek 4-6 7-6 6-2: 31 games, 17 to 14; the 1st set went 4-6.
  const result = match("12077002").result;
  assert.equal(gradeTennis("tn_straight_home", "no", result), "WON");
  assert.equal(gradeTennis("tn_straight_away", "no", result), "WON");
  assert.equal(gradeTennis("tn_set1_score", "4_6", result), "WON");
  assert.equal(gradeTennis("tn_set1_score", "6_4", result), "LOST");
  assert.equal(gradeTennis("tn_set1_games_9_5", "over", result), "WON");
  assert.equal(gradeTennis("tn_games_30_5", "over", result), "WON");
  assert.equal(gradeTennis("tn_games_31_5", "under", result), "WON");
  assert.equal(gradeTennis("tn_handicap_m2_5", "home", result), "WON", "17 - 2.5 beats 14");
  assert.equal(gradeTennis("tn_handicap_m3_5", "away", result), "WON", "17 - 3.5 is short of 14");
  const straight = { outcome: "away", sets: [[3, 6], [6, 7]], completed: true };
  assert.equal(gradeTennis("tn_straight_away", "yes", straight), "WON");
  assert.equal(gradeTennis("tn_straight_home", "no", straight), "WON");
  // A match tie-break counts as one game.
  assert.equal(gradeTennis("tn_games_25_5", "under", { outcome: "home", sets: [[6, 4], [4, 6], [10, 8]], completed: true }), "WON", "21 games");
  // Zverev retired at 6-3 1-2: the 1st set markets stand, the rest is void.
  const retired = match("12077003").result;
  assert.equal(gradeTennis("tn_set1_score", "6_3", retired), "WON");
  assert.equal(gradeTennis("tn_set1_games_8_5", "over", retired), "WON");
  assert.equal(gradeTennis("tn_games_20_5", "under", retired), "VOID");
  assert.equal(gradeTennis("tn_handicap_m3_5", "home", retired), "VOID");
  assert.equal(gradeTennis("tn_straight_home", "no", retired), "VOID");
});
