// Run with `npm test --workspace apps/api` (builds first). MMA: reading
// API-Sports' fights, odds and results (UFC 332, as the feed sent it), and
// settling fight winner, fight result and total rounds.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fightMinutes, fightResult, gradeFight, parseFight, parseFightOdds } from "../dist/odds/mma.js";
import { eventOpen } from "../dist/odds/pricing.js";

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).response;
const fights = await load("mma-fights.json");
const results = await load("mma-results.json");
const odds = await load("mma-odds.json");
const details = (id) => results.find((r) => r.fight.id === id);
const later = new Date("2026-10-05T12:00:00Z");

test("a fight is read with its card, weight class, fighters and winner", () => {
  const fight = parseFight(fights.find((f) => f.id === 2909));
  assert.deepEqual(
    [fight.externalId, fight.card, fight.weightClass, fight.home, fight.away, fight.status, fight.winner],
    ["2909", "UFC 332: Silva vs. Wang", "Women's Flyweight", "Wang Cong", "Natalia Silva", "finished", "away"],
  );
  assert.equal(parseFight({ ...fights[0], status: { short: "NS" } }).status, "upcoming");
  assert.equal(parseFight({ ...fights[0], status: { short: "CANC" } }).status, "cancelled");
});

test("a result needs its details (method, round, time); after six hours the winner alone will do", () => {
  const fight = parseFight(fights.find((f) => f.id === 2907));
  assert.deepEqual(fightResult(fight, details(2907), later), { outcome: "home", method: "KO", round: 1, time: "3:12" });
  assert.equal(fightResult(fight, undefined, new Date(fight.startsAt.getTime() + 3_600_000)), null, "an hour on, still waiting for the details");
  assert.deepEqual(fightResult(fight, undefined, later), { outcome: "home", method: null, round: null, time: null });
  assert.equal(fightMinutes(fightResult(fight, details(2907), later)), 3.2, "3:12 of round 1");
  assert.equal(fightMinutes(fightResult(parseFight(fights.find((f) => f.id === 2909)), details(2909), later)), 25, "five full rounds");
});

test("the markets come from bet365, in the fighters' names", () => {
  const raw = odds.find((o) => o.fight.id === 2909);
  const markets = parseFightOdds(raw, "Wang Cong", "Natalia Silva", 5);
  assert.deepEqual(markets.map((m) => m.key), ["fight_winner", "fight_result", "rounds_1_5", "rounds_2_5", "rounds_3_5", "rounds_4_5"]);
  const winner = markets.find((m) => m.key === "fight_winner");
  assert.deepEqual(winner.selections.map((s) => [s.key, s.name, s.odds]), [["home", "Wang Cong", 2.7], ["away", "Natalia Silva", 1.48]]);
  assert.deepEqual(markets.find((m) => m.key === "rounds_4_5").selections.map((s) => [s.name, s.odds]), [["Over 4.5 rounds", 1.38], ["Under 4.5 rounds", 2.95]]);
  // bet365 doesn't price the 3-way result: the next bookmaker that does fills it in.
  assert.deepEqual(markets.find((m) => m.key === "fight_result").selections.map((s) => s.key), ["home", "draw", "away"]);
});

test("fight winner, fight result and total rounds settle; a draw voids the winner bet, a no contest voids everything", () => {
  const ko = { outcome: "home", method: "KO", round: 1, time: "3:12" };
  assert.equal(gradeFight("fight_winner", "home", ko), "WON");
  assert.equal(gradeFight("fight_winner", "away", ko), "LOST");
  assert.equal(gradeFight("rounds_1_5", "under", ko), "WON", "over by 3:12 of round 1");
  assert.equal(gradeFight("rounds_1_5", "over", ko), "LOST");
  const decision = { outcome: "away", method: "Points", round: 5, time: "5:00" };
  assert.equal(gradeFight("rounds_4_5", "over", decision), "WON");
  assert.equal(gradeFight("fight_distance", "yes", decision), "WON");
  assert.equal(gradeFight("fight_distance", "yes", ko), "LOST");
  assert.equal(gradeFight("rounds_1_5", "over", { outcome: "home", method: "Submission", round: 2, time: "2:31" }), "WON", "past 2:30 of round 2");
  assert.equal(gradeFight("rounds_1_5", "over", { outcome: "home", method: "Submission", round: 2, time: "2:29" }), "LOST");

  const draw = { outcome: "draw", method: "Points", round: 3, time: "5:00" };
  assert.equal(gradeFight("fight_winner", "home", draw), "VOID");
  assert.equal(gradeFight("fight_result", "draw", draw), "WON");
  assert.equal(gradeFight("fight_result", "home", draw), "LOST");
  assert.equal(gradeFight("rounds_2_5", "over", { outcome: "no_contest", method: "No Contest", round: 2, time: "1:00" }), "VOID");
  assert.equal(gradeFight("rounds_1_5", "over", { outcome: "home", method: null, round: null, time: null }), null, "no round yet: it waits");
});

test("bets close at the card's first fight, even before this fight's own start", () => {
  const now = new Date("2026-10-04T00:30:00Z");
  const fight = { sport: "mma", status: "UPCOMING", startsAt: new Date("2026-10-04T02:15:00Z"), closesAt: new Date("2026-10-04T00:00:00Z"), suspended: false, hidden: false, liveStopped: false, liveOddsAt: null };
  assert.equal(eventOpen(fight, now), false);
  assert.equal(eventOpen({ ...fight, closesAt: new Date("2026-10-04T01:00:00Z") }, now), true);
});
