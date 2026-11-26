// Run with `npm test --workspace apps/api` (builds first). Candy Cascade's rules (src/casino/candy.ts):
// what a board pays, how candies tumble, the lollipops, the multipliers, and the payout rate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Candy = require("../dist/casino/candy.js");

/** A repeatable random draw (mulberry32). */
function seeded(seed) {
  let a = seed >>> 0;
  return (below) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
  };
}

/** A board of 30 cells, filled with `fill` then the given cells set. */
function board(fill, cells = {}) {
  const b = Array.from({ length: Candy.CELLS }, () => fill);
  for (const [index, cell] of Object.entries(cells)) b[Number(index)] = cell;
  return b;
}

/** A board with no win at all: nine candies spread so none reaches 8, and no lollipops. */
function quietBoard() {
  return Array.from({ length: Candy.CELLS }, (_, i) => Candy.PAYING[i % Candy.PAYING.length]);
}

test("a candy pays from 8 anywhere, in three bands", () => {
  assert.equal(Candy.payFor("HEART", 7), 0);
  assert.equal(Candy.payFor("HEART", 8), 1000);
  assert.equal(Candy.payFor("HEART", 9), 1000);
  assert.equal(Candy.payFor("HEART", 10), 2500);
  assert.equal(Candy.payFor("HEART", 12), 5000);
  assert.equal(Candy.payFor("HEART", 30), 5000);
  assert.equal(Candy.payFor("PEACH", 8), 25);
  // Every candy pays more the more there are, and the higher candies more than the lower.
  for (const symbol of Candy.PAYING) {
    const [a, b, c] = Candy.PAYS[symbol];
    assert.ok(a < b && b < c, symbol);
  }
  assert.equal(quietBoard().length, 30);
  assert.deepEqual(Candy.winsOn(quietBoard()), []);
});

test("winning candies burst and the rest fall, with new ones dropping in above", () => {
  // 8 hearts: the top row of columns 0–3 and the second row of columns 0–3.
  const cells = {};
  for (let column = 0; column < 4; column++) {
    cells[Candy.at(column, 0)] = "HEART";
    cells[Candy.at(column, 1)] = "HEART";
  }
  const start = quietBoard();
  // Make sure nothing else on the board would win: replace any heart outside those cells.
  for (let i = 0; i < start.length; i++) if (start[i] === "HEART") start[i] = "LOLLIPOP";
  for (const [i, cell] of Object.entries(cells)) start[Number(i)] = cell;
  const wins = Candy.winsOn(start);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].symbol, "HEART");
  assert.equal(wins[0].count, 8);
  assert.equal(wins[0].pay, 1000);
  // A draw of 0 always picks the first candy in the weights (a heart), so the new ones can be told from the old.
  const next = Candy.tumble(start, wins, false, () => 0);
  for (let column = 0; column < 4; column++) {
    // The two top rows are new, and the three below are what was in rows 2–4 before.
    assert.equal(next[Candy.at(column, 0)], Object.keys(Candy.WEIGHTS.base)[0]);
    assert.equal(next[Candy.at(column, 1)], Object.keys(Candy.WEIGHTS.base)[0]);
    for (let row = 2; row < Candy.ROWS; row++) assert.equal(next[Candy.at(column, row)], start[Candy.at(column, row)]);
  }
  // Columns with no winner don't move.
  for (let column = 4; column < Candy.COLUMNS; column++) {
    for (let row = 0; row < Candy.ROWS; row++) assert.equal(next[Candy.at(column, row)], start[Candy.at(column, row)]);
  }
});

test("a spin tumbles until the board has no win, and pays every tumble", () => {
  const draw = seeded(5);
  for (let i = 0; i < 2000; i++) {
    const spin = Candy.spinOnce(false, draw);
    const last = spin.steps[spin.steps.length - 1];
    assert.deepEqual(last.wins, [], "the last board has no win");
    for (const step of spin.steps.slice(0, -1)) assert.ok(step.wins.length > 0, "every board before it has one");
    const tumbles = spin.steps.reduce((sum, step) => sum + step.wins.reduce((s, w) => s + w.pay, 0), 0);
    assert.equal(spin.tumbleWin, tumbles);
    assert.equal(spin.multiplier, 1, "no multipliers in a paid spin");
    assert.ok(last.board.every((cell) => !cell.startsWith("X")), "no multiplier candies in a paid spin");
    assert.equal(spin.win, spin.tumbleWin + spin.scatterPay);
  }
});

