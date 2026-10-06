// Run with `npm test --workspace apps/api` (builds first). Book of Ra's
// rules: line wins with the book standing in, books anywhere, the special
// symbol expanding over reels that needn't be next to each other, and the
// reels themselves. The payout rate is measured by scripts/book-rtp.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BOOK, FREE_SPINS, LINES, LINE_SHAPES, MAX_WIN, PAYING, REEL_STRIPS, drawSpecial, evaluate, expand, land, minToPay, roomLeft, spin } from "../dist/casino/book.js";

/** A grid from five columns written top to bottom: "E" explorer, "B" book, "A" ace and so on. */
const CODES = { E: "EXPLORER", P: "PHARAOH", S: "STATUE", C: "SCARAB", A: "ACE", K: "KING", Q: "QUEEN", J: "JACK", T: "TEN", B: "BOOK" };
const grid = (...columns) => columns.map((column) => [...column].map((code) => CODES[code]));

test("a line pays from the first reel, with books standing in for its symbol", () => {
  // Middle row: Explorer, Book, Explorer, Ace, ...: 3 explorers.
  const result = evaluate(grid("QEK", "JBT", "QEK", "JAT", "QKT"));
  const middle = result.lines.find((line) => line.line === 0);
  assert.deepEqual([middle.symbol, middle.count, middle.win], ["EXPLORER", 3, 100]);
  assert.deepEqual(middle.cells, [[0, 1], [1, 1], [2, 1]]);
});

test("high symbols pay from 2, the cards from 3; a line of books alone doesn't pay as a line", () => {
  assert.equal(evaluate(grid("QPK", "JPT", "QAK", "JKT", "QKT")).lines.find((l) => l.line === 0).win, 5, "2 pharaohs");
  assert.equal(evaluate(grid("QAK", "JAT", "QKK", "JQT", "QJT")).lines.find((l) => l.line === 0), undefined, "2 aces don't pay");
  const books = evaluate(grid("QBK", "JBT", "QBK", "JBT", "QBT"));
  assert.equal(books.lines.find((l) => l.line === 0), undefined);
  assert.deepEqual([books.scatter.count, books.scatter.win, books.freeSpinsWon], [5, 200 * LINES, FREE_SPINS], "5 books: 200 times the bet");
});

test("3 books anywhere pay twice the bet and give 10 free spins", () => {
  const result = evaluate(grid("BQK", "JTA", "QKB", "JAT", "BKT"));
  assert.deepEqual([result.scatter.count, result.scatter.win, result.freeSpinsWon], [3, 2 * LINES, 10]);
  assert.equal(evaluate(grid("BQK", "JTA", "QKB", "JAT", "QKT")).freeSpinsWon, 0, "2 books: nothing");
});

test("in a free spin the special symbol fills its reels, which needn't be next to each other, and pays on every line", () => {
  // Explorers on reels 1, 3 and 5 only: no line win, but 3 reels of explorer expanded pay 100 on each of the 10 lines.
  const g = grid("QEK", "JAT", "KQE", "JAT", "EKT");
  assert.equal(evaluate(g).win, 0, "not a free spin: nothing");
  const result = evaluate(g, "EXPLORER");
  assert.deepEqual(result.expansion, { symbol: "EXPLORER", reels: [0, 2, 4], perLine: 100, win: 100 * LINES });
  assert.equal(result.win, 1000);
  // Pharaoh pays from 2 reels, the ace needs 3.
  assert.equal(expand(grid("PQK", "JAT", "KQA", "JAT", "PKT"), "PHARAOH").win, 5 * LINES);
  assert.equal(expand(grid("AQK", "JPT", "KQJ", "JPT", "AKT"), "ACE"), null);
  assert.deepEqual([minToPay("EXPLORER"), minToPay("SCARAB"), minToPay("KING"), minToPay("TEN")], [2, 2, 3, 3]);
});

test("the expansion pays on top of the line wins, and books don't count as the special symbol", () => {
  // Middle row: 3 kings on the line (5), and kings on reels 1-3 expanded (5 x 10 lines).
  const result = evaluate(grid("QKA", "JKT", "QKA", "JAT", "QQT"), "KING");
  assert.equal(result.lines.find((l) => l.line === 0).win, 5);
  assert.deepEqual(result.expansion.reels, [0, 1, 2]);
  assert.equal(result.win, 5 + 50 + result.lines.filter((l) => l.line !== 0).reduce((s, l) => s + l.win, 0));
  assert.equal(expand(grid("QKA", "JBT", "QKA", "JAT", "QQT"), "KING"), null, "the book on reel 2 doesn't make it 3 reels");
});

test("the reels land where the draw says, and the special symbol is never the book", () => {
  const { grid: landed, stops } = land(() => 0);
  assert.deepEqual(stops, [0, 0, 0, 0, 0]);
  assert.deepEqual(landed[0], REEL_STRIPS[0].slice(0, 3));
  assert.throws(() => land(() => 999), /out of range/);
  const drawn = new Set(Array.from({ length: PAYING.length }, (_, i) => drawSpecial(() => i)));
  assert.equal(drawn.size, PAYING.length);
  assert.ok(!drawn.has(BOOK));
  assert.equal(LINE_SHAPES.length, LINES);
  assert.equal(spin(null, () => 0).stops.length, 5);
});

test("the cap: never more than 5,000 times the bet for a round", () => {
  assert.equal(roomLeft(0), MAX_WIN * LINES);
  assert.equal(roomLeft(MAX_WIN * LINES - 7), 7);
  assert.equal(roomLeft(MAX_WIN * LINES + 100), 0);
});
