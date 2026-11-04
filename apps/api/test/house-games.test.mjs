// Run with `npm test --workspace apps/api` (builds first). The rules of Money
// Wheel, Baccarat, Hi-Lo, Tower and Crash (src/casino/*.ts): what each pays,
// what it pays back on average, and its edge cases.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Wheel = require("../dist/casino/wheel.js");
const Baccarat = require("../dist/casino/baccarat.js");
const Hilo = require("../dist/casino/hilo.js");
const Tower = require("../dist/casino/tower.js");
const Crash = require("../dist/casino/crash.js");

/** A repeatable random draw (mulberry32), so simulations give the same answer every run. */
function seeded(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (below) => Math.floor(next() * below);
}
/** A draw that returns these values in turn. */
const scripted = (values) => {
  let i = 0;
  return () => values[i++];
};

test("Money Wheel: every risk has 30 segments paying back exactly 75%", () => {
  for (const risk of Wheel.RISKS) {
    const wheel = Wheel.WHEELS[risk];
    assert.equal(wheel.length, 30, risk);
    assert.equal(wheel.reduce((a, b) => a + b, 0) / wheel.length, 75, risk);
  }
  assert.deepEqual(Wheel.spin("HIGH", () => 7), { segment: 7, multiplier: 1500 });
  assert.equal(Wheel.winCents(10_000, 150), 15_000);
});

test("Baccarat: the third-card tableau", () => {
  const c = (rank) => ({ rank, suit: 0 });
  assert.equal(Baccarat.total([c(7), c(8)]), 5);
  assert.equal(Baccarat.total([c(13), c(9)]), 9);
  assert.equal(Baccarat.bankerDraws(5, null), true, "player stood: banker draws on 0-5");
  assert.equal(Baccarat.bankerDraws(6, null), false);
  assert.equal(Baccarat.bankerDraws(3, c(8)), false);
  assert.equal(Baccarat.bankerDraws(3, c(9)), true);
  assert.equal(Baccarat.bankerDraws(4, c(1)), false);
  assert.equal(Baccarat.bankerDraws(4, c(2)), true);
  assert.equal(Baccarat.bankerDraws(5, c(4)), true);
  assert.equal(Baccarat.bankerDraws(6, c(6)), true);
  assert.equal(Baccarat.bankerDraws(6, c(5)), false);
  assert.equal(Baccarat.bankerDraws(7, c(6)), false);
  assert.equal(Baccarat.payoutCents(10_000, "PLAYER", "PLAYER"), 14_700);
  assert.equal(Baccarat.payoutCents(10_000, "BANKER", "BANKER"), 14_300);
  assert.equal(Baccarat.payoutCents(10_000, "BANKER", "TIE"), 10_000, "a tie returns the stake");
  assert.equal(Baccarat.payoutCents(10_000, "TIE", "TIE"), 80_000);
  assert.equal(Baccarat.payoutCents(10_000, "TIE", "PLAYER"), 0);
});

test("Baccarat: pays back about what the rules say (200,000 hands)", () => {
  const draw = seeded(7);
  const paid = { PLAYER: 0, BANKER: 0, TIE: 0 };
  const hands = 200_000;
  for (let i = 0; i < hands; i++) {
    const hand = Baccarat.deal(draw);
    for (const side of Baccarat.SIDES) paid[side] += Baccarat.payoutCents(100, side, hand.winner);
  }
  for (const side of Baccarat.SIDES) assert.ok(Math.abs(paid[side] / hands - Baccarat.PAYOUT_RATES[side]) < (side === "TIE" ? 2 : 0.6), `${side}: ${paid[side] / hands}`);
});

test("Hi-Lo: a right guess raises the multiplier by its odds; 75% on the first", () => {
  // A 7 showing, guess higher-or-same (7/13), the next card a king.
  let round = Hilo.startRound(10_000, scripted([6, 0]));
  assert.equal(round.steps[0].card.rank, 7);
  round = Hilo.guess(round, "HIGHER", scripted([12, 1]));
  assert.equal(round.phase, "PLAY");
  assert.equal(Hilo.multiplierHundredths(round.num, round.den), Math.floor((75 * 13) / 7));
  const won = Hilo.cashOut(round);
  assert.equal(won.phase, "WON");
  assert.equal(won.payout, Math.floor((10_000 * Math.floor((75 * 13) / 7)) / 100));
  assert.throws(() => Hilo.cashOut(won), Hilo.HiloError);
});

test("Hi-Lo: a wrong guess loses; skip is free; no cash-out before a right guess", () => {
  let round = Hilo.startRound(10_000, scripted([6, 0]));
  assert.throws(() => Hilo.cashOut(round), Hilo.HiloError);
  round = Hilo.guess(round, "SKIP", scripted([2, 0]));
  assert.equal(round.phase, "PLAY");
  assert.equal(round.num, "1");
  const lost = Hilo.guess(round, "HIGHER", scripted([0, 0]));
  assert.equal(lost.phase, "LOST");
  assert.equal(lost.payout, 0);
});

