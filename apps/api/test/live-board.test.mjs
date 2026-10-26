import assert from "node:assert/strict";
import test from "node:test";
import { holdMinute, rowWord } from "../../web/lib/live-rules.mjs";

test("the clock never steps backwards within a period", () => {
  let shown = null;
  for (const minute of [16, 15, 17, 16, 18]) shown = holdMinute(shown, minute);
  assert.equal(shown, 18);
  assert.equal(holdMinute(45, 44), 45);
  assert.equal(holdMinute(45, 45), 45);
  assert.equal(holdMinute(45, 46), 46);
  // A new period starts again: the caller forgets the previous minute.
  assert.equal(holdMinute(null, 46), 46);
});

test("a market row keeps one label across polls", () => {
  const polls = [
    { our: "goal", suspended: true, stale: false },
    { our: "goal", suspended: true, stale: false },
    { our: null, suspended: true, stale: false },
    { our: null, suspended: true, stale: false },
    { our: null, suspended: false, stale: false },
  ];
  assert.deepEqual(
    polls.map((poll) => rowWord(poll.our, poll.suspended, poll.stale)),
    ["paused", "paused", "suspended", "suspended", null],
  );
  assert.equal(rowWord("goal", true, true), null, "a market the feed never prices is taken off the board");
});