test("lollipops pay 3, 5 and 100 times the bet and give free spins", () => {
  assert.equal(Candy.scatterPayFor(3), 0);
  assert.equal(Candy.scatterPayFor(4), 300);
  assert.equal(Candy.scatterPayFor(5), 500);
  assert.equal(Candy.scatterPayFor(6), 10000);
  assert.equal(Candy.scatterPayFor(9), 10000);
  // 4 lollipops on a board with nothing else winning: 3× and 10 free spins; in a free spin 3 give 5 more.
  const quiet = quietBoard().map((cell) => (cell === "HEART" ? "MOON" : cell));
  const four = quiet.slice();
  for (const i of [0, 7, 14, 21]) four[i] = "LOLLIPOP";
  const paid = Candy.spinOnce(false, () => 0, four);
  assert.equal(paid.scatters, 4);
  assert.equal(paid.scatterPay, 300);
  assert.equal(paid.freeSpinsWon, 10);
  const three = quiet.slice();
  for (const i of [0, 7, 14]) three[i] = "LOLLIPOP";
  assert.equal(Candy.spinOnce(false, () => 0, three).freeSpinsWon, 0);
  assert.equal(Candy.spinOnce(true, () => 0, three).freeSpinsWon, 5);
});

test("in a free spin the multipliers on the board add up and multiply a win, and only a win", () => {
  // 8 grapes (pay 0.4×) plus a 5× and a 10× candy, the rest quiet.
  const quiet = quietBoard().map((cell) => (cell === "GRAPE" ? "MOON" : cell));
  const winning = quiet.slice();
  for (let column = 0; column < 4; column++) {
    winning[Candy.at(column, 0)] = "GRAPE";
    winning[Candy.at(column, 1)] = "GRAPE";
  }
  winning[Candy.at(5, 4)] = "X5";
  winning[Candy.at(4, 4)] = "X10";
  // The draw always picks the first entry: new candies are hearts, 8 of them across columns 0–3 — so a second tumble wins too.
  const spin = Candy.spinOnce(true, () => 0, winning);
  assert.ok(spin.tumbleWin > 0);
  const onBoard = spin.steps[spin.steps.length - 1].board.reduce((sum, cell) => sum + Candy.multiplierOf(cell), 0);
  assert.ok(onBoard >= 15);
  assert.equal(spin.multiplier, onBoard);
  assert.equal(spin.win, spin.tumbleWin * spin.multiplier + spin.scatterPay);
  // No win: the multipliers don't pay anything on their own.
  const nothing = quiet.slice();
  nothing[0] = "X100";
  const none = Candy.spinOnce(true, () => 0, nothing);
  if (none.tumbleWin === 0) {
    assert.equal(none.multiplier, 1);
    assert.equal(none.win, none.scatterPay);
  }
});

test("a round never pays more than 5000× the bet, and plays every free spin it gives", () => {
  const draw = seeded(77);
  let features = 0;
  for (let i = 0; i < 30000; i++) {
    const round = Candy.play(draw);
    assert.ok(round.win <= Candy.MAX_WIN * 100);
    assert.equal(round.spins[0].free, false);
    const given = round.spins.reduce((sum, spin) => sum + spin.freeSpinsWon, 0);
    if (round.spins.length > 1) {
      features++;
      assert.ok(round.spins.slice(1).every((spin) => spin.free));
      // Every free spin given is played, unless the cap or the most free spins cut them short.
      if (!round.capped) assert.equal(round.spins.length - 1, Math.min(given, Candy.MAX_FREE_SPINS));
    } else assert.equal(given, 0);
    const total = round.spins.reduce((sum, spin) => sum + spin.win, 0);
    assert.equal(round.win, Math.min(total, Candy.MAX_WIN * 100));
  }
  assert.ok(features > 30, `free spins came ${features} times`);
});

