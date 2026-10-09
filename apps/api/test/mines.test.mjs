// Run with `npm test --workspace apps/api` (builds first). Mines' rules:
// where the mines go, what each safe tile pays, and that a cash-out at any
// point returns 97% before the cents are floored.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BETS, MAX_WIN, MINE_COUNTS, TILES, cashOut, multiplierHundredths, payoutCents, placeMines, publicView, reveal, startRound } = require("../dist/casino/mines.js");

/** A draw that always picks the next index we name, so the mines land where the test says. */
const draws = (...picks) => {
  let step = 0;
  return () => picks[step++] ?? 0;
};

const ways = (tiles, opened, safe) => {
  let chance = 1;
  for (let step = 0; step < opened; step++) chance *= (safe - step) / (tiles - step);
  return chance;
};

test("the field, the mine counts and the bets are what the rules say", () => {
  assert.equal(TILES, 25);
  assert.deepEqual([...MINE_COUNTS], [1, 3, 5, 10, 15, 20, 24]);
  assert.deepEqual([...BETS], [50, 100, 250, 500, 1000, 2500]);
  assert.equal(MAX_WIN, 5000);
});

test("mines are a shuffle of distinct tiles", () => {
  const mines = placeMines(5, draws(0, 1, 2, 3, 4));
  assert.equal(mines.length, 5);
  assert.equal(new Set(mines).size, 5);
  assert.ok(mines.every((tile) => tile >= 0 && tile < TILES));
  assert.deepEqual(placeMines(3, draws(0, 0, 0)), placeMines(3, draws(0, 0, 0)));
});

test("the first safe tile with 3 mines pays 1.10, and 24 mines pays 24.25", () => {
  assert.equal(multiplierHundredths(3, 1), 110);
  assert.equal(payoutCents(100, 3, 1), 110);
  assert.equal(multiplierHundredths(24, 1), 2425);
  assert.equal(payoutCents(100, 24, 1), 2425);
  assert.equal(payoutCents(50, 3, 1), 55);
});

test("the multiplier only rises, and it stops at 5,000 times the bet", () => {
  let previous = 100;
  for (let opened = 1; opened <= 5; opened++) {
    const next = multiplierHundredths(20, opened);
    assert.ok(next >= previous);
    previous = next;
  }
  assert.equal(multiplierHundredths(20, 5), MAX_WIN * 100);
  assert.equal(payoutCents(1000, 20, 5), 1000 * MAX_WIN);
});

test("cashing out after any number of tiles pays back 97% before the cents are floored", () => {
  for (const mines of [1, 3, 10]) {
    const safe = TILES - mines;
    for (let opened = 1; opened <= Math.min(safe, 4); opened++) {
      const paid = payoutCents(10_000, mines, opened);
      const back = ways(TILES, opened, safe) * paid;
      const target = 0.97 * 10_000;
      assert.ok(back <= target + 1, `${mines} mines, ${opened} tiles pays ${back} against ${target}`);
      assert.ok(target - back < 100, `${mines} mines, ${opened} tiles floors by less than a dollar on a $100 stake`);
    }
  }
});

test("a mine loses the stake, and the board stays secret until the round ends", () => {
  const round = startRound(100, 3, draws(4, 4, 4));
  const hidden = publicView(round);
  assert.equal(hidden.tiles.every((tile) => tile === "hidden"), true);
  assert.equal(hidden.cashout, 0);

  const safe = reveal(round, 0);
  assert.equal(safe.phase, "PLAY");
  assert.deepEqual(publicView(safe).tiles.filter((tile) => tile === "gem"), ["gem"]);
  assert.equal(publicView(safe).tiles.includes("mine"), false);

  const lost = reveal(safe, round.mineTiles[0]);
  assert.equal(lost.phase, "LOST");
  assert.equal(lost.payout, 0);
  const shown = publicView(lost);
  assert.equal(shown.tiles[round.mineTiles[0]], "hit");
  assert.equal(shown.tiles.filter((tile) => tile === "mine").length, 2);
  assert.equal(shown.cashout, 0);
});

test("cashing out pays the open tiles, and clearing the board pays the last one", () => {
  const round = startRound(200, 3, draws(0, 0, 0));
  assert.throws(() => cashOut(round), /Open a tile before you cash out/);
  const open = reveal(round, 5);
  assert.equal(open.phase, "PLAY");
  const won = cashOut(open);
  assert.equal(won.phase, "WON");
  assert.equal(won.payout, payoutCents(200, 3, 1));
  assert.equal(publicView(won).tiles.filter((tile) => tile === "mine").length, 3);

  const last = startRound(200, 24, draws(0));
  const cleared = reveal(last, 24);
  assert.equal(cleared.phase, "WON");
  assert.equal(cleared.capped, false);
  assert.equal(cleared.payout, payoutCents(200, 24, 1));
  assert.equal(publicView(cleared).tiles.filter((tile) => tile === "mine").length, 24);

  const few = startRound(100, 1, () => 0);
  let playing = few;
  for (let tile = 1; tile < TILES; tile++) playing = playing.phase === "PLAY" ? reveal(playing, tile) : playing;
  assert.equal(playing.phase, "WON");
  assert.equal(playing.revealed.length, TILES - 1);
  assert.equal(playing.payout, payoutCents(100, 1, TILES - 1));
});

test("a tile can't be opened twice, and a finished round stays finished", () => {
  const round = startRound(100, 3, draws(2, 2, 2));
  const once = reveal(round, 0);
  assert.throws(() => reveal(once, 0), /already open/);
  const won = cashOut(once);
  assert.throws(() => reveal(won, 1), /already over/);
  assert.throws(() => cashOut(won), /already over/);
});
