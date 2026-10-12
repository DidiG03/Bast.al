// Spreading API-Football's daily requests: a task gets the speed it asks for
// while what's left lasts until midnight UTC at that speed, is slowed down
// when it wouldn't, and stops when it can't afford a run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PREMATCH_REFRESH_MS, isDailyLimitError, msUntilReset, pacedInterval, quotaReserve } = require("../dist/odds/feed-budget.js");

const HOUR = 3_600_000;

test("the day's count starts again at midnight UTC", () => {
  assert.equal(msUntilReset(Date.UTC(2026, 9, 12, 21, 0, 0)), 3 * HOUR);
  assert.equal(msUntilReset(Date.UTC(2026, 9, 13, 0, 0, 0)), 24 * HOUR);
});

test("plenty left: live prices every 5 seconds", () => {
  // 75,000 a day, 70,000 left with 20 hours to go: 45% of it is ~31,500 runs, far more than 14,400 at 5 seconds.
  assert.equal(pacedInterval({ wantMs: 5_000, perRun: 1, share: 0.45, left: 70_000, msLeft: 20 * HOUR }), 5_000);
});

test("not enough left at that speed: spaced out so the share lasts until midnight", () => {
  // 7,500's plan with 2,000 left and 10 hours to go: 900 runs, one every 40 seconds.
  assert.equal(pacedInterval({ wantMs: 5_000, perRun: 1, share: 0.45, left: 2_000, msLeft: 10 * HOUR }), 40_000);
  // A match-centre run costs 3: a third as many runs.
  assert.equal(pacedInterval({ wantMs: 30_000, perRun: 3, share: 0.15, left: 2_000, msLeft: 10 * HOUR }), 360_000);
});

test("nothing affordable, or nothing known yet", () => {
  assert.equal(pacedInterval({ wantMs: 5_000, perRun: 1, share: 0.45, left: 0, msLeft: HOUR }), Infinity);
  assert.equal(pacedInterval({ wantMs: 5_000, perRun: 1, share: 0.45, left: -50, msLeft: HOUR }), Infinity, "below the reserve");
  assert.equal(pacedInterval({ wantMs: 5_000, perRun: 1, share: 0.45, left: null, msLeft: HOUR }), 5_000, "before the first answer");
});

test("the reserve for scores and results grows with the plan", () => {
  assert.equal(quotaReserve(7_500), 600);
  assert.equal(quotaReserve(75_000), 6_000);
  assert.equal(quotaReserve(null), 600);
});

test("the feed's 'used up for today' answer is recognised", () => {
  assert.equal(isDailyLimitError(new Error("API-Football: You have reached the request limit for the day, Go to https://dashboard.api-football.com to upgrade your plan.")), true);
  assert.equal(isDailyLimitError(new Error("API-Football answered 500 for /odds/live")), false);
});

test("a big plan refreshes today's pre-match prices every 10 minutes, a small one every 30", () => {
  assert.equal(PREMATCH_REFRESH_MS.rich[0], 10 * 60_000);
  assert.equal(PREMATCH_REFRESH_MS.lean[0], 30 * 60_000);
});
