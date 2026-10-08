// Run with `npm test --workspace apps/api` (builds first). Dice's rules: the
// winning numbers for every target, the multipliers and the payout rate
// worked out exactly over all 10,000 rolls, and the provably fair roll.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MAX_WINNING, MIN_WINNING, OUTCOMES, PAYOUT_RATE, hashSeed, invalidTarget, isClientSeed, label, multiplierOf, multiplierUnits, newClientSeed, newServerSeed, rollFor, targetUnits, winCents, winningNumbers, wins } = require("../dist/casino/dice.js");

test("under wins below the target, over above it, and the counts match", () => {
  assert.equal(winningNumbers(5000, "UNDER"), 5000);
  assert.equal(winningNumbers(5000, "OVER"), 4999);
  assert.ok(wins(4999, 5000, "UNDER") && !wins(5000, 5000, "UNDER"));
  assert.ok(wins(5001, 5000, "OVER") && !wins(5000, 5000, "OVER"));
  for (const direction of ["UNDER", "OVER"]) {
    for (const target of [100, 2500, 4999, 5000, 9500]) {
      let count = 0;
      for (let roll = 0; roll < OUTCOMES; roll += 1) if (wins(roll, target, direction)) count += 1;
      assert.equal(count, winningNumbers(target, direction), `${direction} ${target}`);
    }
  }
});

test(`every target pays back at most ${PAYOUT_RATE}%, and within a hair of it`, () => {
  for (let winning = MIN_WINNING; winning <= MAX_WINNING; winning += 1) {
    const rate = (winning / OUTCOMES) * multiplierOf(winning) * 100;
    assert.ok(rate <= PAYOUT_RATE + 1e-9 && rate > PAYOUT_RATE - 0.01, `${winning}: ${rate}`);
  }
  assert.equal(multiplierOf(5000), 1.94);
  assert.equal(multiplierOf(100), 97);
  assert.equal(multiplierOf(9500), 1.021);
  assert.equal(multiplierUnits(3333), 29102);
});

test("wins are paid in whole cents, rounded down", () => {
  assert.equal(winCents(100, 5000), 194);
  assert.equal(winCents(5000, 100), 485_000);
  assert.equal(winCents(10, 3333), 29);
  assert.equal(winCents(137, 3333), 398);
});

test("targets are whole hundredths, and win 1% to 95% of the time", () => {
  assert.equal(targetUnits(50.5), 5050);
  assert.equal(targetUnits(49.99), 4999);
  assert.equal(targetUnits(50.555), null);
  assert.equal(invalidTarget(5000, "OVER"), null);
  assert.equal(invalidTarget(100, "UNDER"), null);
  assert.match(invalidTarget(99, "UNDER"), /1% to 95%/);
  assert.match(invalidTarget(9501, "UNDER"), /1% to 95%/);
  assert.equal(invalidTarget(9899, "OVER"), null);
  assert.match(invalidTarget(9900, "OVER"), /1% to 95%/);
  assert.match(invalidTarget(10000, "OVER"), /0\.00 to 99\.99/);
});

test("a roll is the published HMAC-SHA256 formula, the same every time", () => {
  const serverSeed = "a3f1c0ffee";
  const expected = (clientSeed, nonce) => {
    const bytes = createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}`).digest();
    return Math.floor(((bytes[0] * 256 ** 3 + bytes[1] * 256 ** 2 + bytes[2] * 256 + bytes[3]) / 256 ** 4) * 10000);
  };
  for (let nonce = 0; nonce < 50; nonce += 1) assert.equal(rollFor(serverSeed, "lucky", nonce), expected("lucky", nonce));
  assert.notEqual(rollFor(serverSeed, "lucky", 0), rollFor(serverSeed, "lucky", 1));
  assert.equal(hashSeed(serverSeed), createHash("sha256").update(serverSeed).digest("hex"));
  assert.equal(label(4273), "42.73");
  assert.equal(label(5), "0.05");
});

test("rolls spread evenly over 0.00 to 99.99", () => {
  const seed = newServerSeed();
  assert.match(seed, /^[0-9a-f]{64}$/);
  const buckets = Array(10).fill(0);
  for (let nonce = 0; nonce < 20000; nonce += 1) {
    const roll = rollFor(seed, "spread", nonce);
    assert.ok(roll >= 0 && roll < OUTCOMES);
    buckets[Math.floor(roll / 1000)] += 1;
  }
  for (const count of buckets) assert.ok(count > 1800 && count < 2200, `${buckets}`);
});

test("client seeds are short and plain", () => {
  assert.ok(isClientSeed("my-seed_42") && isClientSeed(newClientSeed()));
  assert.ok(!isClientSeed("") && !isClientSeed("a".repeat(33)) && !isClientSeed("with space") && !isClientSeed(7));
});
