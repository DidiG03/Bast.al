// Run with `npm test --workspace apps/api` (builds first). European roulette's
// rules: the wheel, every spot on the table, what each pays, and the payout
// rate, worked out exactly over all 37 pockets rather than by sampling.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CHIPS, PAYOUT_RATE, RED_NUMBERS, SPOTS, WHEEL, colorOf, invalidBets, label, payoutFor, settle, spinWheel } = require("../dist/casino/roulette.js");

const ALL = Array.from({ length: 37 }, (_, i) => i);

test("the wheel holds every number once, with a single 0", () => {
  assert.equal(WHEEL.length, 37);
  assert.deepEqual([...WHEEL].sort((a, b) => a - b), ALL);
  assert.equal(WHEEL[0], 0);
  assert.equal(label(0), "0");
});

test("18 red, 18 black, and 0 green; colours alternate round the wheel", () => {
  assert.equal(RED_NUMBERS.length, 18);
  assert.equal(ALL.filter((n) => colorOf(n) === "BLACK").length, 18);
  assert.equal(colorOf(0), "GREEN");
  WHEEL.forEach((number, index) => {
    const next = WHEEL[(index + 1) % WHEEL.length];
    if (colorOf(number) !== "GREEN" && colorOf(next) !== "GREEN") assert.notEqual(colorOf(number), colorOf(next), `${label(number)} and ${label(next)}`);
  });
});

test("the table has every bet a real European table has, and nothing else", () => {
  const sizes = {};
  for (const numbers of SPOTS.values()) sizes[numbers.length] = (sizes[numbers.length] ?? 0) + 1;
  // 37 straight; 57 splits + 3 with 0; 12 streets + 2 trios with 0; 22 corners + the first four (0-1-2-3);
  // 11 six lines; 3 dozens + 3 columns; 6 even-money bets.
  assert.deepEqual(sizes, { 1: 37, 2: 60, 3: 14, 4: 23, 6: 11, 12: 6, 18: 6 });
  assert.deepEqual(SPOTS.get("0-1-2-3"), [0, 1, 2, 3]);
  assert.ok(!SPOTS.has("00"), "no double zero");
  for (const [spot, numbers] of SPOTS) {
    assert.equal(new Set(numbers).size, numbers.length, spot);
    assert.ok(numbers.every((n) => ALL.includes(n)), spot);
  }
  assert.deepEqual(SPOTS.get("0-3"), [0, 3]);
  assert.deepEqual([...SPOTS.get("1-2-4-5")].sort((a, b) => a - b), [1, 2, 4, 5]);
  assert.deepEqual(SPOTS.get("COL1").slice(0, 3), [1, 4, 7]);
  assert.ok(!SPOTS.has("3-4"), "3 and 4 aren't side by side");
  assert.ok(!SPOTS.has("2-3-5-6-8-9"), "a six line is two whole rows");
});

test("each bet pays what the table says: 35, 17, 11, 8, 5, 2 and 1 to 1", () => {
  assert.deepEqual([1, 2, 3, 4, 6, 12, 18].map(payoutFor), [35, 17, 11, 8, 5, 2, 1]);
  const { bets, staked, win } = settle(
    [
      { spot: "17", amount: 1 },
      { spot: "17-20", amount: 2 },
      { spot: "BLACK", amount: 5 },
      { spot: "RED", amount: 5 },
      { spot: "COL2", amount: 0.5 },
      { spot: "0-1", amount: 1 },
    ],
    17,
  );
  assert.equal(staked, 14.5);
  assert.deepEqual(bets.map((bet) => bet.win), [36, 36, 10, 0, 1.5, 0]);
  assert.equal(win, 83.5);
  assert.equal(settle([{ spot: "0", amount: 1 }], 0).win, 36);
  assert.equal(settle([{ spot: "0-1-2-3", amount: 1 }], 0).win, 9, "the first four pays 8 to 1");
  assert.equal(settle([{ spot: "RED", amount: 1 }, { spot: "BLACK", amount: 1 }, { spot: "EVEN", amount: 1 }], 0).win, 0, "outside bets lose on 0");
});

test("every spot pays back exactly 36/37 of its stake over the whole wheel (97.30%)", () => {
  for (const [spot] of SPOTS) {
    const total = WHEEL.reduce((sum, number) => sum + settle([{ spot, amount: 1 }], number).win, 0);
    assert.ok(Math.abs(total - 36) < 1e-9, `${spot} returns ${total} over 37 pockets`);
  }
  assert.equal(PAYOUT_RATE, Math.round((36 / 37) * 10000) / 100);
});

test("bets that can't be played are refused", () => {
  assert.equal(invalidBets([{ spot: "17", amount: 50 }, { spot: "RED", amount: CHIPS[5] }]), null);
  assert.match(invalidBets([]), /at least one chip/);
  assert.match(invalidBets([{ spot: "00", amount: 50 }]), /no "00"/);
  assert.match(invalidBets([{ spot: "3-4", amount: 50 }]), /no "3-4"/);
  assert.match(invalidBets([{ spot: "17", amount: 50 }, { spot: "17", amount: 50 }]), /twice/);
  for (const amount of [0, -50, 30, 125, 50.01, Number.NaN, Infinity]) assert.match(invalidBets([{ spot: "17", amount }]), /chips/, String(amount));
  assert.match(invalidBets(Array.from({ length: 151 }, (_, n) => ({ spot: String(n), amount: 50 }))), /at most 150/);
});

test("the wheel stops where the random source says, and only on the wheel", () => {
  assert.deepEqual(spinWheel(() => 0), { stop: 0, number: 0 });
  assert.deepEqual(spinWheel(() => 8), { stop: 8, number: 17 });
  assert.throws(() => spinWheel(() => 37));
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(spinWheel().number);
  assert.equal(seen.size, 37, "crypto.randomInt reaches every pocket");
});
