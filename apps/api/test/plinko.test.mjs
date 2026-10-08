// Run with `npm test --workspace apps/api` (builds first). Plinko's rules:
// the boards, every pay table, the ball's path, and the payout rate, worked
// out exactly from the chance of every bucket rather than by sampling.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BETS, MAX_MULTIPLIER, PAYOUT_RATE, PAY_TABLES, RISKS, ROWS, bucketChances, dropBall, isRisk, isRows, payTable, payoutRate, winCents } = require("../dist/casino/plinko.js");

test("every board has a bucket more than its rows, mirrored, highest at the edges", () => {
  for (const rows of ROWS) {
    for (const risk of RISKS) {
      const table = payTable(rows, risk);
      assert.equal(table.length, rows + 1, `${rows} ${risk}`);
      assert.deepEqual(table, [...table].reverse(), `${rows} ${risk} is mirrored`);
      for (let bucket = 1; bucket <= rows / 2; bucket += 1) assert.ok(table[bucket] <= table[bucket - 1], `${rows} ${risk} falls towards the middle`);
      assert.ok(table.every((value) => value > 0 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9), `${rows} ${risk} pays in tenths`);
      assert.deepEqual(PAY_TABLES[rows][risk], table);
    }
    // More risk pays more at the edge and less in the middle.
    assert.ok(payTable(rows, "LOW")[0] < payTable(rows, "MEDIUM")[0] && payTable(rows, "MEDIUM")[0] < payTable(rows, "HIGH")[0]);
    assert.ok(payTable(rows, "LOW")[rows / 2] > payTable(rows, "HIGH")[rows / 2]);
  }
  assert.equal(MAX_MULTIPLIER, 1000);
  assert.equal(payTable(16, "HIGH")[0], 1000);
});

test("the buckets' chances add up to 1 and follow the binomial", () => {
  for (const rows of ROWS) {
    const chances = bucketChances(rows);
    assert.equal(chances.length, rows + 1);
    assert.ok(Math.abs(chances.reduce((sum, chance) => sum + chance, 0) - 1) < 1e-12);
  }
  assert.deepEqual(bucketChances(8).map((chance) => chance * 256), [1, 8, 28, 56, 70, 56, 28, 8, 1]);
});

test(`every board pays back ${PAYOUT_RATE}% on average, within 0.2%`, () => {
  for (const rows of ROWS) {
    for (const risk of RISKS) {
      const rate = payoutRate(rows, risk);
      assert.ok(rate >= PAYOUT_RATE - 0.2 && rate <= PAYOUT_RATE + 0.2, `${rows} rows ${risk}: ${rate}%`);
    }
  }
  assert.equal(payoutRate(16, "LOW"), 97);
});

test("the ball's bucket is how many times it went right", () => {
  const rights = [1, 1, 0, 1, 0, 0, 1, 1];
  let i = 0;
  const ball = dropBall(8, "HIGH", () => rights[i++]);
  assert.deepEqual(ball, { path: rights, bucket: 5, multiplier: 0.3 });
  assert.deepEqual(dropBall(16, "HIGH", () => 0), { path: Array(16).fill(0), bucket: 0, multiplier: 1000 });
  assert.deepEqual(dropBall(12, "LOW", () => 1).bucket, 12);
  assert.throws(() => dropBall(8, "LOW", () => 2), /off the board/);
});

test("a real ball goes both ways about evenly", () => {
  let rights = 0;
  for (let i = 0; i < 2000; i += 1) rights += dropBall(16, "LOW").bucket;
  const share = rights / (2000 * 16);
  assert.ok(share > 0.47 && share < 0.53, `${share}`);
});

test("pays come out in whole cents for every stake", () => {
  assert.equal(winCents(20, 0.3), 6);
  assert.equal(winCents(50, 13.4), 670);
  assert.equal(winCents(1000, 1000), 1_000_000);
  assert.equal(winCents(100, 1.1), 110);
  for (const bet of BETS) {
    const cents = Math.round(bet * 100);
    for (const rows of ROWS) for (const risk of RISKS) for (const multiplier of payTable(rows, risk)) assert.equal(winCents(cents, multiplier), Math.round(cents * multiplier), `${bet} × ${multiplier}`);
  }
});

test("only real boards and risks are accepted", () => {
  assert.ok(isRows(8) && isRows(16) && !isRows(10) && !isRows("8"));
  assert.ok(isRisk("MEDIUM") && !isRisk("medium") && !isRisk("EXTREME"));
});