test("Hi-Lo: cashing out after any number of guesses pays back about 75% (simulated)", () => {
  const draw = seeded(11);
  let staked = 0;
  let paid = 0;
  for (let i = 0; i < 120_000; i++) {
    let round = Hilo.startRound(100, draw);
    const stopAt = 1 + (i % 4);
    let rights = 0;
    while (round.phase === "PLAY" && rights < stopAt) {
      const rank = round.steps[round.steps.length - 1].card.rank;
      round = Hilo.guess(round, rank <= 7 ? "HIGHER" : "LOWER", draw);
      if (round.phase === "PLAY") rights++;
    }
    if (round.phase === "PLAY") round = Hilo.cashOut(round);
    staked += 100;
    paid += round.payout;
  }
  const rate = (paid / staked) * 100;
  assert.ok(rate > 73 && rate < 76, `paid back ${rate}%`);
});

test("Hi-Lo: the exact odds stay exact over a long round, and the cap ends it", () => {
  assert.equal(Hilo.multiplierHundredths(13n ** 30n, 12n ** 30n), Math.floor(Number((75n * 13n ** 30n) / 12n ** 30n)));
  assert.equal(Hilo.multiplierHundredths("1000000000", "1"), Hilo.MAX_WIN * 100);
});

test("Tower: the ladder is 75% of the fair price; cashing out at any floor pays back about 75%", () => {
  for (const level of Tower.LEVELS) {
    const { doors, traps } = Tower.LEVEL_SHAPE[level];
    const survive = (doors - traps) / doors;
    for (let k = 1; k <= Tower.FLOORS; k++) {
      const multiplier = Tower.multiplierHundredths(level, k) / 100;
      if (multiplier >= Tower.MAX_WIN) continue;
      const rate = survive ** k * multiplier;
      assert.ok(rate <= 0.75 + 1e-9 && rate > 0.74, `${level} floor ${k}: ${rate}`);
    }
  }
  assert.equal(Tower.multiplierHundredths("EXPERT", 8), Math.floor(75 * 3 ** 8), "the top of Expert: 4,920.75×");
});

test("Tower: a trap loses, the top floor cashes out by itself, the traps stay hidden while climbing", () => {
  // Hard: 2 doors, 1 trap per floor; the trap always behind door 0.
  let round = Tower.startRound(10_000, "HARD", () => 0);
  assert.equal(Tower.publicView(round).traps, null);
  assert.throws(() => Tower.cashOut(round), Tower.TowerError);
  assert.equal(Tower.climb(round, 0).phase, "LOST");
  for (let floor = 0; floor < Tower.FLOORS; floor++) round = Tower.climb(round, 1);
  assert.equal(round.phase, "WON");
  assert.equal(round.payout, Math.floor((10_000 * Tower.multiplierHundredths("HARD", 8)) / 100));
  assert.ok(Tower.publicView(round).traps);
  assert.throws(() => Tower.climb(Tower.startRound(100, "EASY", () => 0), 4), Tower.TowerError);
});

test("Crash: the crash point reaches x with chance 0.75/x; about 26% crash at once", () => {
  // Over a fine grid of u, the share of crash points at or above x.
  const n = 200_000;
  const points = Array.from({ length: n }, (_, i) => Crash.crashPointFor((i + 1) / n));
  for (const x of [100, 101, 150, 200, 500, 1000]) {
    const share = points.filter((p) => p >= x).length / n;
    const expected = x === 100 ? 1 : 75 / x;
    assert.ok(Math.abs(share - expected) < 0.003, `x=${x}: ${share} vs ${expected}`);
  }
  // Anything that would land below 1.01× crashes at 1.00× at once: 1 − 0.75/1.01, about 25.7% of rounds.
  assert.ok(Math.abs(points.filter((p) => p === 100).length / n - (1 - 75 / 101)) < 0.003);
  assert.equal(Crash.crashPointFor(1e-9), Crash.MAX_MULTIPLIER * 100, "capped");
});

test("Crash: cash out before the crash pays the multiplier then; after it, nothing", () => {
  const round = { bet: 10_000, crash: 300, startedAt: 0, auto: null, phase: "PLAY", at: null, payout: 0 };
  const t2 = Crash.msToReach(200) + 1;
  const won = Crash.cashOut(round, t2);
  assert.equal(won.phase, "WON");
  assert.equal(won.at, 200);
  assert.equal(won.payout, 20_000);
  const late = Crash.cashOut(round, Crash.msToReach(300) + 1);
  assert.equal(late.phase, "LOST");
  assert.equal(late.at, 300);
  // The automatic cash-out wins at its own multiplier, even when checked later.
  const auto = Crash.advance({ ...round, auto: 250 }, Crash.msToReach(290));
  assert.deepEqual([auto.phase, auto.at, auto.payout], ["WON", 250, 25_000]);
  // An automatic cash-out at or above the crash point loses.
  assert.equal(Crash.advance({ ...round, auto: 300 }, Crash.msToReach(400)).phase, "LOST");
  // Instant crash at 1.00×.
  assert.equal(Crash.advance({ ...round, crash: 100 }, 0).phase, "LOST");
  assert.equal(Crash.publicView(round, 1000).crash, null, "hidden while it climbs");
});
