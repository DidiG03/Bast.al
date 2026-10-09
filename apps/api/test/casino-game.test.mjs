// Run with `npm test --workspace apps/api` (builds first). The casino slot's
// rules on fixed reel stops: lines, cherries from 2, stars anywhere. The
// payout rate itself is measured by scripts/casino-rtp.mjs over millions of spins.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SeededRandomNumberGenerator } = require("pokie");
const { BETS, GAMBLE_LIMIT, GAMBLE_STEPS, LINES, LINE_PAYS, LINE_SHAPES, REEL_STRIPS, ROWS, SCATTER, SCATTER_PAYS, SUITS, colorOf, playRound } = require("../dist/casino/game.js");

/** A random source that stops each reel where we say. */
const stopsAt = (...stops) => {
  let reel = 0;
  return { getRandomInt: () => stops[reel++ % stops.length] };
};

/** Where on a reel's strip to stop so `symbol` shows on `row`. */
function stopFor(reel, symbol, row = 1) {
  const strip = REEL_STRIPS[reel];
  const at = strip.indexOf(symbol);
  assert.ok(at >= 0, `${symbol} is on reel ${reel + 1}`);
  return (at - row + strip.length) % strip.length;
}

/** A stop on `reel` whose visible rows hold none of `symbols`. */
function stopWithout(reel, ...symbols) {
  const strip = REEL_STRIPS[reel];
  for (let stop = 0; stop < strip.length; stop++) {
    const shown = [0, 1, 2].map((row) => strip[(stop + row) % strip.length]);
    if (!shown.some((symbol) => symbols.includes(symbol))) return stop;
  }
  throw new Error(`no stop on reel ${reel + 1} without ${symbols.join(", ")}`);
}

test("the reels, lines and bets are what the rules say", () => {
  assert.equal(REEL_STRIPS.length, 5);
  assert.equal(LINES, 5);
  assert.equal(LINE_SHAPES.length, LINES);
  assert.ok(LINE_SHAPES.every((shape) => shape.length === 5 && shape.every((row) => row >= 0 && row < ROWS)));
  assert.deepEqual([...BETS], [0.5, 1, 2, 5, 10, 25]);
  for (const strip of REEL_STRIPS) assert.ok(strip.includes(SCATTER));
  for (const [symbol, pays] of Object.entries(LINE_PAYS)) assert.equal(pays[0] > 0, symbol === "CHERRY", `only cherries pay for 2 (${symbol})`);
});

test("four sevens on the middle line pay", () => {
  const stops = [...[0, 1, 2, 3].map((reel) => stopFor(reel, "SEVEN", 1)), stopWithout(4, "SEVEN")];
  const round = playRound(stopsAt(...stops));
  assert.deepEqual(round.stops, stops);
  const middle = round.lines.find((line) => line.line === 0);
  assert.deepEqual([middle.symbol, middle.count, middle.win], ["SEVEN", 4, LINE_PAYS.SEVEN[2]]);
  assert.deepEqual(middle.cells, [[0, 1], [1, 1], [2, 1], [3, 1]]);
  assert.equal(round.win, round.lines.reduce((sum, line) => sum + line.win, 0) + (round.scatter?.win ?? 0));
});

test("five sevens never land on a line: the reels land again", () => {
  const sevens = REEL_STRIPS.map((_, reel) => stopFor(reel, "SEVEN", 1));
  const next = [0, 1, 2, 3, 4].map((reel) => stopWithout(reel, "SEVEN"));
  const round = playRound(stopsAt(...sevens, ...next));
  assert.deepEqual(round.stops, next);
  assert.ok(!round.lines.some((line) => line.symbol === "SEVEN"));
  assert.throws(() => playRound(stopsAt(...sevens)), /couldn't land/);
});

test("2 cherries pay; 2 of anything else doesn't", () => {
  const cherries = playRound(stopsAt(stopFor(0, "CHERRY"), stopFor(1, "CHERRY"), stopWithout(2, "CHERRY", SCATTER), stopWithout(3, SCATTER), stopWithout(4, SCATTER)));
  const middle = cherries.lines.find((line) => line.line === 0);
  assert.deepEqual([middle.symbol, middle.count, middle.win], ["CHERRY", 2, LINE_PAYS.CHERRY[0]]);

  const lemons = playRound(stopsAt(stopFor(0, "LEMON"), stopFor(1, "LEMON"), stopWithout(2, "LEMON", SCATTER), stopWithout(3, SCATTER), stopWithout(4, SCATTER)));
  assert.equal(lemons.lines.some((line) => line.line === 0), false);
  assert.ok(lemons.lines.every((line) => line.win > 0), "a line listed always pays");
});

test("3 or more stars anywhere pay, and never on a line", () => {
  for (const stars of [3, 4, 5]) {
    const stops = REEL_STRIPS.map((_, reel) => (reel < stars ? stopFor(reel, SCATTER, reel % ROWS) : stopWithout(reel, SCATTER)));
    const round = playRound(stopsAt(...stops));
    const landed = round.grid.flat().filter((symbol) => symbol === SCATTER).length;
    assert.equal(landed, stars);
    assert.equal(round.scatter.count, stars);
    assert.equal(round.scatter.win, SCATTER_PAYS[stars]);
    assert.equal(round.lines.some((line) => line.symbol === SCATTER), false);
  }
});

test("the same seed plays the same rounds", () => {
  const play = (rng) => Array.from({ length: 50 }, () => playRound(rng).stops.join(","));
  assert.deepEqual(play(new SeededRandomNumberGenerator(9)), play(new SeededRandomNumberGenerator(9)));
});

test("double or nothing: two red suits, two black, and its limits", () => {
  assert.deepEqual(SUITS.map(colorOf), ["RED", "RED", "BLACK", "BLACK"]);
  assert.ok(GAMBLE_STEPS > 0 && GAMBLE_LIMIT > 0);
});