test("what a round pays is rounded down to the cent, and the record is in times the bet", () => {
  assert.equal(Candy.winCents(5000, 125), 6250);
  assert.equal(Candy.winCents(5000, 33), 1650);
  assert.equal(Candy.winCents(333, 25), 83);
  const round = Candy.play(seeded(3));
  const rec = Candy.record(round);
  assert.equal(rec.win, round.win / 100);
  assert.equal(rec.freeSpins, round.spins.length - 1);
  assert.equal(rec.spins[0].steps[0].board.length, Candy.CELLS);
});

test("it pays back about 84.7% over many rounds", () => {
  const draw = seeded(2026);
  const rounds = 400_000;
  let paid = 0;
  let squares = 0;
  for (let i = 0; i < rounds; i++) {
    const x = Candy.play(draw).win / 100;
    paid += x;
    squares += x * x;
  }
  const mean = paid / rounds;
  const se = Math.sqrt((squares / rounds - mean * mean) / rounds);
  // Within four standard errors of the stated rate (scripts/candy-rtp.mjs measures it over 20 million rounds).
  assert.ok(Math.abs(mean - Candy.PAYOUT_RATE / 100) < 4 * se, `measured ${(mean * 100).toFixed(2)}% ± ${(se * 100).toFixed(2)}%`);
});

test("the special bets and bought free spins: what they cost, and how they play", () => {
  assert.deepEqual(Candy.COST, { NORMAL: 1, ANTE1: 2.5, ANTE2: 12, SPINS1: 20, SPINS2: 250, BUY: 100, SUPER1: 500, SUPER2: 1000 });
  assert.equal(Candy.costCents(5000, "ANTE1"), 12500);
  assert.equal(Candy.costCents(5000, "SPINS2"), 1250000);
  // The purchases and the special bets that cost 10 times the bet or more are held to MAX_BUY_BET.
  assert.deepEqual(Candy.MODES.filter(Candy.isLimitedMode), ["ANTE2", "SPINS1", "SPINS2", "BUY", "SUPER1", "SUPER2"]);
  assert.equal(Candy.costCents(5000, "BUY"), 500000);
  assert.equal(Candy.costCents(5000, "SUPER1"), 2500000);
  assert.equal(Candy.costCents(5000, "SUPER2"), 5000000);
  const draw = seeded(9);
  for (let i = 0; i < 300; i++) {
    const bought = Candy.play(draw, "BUY");
    assert.equal(bought.bought, 10);
    assert.ok(bought.spins.length >= 10 && bought.spins.every((spin) => spin.free));
    // Its opening board, only a picture: four lollipops in four different columns, and no win on it.
    const intro = bought.intro;
    const lollipops = intro.flatMap((cell, index) => (cell === "LOLLIPOP" ? [Math.floor(index / Candy.ROWS)] : []));
    assert.equal(intro.length, Candy.CELLS);
    assert.equal(new Set(lollipops).size, 4);
    assert.deepEqual(Candy.winsOn(intro), []);
    assert.ok(intro.every((cell) => cell === "LOLLIPOP" || Candy.PAYING.includes(cell)));
    // Super free spins 1's multiplier candies are never below 20x, super free spins 2's never below 10x.
    for (const [mode, min] of [["SUPER1", 20], ["SUPER2", 10]]) {
      const superRound = Candy.play(draw, mode);
      assert.equal(superRound.bought, 10);
      for (const spin of superRound.spins) for (const step of spin.steps) for (const cell of step.board) if (cell.startsWith("X")) assert.ok(Number(cell.slice(1)) >= min);
    }
    for (const mode of ["ANTE1", "ANTE2"]) {
      const ante = Candy.play(draw, mode);
      assert.equal(ante.spins.some((spin) => spin.total !== undefined), false);
      assert.equal(ante.bought, 0);
      assert.equal(ante.intro, undefined);
      assert.equal(ante.spins[0].free, false);
      assert.equal(ante.spins[0].multiplier, 1, "a paid ante spin isn't multiplied");
      // Ante bet 2's free spins are super free spins 1: no multiplier candy below 20x.
      if (mode === "ANTE2") for (const spin of ante.spins.slice(1)) for (const step of spin.steps) for (const cell of step.board) if (cell.startsWith("X")) assert.ok(Number(cell.slice(1)) >= 20);
    }
  }
});

