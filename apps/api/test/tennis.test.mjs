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
  assert.deepEqual(markets.map((m) => m.key), ["tn_winner", "tn_set1", "tn_sets"]);
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
