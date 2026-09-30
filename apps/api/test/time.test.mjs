// Run with `npm test --workspace apps/api` (builds first). Days and weeks on
// Albanian time, including the two days a year the clocks change.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, midnight, shortDay, startOfDay, startOfWeek } from "../dist/time.js";

const iso = (date) => date.toISOString();

test("a day starts at midnight in Tirana, not in London", () => {
  // 23:30 in Tirana on 30 September (summer time, UTC+2) is still the 30th.
  assert.equal(iso(startOfDay(new Date("2026-09-30T21:30:00Z"))), "2026-09-29T22:00:00.000Z");
  // Half an hour later it's the 1st of October there, while London is still on the 30th.
  assert.equal(iso(startOfDay(new Date("2026-09-30T22:30:00Z"))), "2026-09-30T22:00:00.000Z");
  // Winter time is UTC+1.
  assert.equal(iso(startOfDay(new Date("2026-01-15T23:30:00Z"))), "2026-01-15T23:00:00.000Z");
});

test("a week starts on Monday at midnight in Tirana", () => {
  assert.equal(iso(startOfWeek(new Date("2026-09-30T12:00:00Z"))), "2026-09-27T22:00:00.000Z", "a Wednesday");
  assert.equal(iso(startOfWeek(new Date("2026-09-27T22:30:00Z"))), "2026-09-27T22:00:00.000Z", "Monday 00:30 in Tirana");
  assert.equal(iso(startOfWeek(new Date("2026-09-27T21:30:00Z"))), "2026-09-20T22:00:00.000Z", "Sunday 23:30 in Tirana is still last week");
});

test("the days the clocks change are 23 and 25 hours long", () => {
  const spring = midnight(2026, 3, 29);
  assert.equal(iso(spring), "2026-03-28T23:00:00.000Z");
  assert.equal(addDays(spring, 1).getTime() - spring.getTime(), 23 * 3_600_000);
  const autumn = midnight(2026, 10, 25);
  assert.equal(iso(autumn), "2026-10-24T22:00:00.000Z");
  assert.equal(addDays(autumn, 1).getTime() - autumn.getTime(), 25 * 3_600_000);
  assert.equal(iso(addDays(autumn, -7)), "2026-10-17T22:00:00.000Z");
  assert.equal(iso(midnight(2026, 12, 32)), "2026-12-31T23:00:00.000Z", "a day past the month's end rolls over");
});

test("dates in the API's own text are Tirana's", () => {
  assert.equal(shortDay.format(new Date("2026-09-20T22:00:00Z")), "21 Sept");
});
