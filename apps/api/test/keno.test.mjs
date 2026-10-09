// Run with `npm test --workspace apps/api` (builds first). Keno's rules: the
// pay table pays back about 90% for every number of picks, worked out
// exactly from the odds, and the draw is fair and comes from the seeds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BETS, DRAWN, MAX_MULTIPLIER, MAX_PICKS, MIN_PICKS, NUMBERS, PAYS, chanceOf, drawFor, hitsOf, invalidPicks, payoutRate, winCents } = require("../dist/casino/keno.js");

test("the board, the draw and the bets are what the rules say", () => {
  assert.deepEqual([NUMBERS, DRAWN, MIN_PICKS, MAX_PICKS], [80, 20, 1, 10]);
  assert.deepEqual([...BETS], [50, 100, 250, 500, 1000, 2500]);
  assert.equal(MAX_MULTIPLIER, 2000);
  for (let picks = MIN_PICKS; picks <= MAX_PICKS; picks++) {
    assert.equal(PAYS[picks].length, picks + 1, `a pay for 0 to ${picks} hits`);
    const total = PAYS[picks].reduce((sum, _, hits) => sum + chanceOf(picks, hits), 0);
    assert.ok(Math.abs(total - 1) < 1e-12, "the chances add up to 1");
    // Pays are whole tenths, so a win in cents is exact.
    assert.ok(PAYS[picks].every((pay) => Number.isInteger(Math.round(pay * 10)) && Math.abs(pay * 10 - Math.round(pay * 10)) < 1e-9));
  }
});

test("every number of picks pays back between 89% and 91%", () => {
  for (let picks = MIN_PICKS; picks <= MAX_PICKS; picks++) {
    const rate = payoutRate(picks);
    assert.ok(rate > 89 && rate < 91, `${picks} picks pay back ${rate.toFixed(2)}%`);
  }
  assert.equal(payoutRate(1), 90, "1 pick: a 1 in 4 chance at 3.6x");
});

test("a win is the stake times the pay, rounded down to the cent", () => {
  assert.equal(winCents(100, 1, 1), 360);
  assert.equal(winCents(50, 10, 3), 25, "0.5x of 0.50");
  assert.equal(winCents(250_000, 10, 10), 500_000_000, "2,500 ALL on 10 of 10 pays 5,000,000 ALL");
  assert.equal(winCents(100, 5, 2), 0);
  assert.equal(winCents(100, 10, 0), 200, "none of 10 pays 2x");
});

test("picks are 1 to 10 different numbers from 1 to 80", () => {
  assert.equal(invalidPicks([1]), null);
  assert.equal(invalidPicks([1, 2, 3, 4, 5, 6, 7, 8, 9, 80]), null);
  assert.match(invalidPicks([]), /Pick 1 to 10/);
  assert.match(invalidPicks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), /Pick 1 to 10/);
  assert.match(invalidPicks([0]), /from 1 to 80/);
  assert.match(invalidPicks([81]), /from 1 to 80/);
  assert.match(invalidPicks([2.5]), /from 1 to 80/);
  assert.match(invalidPicks([7, 7]), /once/);
  assert.match(invalidPicks("1,2"), /Pick 1 to 10/);
});

test("a draw is 20 different numbers from 1 to 80, the same for the same seeds", () => {
  const drawn = drawFor("server-seed", "client", 0);
  assert.equal(drawn.length, DRAWN);
  assert.equal(new Set(drawn).size, DRAWN);
  assert.ok(drawn.every((number) => Number.isInteger(number) && number >= 1 && number <= NUMBERS));
  assert.deepEqual(drawFor("server-seed", "client", 0), drawn);
  assert.notDeepEqual(drawFor("server-seed", "client", 1), drawn, "the nonce changes the draw");
  assert.notDeepEqual(drawFor("server-seed", "other", 0), drawn, "the client seed changes the draw");
  assert.deepEqual(hitsOf([drawn[0], drawn[5], 0], drawn), [drawn[0], drawn[5]]);
});

test("every number is drawn about as often as the others", () => {
  const counts = new Array(NUMBERS + 1).fill(0);
  const rounds = 20_000;
  for (let nonce = 0; nonce < rounds; nonce++) for (const number of drawFor("fairness", "check", nonce)) counts[number]++;
  // Each number is drawn in 1 round in 4: 5,000 times, give or take about 61 (one standard deviation).
  for (let number = 1; number <= NUMBERS; number++) assert.ok(Math.abs(counts[number] - 5000) < 300, `${number} drawn ${counts[number]} times`);
});
