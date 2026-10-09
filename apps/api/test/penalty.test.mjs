// Run with `npm test --workspace apps/api` (builds first). Penalty's rules:
// where the keeper dives, what each goal pays, and that a cash-out returns
// 92% after 1 or 2 goals and less the longer the round runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BETS, DIRECTIONS, MAX_WIN, cashOut, kick, multiplierHundredths, payoutCents, publicView, startRound } = require("../dist/casino/penalty.js");

test("the directions and the bets are what the rules say", () => {
  assert.deepEqual([...DIRECTIONS], ["LEFT", "CENTER", "RIGHT"]);
  assert.deepEqual([...BETS], [50, 100, 250, 500, 1000, 2500]);
  assert.equal(MAX_WIN, 5000);
});

test("the first goal pays 1.38, and the multiplier only rises until the cap", () => {
  assert.equal(multiplierHundredths(0), 100);
  assert.equal(multiplierHundredths(1), 138);
  assert.equal(payoutCents(100, 1), 138);
  assert.equal(payoutCents(50, 1), 69);
  let previous = 100;
  for (let goals = 1; goals <= 30; goals++) {
    const next = multiplierHundredths(goals);
    assert.ok(next >= previous);
    assert.ok(next <= MAX_WIN * 100);
    previous = next;
  }
  assert.equal(multiplierHundredths(40), MAX_WIN * 100);
});

test("cashing out after 1 or 2 goals pays back 92%, and later goals pay back less each time", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 10].map(multiplierHundredths), [138, 207, 300, 435, 631, 4044]);
  let previous = Infinity;
  for (let goals = 1; goals <= 10; goals++) {
    const back = (2 / 3) ** goals * payoutCents(10_000, goals);
    const target = 0.92 * 10_000;
    assert.ok(back <= target + 1, `${goals} goals pays ${back} against ${target}`);
    if (goals <= 2) assert.ok(target - back < 100, `${goals} goals floors by less than a dollar on a $100 stake`);
    else assert.ok(back < previous, `${goals} goals pays back less than ${goals - 1}`);
    previous = back;
  }
  // 70% back after 10 goals.
  assert.ok(Math.abs((2 / 3) ** 10 * payoutCents(10_000, 10) - 7_000) < 50);
});

test("the keeper matching the aim is a save, and a different way is a goal", () => {
  const round = startRound(200);
  assert.equal(publicView(round).cashout, 0);
  assert.equal(publicView(round).kicks.length, 0);

  const goal = kick(round, "LEFT", () => 1);
  assert.equal(goal.phase, "PLAY");
  assert.equal(goal.goals.length, 1);
  assert.deepEqual(publicView(goal).kicks, [{ aim: "LEFT", dive: "CENTER", goal: true }]);
  assert.equal(publicView(goal).multiplier, 1.38);

  const saved = kick(goal, "RIGHT", () => 2);
  assert.equal(saved.phase, "LOST");
  assert.equal(saved.payout, 0);
  assert.deepEqual(publicView(saved).kicks.at(-1), { aim: "RIGHT", dive: "RIGHT", goal: false });
});

test("cashing out needs a goal, and a finished shootout stays finished", () => {
  const round = startRound(100);
  assert.throws(() => cashOut(round), /Score a goal before you cash out/);
  const scored = kick(round, "CENTER", () => 0);
  const taken = cashOut(scored);
  assert.equal(taken.phase, "WON");
  assert.equal(taken.payout, 138);
  assert.throws(() => kick(taken, "LEFT", () => 0), /This round is already over/);
  assert.throws(() => kick(round, "UP", () => 0), /Aim left, center or right/);
});

test("reaching the cap cashes the shootout out on that goal", () => {
  let round = startRound(100);
  // The keeper always dives left, and every kick aims right, so every one scores.
  while (round.phase === "PLAY") round = kick(round, "RIGHT", () => 0);
  assert.equal(round.phase, "WON");
  assert.equal(round.capped, true);
  assert.equal(round.payout, 100 * MAX_WIN);
});
