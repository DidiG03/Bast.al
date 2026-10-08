// Run with `npm test --workspace apps/api` (builds first). System bets
// (src/bets/system.ts): the lines each system makes, their names, the most
// they can return, and what they pay from their picks' results, checked
// against working every line out by hand.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Prisma } = require("@prisma/client");
const { combinations, normalSizes, systemLines, systemMaxReturn, systemName, systemOutcome } = require("../dist/bets/system.js");

const D = (value) => new Prisma.Decimal(value);
const legs = (results, odds = [2, 3, 1.5, 4]) => results.map((result, i) => ({ odds: D(odds[i]), result }));

test("each system makes the right lines", () => {
  assert.equal(combinations(4, 2).length, 6);
  assert.deepEqual(combinations(3, 2), [[0, 1], [0, 2], [1, 2]]);
  const count = (picks, sizes) => systemLines(picks, sizes).length;
  assert.equal(count(3, [2, 3]), 4, "Trixie");
  assert.equal(count(3, [1, 2, 3]), 7, "Patent");
  assert.equal(count(4, [2, 3, 4]), 11, "Yankee");
  assert.equal(count(4, [1, 2, 3, 4]), 15, "Lucky 15");
  assert.equal(count(5, [2, 3, 4, 5]), 26, "Super Yankee");
  assert.equal(count(6, [2, 3, 4, 5, 6]), 57, "Heinz");
  assert.equal(count(8, [2, 3, 4, 5, 6, 7, 8]), 247, "Goliath");
  assert.equal(count(5, [3]), 10, "3 from 5");
});

test("systems are named, and sets that aren't systems are refused", () => {
  assert.equal(systemName(4, [2, 3, 4]), "Yankee");
  assert.equal(systemName(4, [1, 2, 3, 4]), "Lucky 15");
  assert.equal(systemName(4, [2]), "2 from 4");
  assert.equal(systemName(5, [2, 3]), "2/3 from 5");
  assert.deepEqual(normalSizes(4, [4, 2, 3, 2]), [2, 3, 4]);
  assert.equal(normalSizes(4, [4]), null, "just the accumulator");
  assert.equal(normalSizes(4, [1]), null, "just the singles");
  assert.equal(normalSizes(3, [2, 4]), null, "4 from 3");
  assert.equal(normalSizes(3, []), null);
});

test("a Yankee: the most it returns is every line at its price", () => {
  const odds = [2, 3, 1.5, 4].map(D);
  const { payout, topOdds } = systemMaxReturn(odds, [2, 3, 4], D(1));
  // By hand: doubles 6+3+8+4.5+12+6 = 39.5, trebles 9+24+12+18 = 63, fourfold 36.
  assert.equal(Number(payout), 138.5);
  assert.equal(Number(topOdds), 36);
});

test("a lost pick only loses its lines, and a void pick counts as 1.00", () => {
  const yankee = [2, 3, 4];
  // The 4.00 pick lost: only the lines without it pay. Doubles 6+3+4.5 = 13.5, treble 9.
  assert.deepEqual(
    (({ status, payout, won, lines }) => ({ status, payout: Number(payout), won, lines }))(systemOutcome(legs(["WON", "WON", "WON", "LOST"]), yankee, D(1))),
    { status: "WON", payout: 22.5, won: 4, lines: 11 },
  );
  // The 3.00 pick void: it counts 1.00. Doubles 2+3+8+1.5+4+6 = 24.5, trebles 3+8+12+6 = 29, fourfold 12.
  assert.equal(Number(systemOutcome(legs(["WON", "VOID", "WON", "WON"]), yankee, D(1)).payout), 65.5);
  // Two picks lost: no double, treble or fourfold is left.
  assert.deepEqual(systemOutcome(legs(["LOST", "LOST", "WON", "WON"]), [3, 4], D(1)).status, "LOST");
  // A Lucky 15's singles still pay with one winner.
  assert.equal(Number(systemOutcome(legs(["LOST", "LOST", "LOST", "WON"]), [1, 2, 3, 4], D(2)).payout), 8);
});

test("open until every pick is decided, unless every line has already lost; void when every pick is", () => {
  assert.equal(systemOutcome(legs(["WON", null, "WON", "WON"]), [2, 3, 4], D(1)).status, "OPEN");
  assert.equal(systemOutcome(legs(["LOST", "LOST", null, "WON"]), [3, 4], D(1)).status, "LOST", "no line can win now");
  const voided = systemOutcome(legs(["VOID", "VOID", "VOID", "VOID"]), [2, 3, 4], D(2));
  assert.deepEqual([voided.status, Number(voided.payout)], ["VOID", 22]);
});
