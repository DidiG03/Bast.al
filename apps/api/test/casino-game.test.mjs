// Run with `npm test --workspace apps/api` (builds first). The casino slot's
// rules on fixed reel stops: lines, wilds, goals and free spins. The payout
// rate itself is measured by scripts/casino-rtp.mjs over millions of spins.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SeededRandomNumberGenerator } = require("pokie");
const { BETS, FREE_SPINS, LINES, LINE_PAYS, LINE_SHAPES, REEL_STRIPS, ROWS, SCATTER, SCATTER_PAYS, WILD, payTable, playRound } = require("../dist/casino/game.js");

/** A random source that stops each reel where we say. */
const stopsAt = (...stops) => {
  let reel = 0;
  return { getRandomInt: () => stops[reel++ % stops.length] };
};

/** Where on a reel's strip `symbol` starts a run that fills the visible rows from `row`. */
function stopFor(reel, symbol, row = 1) {
  const strip = REEL_STRIPS[reel];
  const at = strip.indexOf(symbol);
  assert.ok(at >= 0, `${symbol} is on reel ${reel + 1}`);
  return (at - row + strip.length) % strip.length;
}

test("the reels, lines and bets are what the rules say", () => {
  assert.equal(REEL_STRIPS.length, 5);
  assert.equal(LINE_SHAPES.length, LINES);
  assert.ok(LINE_SHAPES.every((shape) => shape.length === 5 && shape.every((row) => row >= 0 && row < ROWS)));
  assert.deepEqual([...BETS], [0.5, 1, 2, 5, 10]);
  for (const [reel, strip] of REEL_STRIPS.entries()) {
    const wilds = strip.filter((symbol) => symbol === WILD).length;
    assert.equal(wilds > 0, reel >= 1 && reel <= 3, `wilds only on the middle reels (reel ${reel + 1})`);
    assert.ok(strip.includes(SCATTER), `a goal on reel ${reel + 1}`);
  }
});

test("a round lands where the random source says and pays its lines", () => {
  // Put a SEVEN on the middle row of every reel: line 0 (the middle row) pays 5 in a row.
  const stops = REEL_STRIPS.map((_, reel) => stopFor(reel, "SEVEN", 1));
  const round = playRound(stopsAt(...stops));
  assert.deepEqual(round.stops, stops);
  assert.deepEqual(round.grid.map((column) => column[1]), ["SEVEN", "SEVEN", "SEVEN", "SEVEN", "SEVEN"]);
  const middle = round.lines.find((line) => line.line === 0);
  assert.deepEqual([middle.symbol, middle.count, middle.win], ["SEVEN", 5, LINE_PAYS.SEVEN[2]]);
  assert.deepEqual(middle.cells, [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]]);
  assert.equal(round.win, round.lines.reduce((sum, line) => sum + line.win, 0) + (round.scatter?.win ?? 0));
});

test("a wild stands in for a symbol, but not for a goal", () => {
  // SEVEN, WILD, SEVEN on the middle row, then whatever.
  const stops = [stopFor(0, "SEVEN"), stopFor(1, WILD), stopFor(2, "SEVEN"), stopFor(3, "RED", 0), stopFor(4, "RED", 0)];
  const round = playRound(stopsAt(...stops));
  const middle = round.lines.find((line) => line.line === 0);
  assert.equal(middle?.symbol, "SEVEN");
  assert.ok(middle.count >= 3);
  assert.equal(middle.win, LINE_PAYS.SEVEN[middle.count - 3]);
});

test("3 goals anywhere pay and start free spins; 4 and 5 give more", () => {
  for (const goals of [3, 4, 5]) {
    const stops = REEL_STRIPS.map((_, reel) => (reel < goals ? stopFor(reel, SCATTER, reel % ROWS) : stopFor(reel, "RED", 1)));
    const round = playRound(stopsAt(...stops));
    const landed = round.grid.flat().filter((symbol) => symbol === SCATTER).length;
    assert.ok(landed >= goals, `${goals} goals on the reels`);
    assert.equal(round.scatter.count, landed);
    assert.equal(round.scatter.win, SCATTER_PAYS[Math.min(landed, 5)]);
    assert.equal(round.freeSpins, FREE_SPINS[Math.min(landed, 5)]);
    assert.equal(round.lines.some((line) => line.symbol === SCATTER), false, "goals never pay on a line");
  }
});

test("the same seed plays the same rounds", () => {
  const a = Array.from({ length: 50 }, ((rng) => () => playRound(rng).stops.join(","))(new SeededRandomNumberGenerator(9)));
  const b = Array.from({ length: 50 }, ((rng) => () => playRound(rng).stops.join(","))(new SeededRandomNumberGenerator(9)));
  assert.deepEqual(a, b);
});

test("the pay table in dollars is the line pays times a tenth of the bet", () => {
  const table = payTable(2);
  assert.deepEqual(table.lines.find((row) => row.symbol === "SEVEN").pays, LINE_PAYS.SEVEN.map((pay) => pay * 0.2));
  assert.deepEqual(table.scatter.freeSpins, [FREE_SPINS[3], FREE_SPINS[4], FREE_SPINS[5]]);
});
