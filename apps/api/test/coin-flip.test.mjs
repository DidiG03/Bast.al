// Run with `npm test --workspace apps/api` (builds first). Coin Flip's rules:
// a right call pays 1.8x, so a flip pays back 90%, and the flip is fair and
// comes from the seeds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";

const require = createRequire(import.meta.url);
const { BETS, MULTIPLIER, PAYOUT_RATE, SIDES, flipFor, winCents } = require("../dist/casino/coin-flip.js");

test("the sides, the bets and the pay are what the rules say", () => {
  assert.deepEqual([...SIDES], ["HEADS", "TAILS"]);
  assert.deepEqual([...BETS], [50, 100, 250, 500, 1000, 2500]);
  assert.equal(MULTIPLIER, 1.8);
  assert.equal(PAYOUT_RATE, 90);
});

test("a right call pays the stake times 1.8, rounded down to the cent", () => {
  assert.equal(winCents(5000), 9000);
  assert.equal(winCents(250_000), 450_000, "2,500 ALL pays 4,500 ALL");
  assert.equal(winCents(1), 1);
});

test("a flip is the seeds' HMAC as a fraction: below 0.5 is heads; the same seeds give the same side", () => {
  for (let nonce = 0; nonce < 50; nonce++) {
    const bytes = createHmac("sha256", "server-seed").update(`client:${nonce}`).digest();
    assert.equal(flipFor("server-seed", "client", nonce), bytes[0] < 128 ? "HEADS" : "TAILS");
  }
  assert.equal(flipFor("server-seed", "client", 7), flipFor("server-seed", "client", 7));
});

test("heads and tails come up about as often", () => {
  const flips = 40_000;
  let heads = 0;
  for (let nonce = 0; nonce < flips; nonce++) if (flipFor("fairness", "check", nonce) === "HEADS") heads++;
  // 20,000 heads, give or take 100 (one standard deviation).
  assert.ok(Math.abs(heads - flips / 2) < 600, `${heads} heads in ${flips} flips`);
});
