// Run with `npm test --workspace apps/api` (builds first). NFL: reading
// API-Sports' American football games and prices (as the feed sent them on
// 5 October 2026), which come in basketball's shape and settle the same way.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gradeBasketball, parseApiSportsOdds } from "../dist/odds/basketball.js";
import { parseNflGame } from "../dist/odds/nfl.js";

const read = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const games = (await read("nfl-games.json")).response;
const odds = (await read("nfl-odds.json")).response;
const raw = (id) => games.find((g) => g.game.id === id);

test("a game is read with its league, teams, kick-off, status and, once over, its final score", () => {
  const saints = parseNflGame(raw(21576));
  assert.deepEqual(
    [saints.externalId, saints.leagueId, saints.league, saints.country, saints.home, saints.away, saints.startsAt.toISOString(), saints.status, saints.score],
    ["21576", 1, "NFL", "USA", "New Orleans Saints", "Atlanta Falcons", "2026-10-06T00:15:00.000Z", "upcoming", null],
  );
  const done = parseNflGame(raw(21575));
  assert.deepEqual([done.status, done.score], ["finished", { home: 32, away: 26 }]);
  assert.deepEqual(parseNflGame(raw(24147)).score, { home: 34, away: 42 }, "after overtime (AOT): the total includes it");
  assert.equal(parseNflGame(raw(23597)).leagueId, 2, "college football is told apart by its league");
  assert.equal(parseNflGame({ ...raw(21576), game: { ...raw(21576).game, status: { short: "Q2" } } }).status, "live");
  assert.equal(parseNflGame({ ...raw(21576), game: { ...raw(21576).game, status: { short: "PST" } } }).status, "postponed");
  assert.equal(parseNflGame({ ...raw(21576), game: { id: 1 } }), null, "no kick-off time");
});

test("bet365's prices: the winner, and the five half-point spread and total lines nearest the even one", () => {
  const markets = parseApiSportsOdds(odds[0], "Carolina Panthers", "Detroit Lions", 4);
  assert.deepEqual(markets.find((m) => m.key === "bb_winner").selections.map((s) => [s.name, s.odds]), [["Carolina Panthers", 2.7], ["Detroit Lions", 1.48]]);
  assert.deepEqual(markets.filter((m) => m.key.startsWith("bb_handicap_")).map((m) => m.key), ["bb_handicap_1_5", "bb_handicap_2_5", "bb_handicap_3_5", "bb_handicap_4_5", "bb_handicap_5_5"], "+3.5 is even (1.95 / 1.86)");
  assert.deepEqual(markets.find((m) => m.key === "bb_handicap_3_5").selections.map((s) => [s.name, s.odds]), [["Carolina Panthers +3.5", 1.95], ["Detroit Lions −3.5", 1.86]]);
  assert.deepEqual(markets.filter((m) => m.key.startsWith("bb_total_")).map((m) => m.key), ["bb_total_49_5", "bb_total_50_5", "bb_total_51_5", "bb_total_52_5", "bb_total_53_5"], "51.5 is even (1.90 / 1.90)");
});

test("a tie voids the winner bet; the spread and total settle on the score", () => {
  assert.equal(gradeBasketball("bb_winner", "home", 20, 20), "VOID");
  assert.equal(gradeBasketball("bb_handicap_3_5", "home", 32, 26), "WON", "Panthers +3.5 won outright");
  assert.equal(gradeBasketball("bb_handicap_3_5", "away", 32, 26), "LOST");
  assert.equal(gradeBasketball("bb_total_51_5", "over", 32, 26), "WON", "58 points");
});