test("super spins: no lollipops, a multiplier candy every spin (25x or more in super spins 2), and a win is multiplied", () => {
  const draw = seeded(21);
  let multiplied = 0;
  for (const [mode, min] of [["SPINS1", 5], ["SPINS2", 25]]) {
    for (let i = 0; i < 1500; i++) {
      const round = Candy.play(draw, mode);
      assert.equal(round.spins.length, 1, "no free spins");
      const [spin] = round.spins;
      assert.equal(spin.free, false);
      assert.equal(spin.scatters, 0);
      assert.ok(spin.steps[0].board.some((cell) => cell.startsWith("X")), "the first board has a multiplier candy");
      for (const step of spin.steps) for (const cell of step.board) {
        assert.notEqual(cell, "LOLLIPOP");
        if (cell.startsWith("X")) assert.ok(Number(cell.slice(1)) >= min);
      }
      const sum = spin.steps[spin.steps.length - 1].board.reduce((total, cell) => total + (cell.startsWith("X") ? Number(cell.slice(1)) : 0), 0);
      assert.ok(sum > 0, "multiplier candies don't burst, so one is still there at the end");
      assert.equal(spin.multiplier, spin.tumbleWin > 0 ? sum : 1);
      assert.equal(spin.win, spin.tumbleWin * spin.multiplier);
      if (spin.multiplier > 1) multiplied++;
    }
  }
  assert.ok(multiplied > 1000);
});

test("every way to play pays back about the same, near 85% of what it costs", () => {
  for (const [mode, rounds, seed] of [["ANTE1", 300_000, 11], ["ANTE2", 300_000, 15], ["SPINS1", 60_000, 16], ["SPINS2", 40_000, 17], ["BUY", 30_000, 12], ["SUPER1", 25_000, 13], ["SUPER2", 25_000, 14]]) {
    const draw = seeded(seed);
    let paid = 0;
    let squares = 0;
    for (let i = 0; i < rounds; i++) {
      const x = Candy.play(draw, mode).win / 100 / Candy.COST[mode];
      paid += x;
      squares += x * x;
    }
    const mean = paid / rounds;
    const se = Math.sqrt((squares / rounds - mean * mean) / rounds);
    // Within four standard errors of the normal spin's stated rate (scripts/candy-rtp.mjs measures each closely).
    assert.ok(Math.abs(mean - Candy.PAYOUT_RATE / 100) < 4 * se + 0.01, `${mode}: measured ${(mean * 100).toFixed(2)}% ± ${(se * 100).toFixed(2)}%`);
  }
});


test("super free spins 2: a winning spin's multipliers join a total that stays and multiplies every win after", () => {
  const draw = seeded(31);
  let grew = 0;
  for (let i = 0; i < 400; i++) {
    const round = Candy.play(draw, "SUPER2");
    let total = 0;
    for (const spin of round.spins) {
      const own = spin.steps[spin.steps.length - 1].board.reduce((sum, cell) => sum + (cell.startsWith("X") ? Number(cell.slice(1)) : 0), 0);
      const expected = total + (spin.tumbleWin > 0 ? own : 0);
      assert.equal(spin.total, expected);
      if (spin.tumbleWin > 0 && expected > 0) assert.equal(spin.multiplier, expected);
      else assert.equal(spin.multiplier, 1);
      assert.equal(spin.win, spin.tumbleWin * spin.multiplier + spin.scatterPay);
      if (expected > total && total > 0) grew++;
      total = expected;
    }
  }
  // The total does carry over and grow.
  assert.ok(grew > 0);
});
