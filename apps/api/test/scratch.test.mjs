// Run with `npm test --workspace apps/api` (builds first). Scratch Cards'
// rules: the prizes pay back exactly 90%, a card wins only when a symbol
// shows three times, and the card is fair and comes from the seeds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BETS, CELLS, MAX_MULTIPLIER, ODDS_OUT_OF, PRIZES, SYMBOLS, cardFor, payoutRate, winCents, winChance } = require("../dist/casino/scratch.js");

const countsOf = (cells) => cells.reduce((map, symbol) => map.set(symbol, (map.get(symbol) ?? 0) + 1), new Map());

test("the prizes, the bets and the odds are what the rules say", () => {
  assert.deepEqual([...BETS], [50, 100, 250, 500, 1000, 2500]);
  assert.equal(CELLS, 9);
  assert.deepEqual(PRIZES.map((prize) => prize.multiplier), [1, 2, 5, 10, 25, 100, 500, 1000]);
  assert.equal(new Set(PRIZES.map((prize) => prize.symbol)).size, PRIZES.length, "one prize per symbol");
  assert.ok(PRIZES.every((prize) => SYMBOLS.includes(prize.symbol)));
  assert.equal(MAX_MULTIPLIER, 1000);
  assert.equal(payoutRate(), 90, "exactly 90% back on average");
  assert.ok(Math.abs(winChance() - 35.608) < 1e-9);
  assert.ok(PRIZES.reduce((sum, prize) => sum + prize.odds, 0) < ODDS_OUT_OF);
  assert.equal(winCents(10_000, 5), 50_000);
  assert.equal(winCents(250_000, 1000), 250_000_000, "2,500 ALL on the crown pays 2,500,000 ALL");
});

test("a card wins only with three of one symbol, and pays that symbol's prize; the same seeds give the same card", () => {
  for (let nonce = 0; nonce < 3000; nonce++) {
    const card = cardFor("server-seed", "client", nonce);
    assert.equal(card.cells.length, CELLS);
    assert.ok(card.cells.every((symbol) => SYMBOLS.includes(symbol)));
    const triples = [...countsOf(card.cells)].filter(([, count]) => count >= 3);
    assert.ok([...countsOf(card.cells).values()].every((count) => count <= 3), "never more than three of a symbol");
    if (card.symbol === null) {
      assert.deepEqual(triples, [], `card ${nonce} has no three of a kind`);
      assert.equal(card.multiplier, 0);
    } else {
      assert.deepEqual(triples, [[card.symbol, 3]], `card ${nonce} has exactly one three of a kind`);
      assert.equal(card.multiplier, PRIZES.find((prize) => prize.symbol === card.symbol).multiplier);
    }
  }
  assert.deepEqual(cardFor("server-seed", "client", 7), cardFor("server-seed", "client", 7));
  assert.notDeepEqual(cardFor("server-seed", "client", 7).cells, cardFor("server-seed", "other", 7).cells);
});

test("the small prizes come up as often as their odds say", () => {
  const cards = 100_000;
  const wins = new Map();
  for (let nonce = 0; nonce < cards; nonce++) {
    const { symbol } = cardFor("fairness", "check", nonce);
    if (symbol) wins.set(symbol, (wins.get(symbol) ?? 0) + 1);
  }
  for (const prize of PRIZES.filter((prize) => prize.odds >= 12_500)) {
    const expected = (prize.odds / ODDS_OUT_OF) * cards;
    const spread = 5 * Math.sqrt(expected);
    assert.ok(Math.abs((wins.get(prize.symbol) ?? 0) - expected) < spread, `${prize.symbol}: ${wins.get(prize.symbol)} wins, about ${expected} expected`);
  }
});
