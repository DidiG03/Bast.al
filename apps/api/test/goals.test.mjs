// Run with `npm test --workspace apps/api` (builds first). The goal-event
// markets: reading a match's goals and squads from the feed, matching a
// bookmaker's player names to them, and settling first/last team to score,
// win from behind and the goalscorer markets.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gradeGoalMarket, matchPlayer } from "../dist/bets/goals.js";
import { gradeSelection } from "../dist/bets/grading.js";
import { parseGoalRecord, parseMarkets } from "../dist/odds/api-football.js";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/api-football-fixtures-with-events.json", import.meta.url), "utf8")).response;
// Corinthians 1–3 Fluminense: Hulk 27', Gustavo Henrique 56', Hulk 76', K. Serna 90'.
const corinthians = fixtures.find((f) => f.fixture.id === 1492382);
// Flamengo 2–1 RB Bragantino: G. Varela 13', Pedro 71', then an own goal by Bruno Henrique (Flamengo) for Bragantino 86'.
const flamengo = fixtures.find((f) => f.fixture.id === 1492383);

const players = (names) => names.map((name, i) => ({ id: i + 1, side: "home", names: [name], played: true, cameOnAt: null }));

test("a match's goals are read in order, with own goals counting for the team they're given to", () => {
  const record = parseGoalRecord(corinthians, { home: 1, away: 3 });
  assert.deepEqual(
    record.goals.map((g) => [g.minute, g.side, g.player, g.ownGoal]),
    [
      [27, "away", "Hulk", false],
      [56, "home", "Gustavo Henrique", false],
      [76, "away", "Hulk", false],
      [90, "away", "K. Serna", false],
    ],
  );
  const own = parseGoalRecord(flamengo, { home: 2, away: 1 });
  assert.deepEqual(own.goals.map((g) => [g.side, g.player, g.ownGoal]), [["home", "G. Varela", false], ["home", "Pedro", false], ["away", "Bruno Henrique", true]]);
});

test("goals that don't add up to the score settle nothing", () => {
  assert.equal(parseGoalRecord(corinthians, { home: 1, away: 2 }), null);
  const record = parseGoalRecord(corinthians, { home: 1, away: 3 });
  assert.equal(gradeGoalMarket("first_team_score", "away", record, { home: 2, away: 3 }), null, "a corrected score makes the saved goals unusable");
});

test("the squads are read with every spelling of a name, who played, and when subs came on", () => {
  const record = parseGoalRecord(corinthians, { home: 1, away: 3 });
  const depay = record.players.find((p) => p.id === 667);
  assert.ok(depay.names.includes("Memphis Depay") && depay.names.includes("M. Depay"));
  assert.equal(depay.played, true);
  assert.equal(depay.cameOnAt, null, "a starter");
  const lingard = record.players.find((p) => p.names.includes("Jesse Lingard"));
  assert.equal(lingard.played, true);
  assert.ok(lingard.cameOnAt > 0, "came on in the 80th minute");
  const unused = record.players.find((p) => p.names.includes("Allan"));
  assert.equal(unused.played, false);
});

test("first and last team to score, and no goal", () => {
  const record = parseGoalRecord(corinthians, { home: 1, away: 3 });
  const score = { home: 1, away: 3 };
  assert.equal(gradeGoalMarket("first_team_score", "away", record, score), "WON");
  assert.equal(gradeGoalMarket("first_team_score", "home", record, score), "LOST");
  assert.equal(gradeGoalMarket("first_team_score", "none", record, score), "LOST");
  assert.equal(gradeGoalMarket("last_team_score", "away", record, score), "WON");
  const goalless = { goals: [], players: null };
  assert.equal(gradeGoalMarket("first_team_score", "none", goalless, { home: 0, away: 0 }), "WON");
  assert.equal(gradeGoalMarket("last_team_score", "home", goalless, { home: 0, away: 0 }), "LOST");
  // An own goal counts for the team it's given to.
  const own = parseGoalRecord(flamengo, { home: 2, away: 1 });
  assert.equal(gradeGoalMarket("last_team_score", "away", own, { home: 2, away: 1 }), "WON");
});

test("win from behind needs the team to trail at some point and still win", () => {
  const goal = (side, minute) => ({ minute, side, playerId: null, player: null, ownGoal: false, penalty: false, at: minute });
  const comeback = { goals: [goal("away", 10), goal("home", 50), goal("home", 80)], players: null };
  assert.equal(gradeGoalMarket("win_from_behind", "home", comeback, { home: 2, away: 1 }), "WON");
  assert.equal(gradeGoalMarket("win_from_behind", "away", comeback, { home: 2, away: 1 }), "LOST");
  const frontRunner = { goals: [goal("home", 10), goal("away", 50), goal("home", 80)], players: null };
  assert.equal(gradeGoalMarket("win_from_behind", "home", frontRunner, { home: 2, away: 1 }), "LOST", "level at 1–1 isn't behind");
});

