// The match centre Players with bets see: the feed's events and statistics
// read into a timeline and a few numbers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseMatchCentre } = require("../dist/odds/api-football.js");

const person = (name) => ({ id: 1, name });
const home = { id: 10, name: "Tirana" };
const away = { id: 20, name: "Partizani" };
const raw = {
  fixture: { id: 1, date: "", status: { short: "2H", elapsed: 70 } },
  league: { id: 1, name: "", country: "", season: 2026 },
  teams: { home, away },
  goals: { home: 2, away: 1 },
  events: [
    { time: { elapsed: 12 }, team: home, player: person("Hoxha"), assist: person("Krasniqi"), type: "Goal", detail: "Normal Goal" },
    { time: { elapsed: 30 }, team: away, player: person("Berisha"), assist: person(null), type: "Card", detail: "Yellow Card" },
    { time: { elapsed: 44, extra: 2 }, team: away, player: person("Gashi"), assist: person(null), type: "Goal", detail: "Penalty" },
    { time: { elapsed: 55 }, team: away, player: person("Berisha"), assist: person(null), type: "Card", detail: "Second Yellow card" },
    { time: { elapsed: 60 }, team: home, player: person("Dervishi"), assist: person("Hoxha"), type: "subst", detail: "Substitution 1" },
    { time: { elapsed: 63 }, team: away, player: person("Leka"), assist: person(null), type: "Goal", detail: "Own Goal" },
    { time: { elapsed: 66 }, team: home, player: person("Hoxha"), assist: person(null), type: "Var", detail: "Goal cancelled" },
    { time: { elapsed: 68 }, team: home, player: person("Shehu"), assist: person(null), type: "Goal", detail: "Missed Penalty" },
  ],
  statistics: [
    { team: away, statistics: [{ type: "Corner Kicks", value: 3 }, { type: "Yellow Cards", value: 1 }, { type: "Red Cards", value: 1 }, { type: "Shots on Goal", value: 2 }, { type: "Ball Possession", value: "41%" }] },
    { team: home, statistics: [{ type: "Corner Kicks", value: 7 }, { type: "Yellow Cards", value: null }, { type: "Red Cards", value: null }, { type: "Shots on Goal", value: 6 }, { type: "Ball Possession", value: "59%" }] },
  ],
};

test("the timeline: newest first, each moment on its side, in a few plain kinds", () => {
  const centre = parseMatchCentre(raw);
  assert.deepEqual(
    centre.moments.map((m) => [m.minute, m.extra, m.side, m.kind, m.player]),
    [
      [68, null, "home", "missed_penalty", "Shehu"],
      [66, null, "home", "var", "Hoxha"],
      [63, null, "away", "own_goal", "Leka"],
      [60, null, "home", "sub", "Dervishi"],
      [55, null, "away", "red", "Berisha"],
      [44, 2, "away", "penalty", "Gashi"],
      [30, null, "away", "yellow", "Berisha"],
      [12, null, "home", "goal", "Hoxha"],
    ],
  );
  assert.equal(centre.moments.find((m) => m.kind === "var").detail, "Goal cancelled");
  assert.equal(centre.moments.find((m) => m.kind === "goal").other, "Krasniqi", "the assist");
});

test("the numbers, home first even when the feed lists away first; a count it leaves empty is 0", () => {
  const centre = parseMatchCentre(raw);
  assert.deepEqual(centre.corners, [7, 3]);
  assert.deepEqual(centre.yellow, [0, 1]);
  assert.deepEqual(centre.red, [0, 1]);
  assert.deepEqual(centre.shotsOnTarget, [6, 2]);
  assert.deepEqual(centre.possession, [59, 41]);
});

test("without statistics, cards come from the timeline and corners are unknown", () => {
  const centre = parseMatchCentre({ ...raw, statistics: [] });
  assert.equal(centre.corners, null);
  assert.deepEqual(centre.yellow, [0, 1]);
  assert.deepEqual(centre.red, [0, 1], "a second yellow counts as a red");
  const empty = parseMatchCentre({ ...raw, events: [], statistics: [] });
  assert.deepEqual([empty.moments, empty.yellow, empty.red], [[], null, null], "nothing known yet");
});

test("every number the feed has, home first, in a fixed order; expected goals and percentages read as numbers", () => {
  const centre = parseMatchCentre({
    ...raw,
    statistics: [
      { team: away, statistics: [{ type: "Fouls", value: 9 }, { type: "Ball Possession", value: "41%" }, { type: "expected_goals", value: "0.84" }, { type: "Passes %", value: "77%" }, { type: "Yellow Cards", value: 1 }, { type: "goals_prevented", value: null }] },
      { team: home, statistics: [{ type: "Fouls", value: 12 }, { type: "Ball Possession", value: "59%" }, { type: "expected_goals", value: "1.91" }, { type: "Passes %", value: "85%" }, { type: "Yellow Cards", value: null }, { type: "goals_prevented", value: null }] },
    ],
  });
  assert.deepEqual(centre.stats, [
    { type: "expected_goals", home: 1.91, away: 0.84 },
    { type: "Ball Possession", home: 59, away: 41 },
    { type: "Fouls", home: 12, away: 9 },
    { type: "Yellow Cards", home: 0, away: 1 },
    { type: "Red Cards", home: 0, away: 1 },
    { type: "Passes %", home: 85, away: 77 },
  ]);
  assert.deepEqual(parseMatchCentre({ ...raw, statistics: [] }).stats, [], "no numbers until the feed has statistics");
});

test("the team sheets, once the feed has both", () => {
  const sheet = (team, coach) => ({
    team,
    coach: { name: coach },
    formation: "4-3-3",
    startXI: [{ player: { id: 1, name: "Strakosha", number: 1, pos: "G" } }, { player: { id: 2, name: "Hysaj", number: 2, pos: "D" } }],
    substitutes: [{ player: { id: 3, name: "Berisha", number: 12, pos: null } }],
  });
  const centre = parseMatchCentre({ ...raw, lineups: [sheet(away, "Sylvinho"), sheet(home, "Kuqi")] });
  assert.equal(centre.lineups.home.coach, "Kuqi", "home first even when the feed lists away first");
  assert.deepEqual(centre.lineups.home.starting[0], { name: "Strakosha", number: 1, pos: "G" });
  assert.deepEqual(centre.lineups.away.bench, [{ name: "Berisha", number: 12, pos: null }]);
  assert.equal(parseMatchCentre({ ...raw, lineups: [sheet(home, "Kuqi")] }).lineups, null, "one team's sheet isn't enough");
  assert.equal(parseMatchCentre(raw).lineups, null);
});
