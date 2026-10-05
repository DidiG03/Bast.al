// Run with `npm test --workspace apps/api` (builds first). Basketball:
// reading API-Sports' games and European prices (as the feed sent them on
// 5 October 2026), The Odds API's NBA prices, and settling winner, handicap
// and total points on the final score, overtime included.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gradeBasketball, parseApiSportsOdds, parseGame, parseOddsApiEvent, teamKey } from "../dist/odds/basketball.js";

const read = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const games = (await read("basketball-games.json")).response;
const odds = (await read("basketball-odds.json")).response;
const nba = await read("odds-api-nba.json");

test("a game is read with its league, teams, status and, once over, its final score", () => {
  const verona = parseGame(games.find((g) => g.id === 509592));
  assert.deepEqual([verona.leagueId, verona.league, verona.country, verona.home, verona.away, verona.status, verona.score], [52, "Lega A", "Italy", "Verona", "Olimpia Milano", "upcoming", null]);
  const done = parseGame(games.find((g) => g.id === 512043));
  assert.deepEqual([done.status, done.score], ["finished", { home: 87, away: 97 }]);
  assert.equal(parseGame({ ...games[0], status: { short: "Q3" } }).status, "live");
  assert.equal(parseGame({ ...games[0], status: { short: "POST" } }).status, "postponed");
});

test("European prices: the winner, and the five half-point handicap and total lines nearest the even one", () => {
  const raw = odds.find((o) => o.game.id === 509592);
  const markets = parseApiSportsOdds(raw, "Verona", "Olimpia Milano", 4);
  const winner = markets.find((m) => m.key === "bb_winner");
  assert.deepEqual(winner.selections.map((s) => [s.key, s.name, s.odds]), [["home", "Verona", 4], ["away", "Olimpia Milano", 1.23]]);
  const handicaps = markets.filter((m) => m.key.startsWith("bb_handicap_"));
  assert.deepEqual(handicaps.map((m) => m.key), ["bb_handicap_6_5", "bb_handicap_7_5", "bb_handicap_8_5", "bb_handicap_9_5", "bb_handicap_10_5"], "8.5 is even (1.86 / 1.86)");
  const even = handicaps.find((m) => m.key === "bb_handicap_8_5");
  assert.equal(even.name, "Handicap Verona +8.5");
  assert.deepEqual(even.selections.map((s) => [s.name, s.odds]), [["Verona +8.5", 1.86], ["Olimpia Milano −8.5", 1.86]]);
  const totals = markets.filter((m) => m.key.startsWith("bb_total_"));
  assert.deepEqual(totals.map((m) => m.key), ["bb_total_168_5", "bb_total_169_5", "bb_total_170_5", "bb_total_171_5", "bb_total_172_5"], "half-point lines only: no stake back on landing on it");
});

test("NBA prices from The Odds API: DraftKings first, its spread and total", () => {
  const markets = parseOddsApiEvent(nba[0], "Atlanta Hawks", "Memphis Grizzlies");
  assert.deepEqual(markets.map((m) => m.key), ["bb_winner", "bb_handicap_m2_5", "bb_total_224_0"]);
  assert.deepEqual(markets[0].selections.map((s) => s.odds), [1.77, 2.1], "DraftKings, not the first bookmaker listed");
  assert.deepEqual(markets[1].selections.map((s) => s.name), ["Atlanta Hawks −2.5", "Memphis Grizzlies +2.5"]);
  assert.equal(teamKey("Atlanta  Hawks"), teamKey("atlanta hawks"));
});

test("winner, handicap and total points settle on the final score, overtime included; landing on a whole line is void", () => {
  // Verona 80, Milano 87 (after overtime).
  assert.equal(gradeBasketball("bb_winner", "away", 80, 87), "WON");
  assert.equal(gradeBasketball("bb_winner", "home", 80, 87), "LOST");
  assert.equal(gradeBasketball("bb_handicap_8_5", "home", 80, 87), "WON", "Verona +8.5: 88.5 v 87");
  assert.equal(gradeBasketball("bb_handicap_8_5", "away", 80, 87), "LOST");
  assert.equal(gradeBasketball("bb_handicap_m2_5", "home", 110, 107), "WON", "Hawks −2.5 win by 3");
  assert.equal(gradeBasketball("bb_handicap_m2_5", "away", 110, 109), "WON", "Grizzlies +2.5 lose by 1");
  assert.equal(gradeBasketball("bb_total_170_5", "under", 80, 87), "WON", "167 points");
  assert.equal(gradeBasketball("bb_total_224_0", "over", 112, 112), "VOID", "exactly 224");
  assert.equal(gradeBasketball("bb_handicap_m3_0", "home", 103, 100), "VOID", "won by exactly 3");
});