test("a bookmaker's name finds the player however the feed spells it, and never guesses", () => {
  const squad = players(["M. Depay", "K. Serna", "Hulk", "G. de Arrascaeta", "Pedro", "Pedro Raul", "Bruno Henrique", "Gustavo Henrique"]);
  assert.equal(matchPlayer("Memphis Depay", squad).names[0], "M. Depay");
  assert.equal(matchPlayer("Kevin Serna", squad).names[0], "K. Serna");
  assert.equal(matchPlayer("Hulk", squad).names[0], "Hulk");
  assert.equal(matchPlayer("Giorgian de Arrascaeta", squad).names[0], "G. de Arrascaeta");
  assert.equal(matchPlayer("Pedro Raul", squad).names[0], "Pedro Raul", "the exact name wins over a looser match");
  assert.equal(matchPlayer("Henrique", squad), "ambiguous", "two Henriques: left for Super Admin");
  assert.equal(matchPlayer("Júlio Fidélis", players(["Julio Fidelis"])).names[0], "Julio Fidelis", "accents don't matter");
  assert.equal(matchPlayer("Lionel Messi", squad), null);
});

test("goalscorer markets: own goals don't count, non-players are void, a late sub's first-goalscorer bet is void", () => {
  const record = parseGoalRecord(corinthians, { home: 1, away: 3 });
  const score = { home: 1, away: 3 };
  const names = ["Hulk", "Kevin Serna", "Gustavo Henrique", "Memphis Depay", "Jesse Lingard", "Allan", "Lionel Messi", "No goalscorer"];
  const grade = (market, name, key = "x") => gradeGoalMarket(market, key, record, score, name, names);
  assert.equal(grade("scorer_anytime", "Hulk"), "WON");
  assert.equal(grade("scorer_anytime", "Kevin Serna"), "WON");
  assert.equal(grade("scorer_anytime", "Memphis Depay"), "LOST");
  assert.equal(grade("scorer_first", "Hulk"), "WON");
  assert.equal(grade("scorer_first", "Gustavo Henrique"), "LOST");
  assert.equal(grade("scorer_last", "Kevin Serna"), "WON");
  assert.equal(grade("scorer_anytime", "Allan"), "VOID", "on the bench all match");
  assert.equal(grade("scorer_first", "Jesse Lingard"), "VOID", "came on after the first goal");
  assert.equal(grade("scorer_last", "Jesse Lingard"), "LOST", "anyone who played can be the last scorer");
  assert.equal(grade("scorer_anytime", "Lionel Messi"), "VOID", "not in either squad, and every goal is someone else's");
  assert.equal(grade("scorer_first", "No goalscorer", "none"), "LOST");

  // Flamengo's last goal was an own goal: the last goalscorer is Pedro.
  const own = parseGoalRecord(flamengo, { home: 2, away: 1 });
  const ownNames = ["Pedro", "Bruno Henrique", "Giorgian de Arrascaeta"];
  assert.equal(gradeGoalMarket("scorer_last", "x", own, { home: 2, away: 1 }, "Pedro", ownNames), "WON");
  assert.equal(gradeGoalMarket("scorer_anytime", "x", own, { home: 2, away: 1 }, "Bruno Henrique", ownNames), "LOST", "an own goal isn't a goal for the scorer");
});

test("without lineups, only a named scorer settles; the rest wait for Super Admin", () => {
  const record = { goals: [{ minute: 30, side: "home", playerId: 9, player: "E. Haaland", ownGoal: false, penalty: false, at: 3 }], players: null };
  const score = { home: 1, away: 0 };
  assert.equal(gradeGoalMarket("scorer_anytime", "x", record, score, "Erling Haaland"), "WON");
  assert.equal(gradeGoalMarket("scorer_first", "x", record, score, "Erling Haaland"), "WON");
  assert.equal(gradeGoalMarket("scorer_anytime", "x", record, score, "Phil Foden"), null);
  assert.equal(gradeGoalMarket("scorer_first", "none", { goals: [], players: null }, { home: 0, away: 0 }, "No goalscorer"), "WON");
  assert.equal(gradeSelection("scorer_anytime", "x", 1, 0), null, "no goals saved yet");
  assert.equal(gradeSelection("scorer_anytime", "x", 1, 0, null, null, { record, selectionName: "Erling Haaland", marketNames: [] }), "WON");
});

test("the goalscorer markets parse from a real feed answer, shortest price first", async () => {
  const raw = JSON.parse(await readFile(new URL("./fixtures/api-football-odds-wide.json", import.meta.url), "utf8")).response[0];
  const markets = parseMarkets(raw, "Home FC", "Away FC", 8);
  const anytime = markets.find((m) => m.key === "scorer_anytime");
  assert.ok(anytime.selections.length >= 40);
  assert.ok(anytime.selections.every((s, i, all) => i === 0 || all[i - 1].odds <= s.odds));
  assert.ok(anytime.selections.some((s) => s.key === "reinier-carvalho" && s.name === "Reinier Carvalho"));
  const first = markets.find((m) => m.key === "scorer_first");
  assert.equal(first.selections[first.selections.length - 1].key, "none", "No goalscorer comes last");
  assert.equal(new Set(first.selections.map((s) => s.key)).size, first.selections.length);
});
