// Run with `npm test --workspace apps/api` (builds first). Late live bets
// (bets/late.ts): a live bet placed after a goal or a red card, or on a cards
// market after any card, that the site hadn't shown yet is void. And the feed's delay on goals
// (odds/feed-delay.ts), from when the site first saw each one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { betMoment, eventTime, lateDecision, lateReason, liveStateOf, minuteStart, newInFeed, timelineOf, isCardsMarket, isCornersMarket } = require("../dist/bets/late.js");
const { wrongWayAfterGoal } = require("../dist/odds/live-guard.js");
const { feedDelay, goalTime } = require("../dist/odds/feed-delay.js");
const { parseLateTimeline } = require("../dist/odds/api-football.js");

// Kick-offs: the first half at 18:00:00 UTC, the second at 19:00:00.
const FIRST = Date.UTC(2026, 9, 18, 18, 0, 0) / 1000;
const SECOND = Date.UTC(2026, 9, 18, 19, 0, 0) / 1000;
/** A moment in the first half, `m` minutes and `s` seconds after kick-off. */
const firstHalf = (m, s = 0) => new Date((FIRST + m * 60 + s) * 1000);
const secondHalf = (m, s = 0) => new Date((SECOND + m * 60 + s) * 1000);

const timeline = (goals = [], cards = []) => ({ first: FIRST, second: SECOND, goals, cards });
const goal = (minute, side, extra = null) => ({ minute, extra, side });
const state = (home, away, minute = null, cards = null, reds = null) => ({ home, away, minute, cards, reds });
const red = (minute, side) => ({ minute, extra: null, side, red: true });

test("a bet's match minute comes from its half's kick-off, counting like the feed: 22:30 in is the 23rd minute", () => {
  assert.deepEqual(betMoment(firstHalf(22, 30), state(0, 0), timeline()), { minute: 23, extra: 0 });
  assert.deepEqual(betMoment(secondHalf(0, 30), state(0, 0), timeline()), { minute: 46, extra: 0 });
  // Added time sits on 45 (and 90).
  assert.deepEqual(betMoment(firstHalf(46, 10), state(0, 0), timeline()), { minute: 45, extra: 2 });
  // Without kick-off times, the minute the site showed.
  assert.deepEqual(betMoment(firstHalf(22, 30), state(0, 0, 21), { first: null, second: null, goals: [], cards: [] }), { minute: 21, extra: 0 });
  assert.equal(betMoment(firstHalf(22, 30), state(0, 0, null), { first: null, second: null, goals: [], cards: [] }), null);
});

test("a goal the site hadn't shown, in an earlier minute, makes the bet late", () => {
  // The home side scored in the 22nd minute; the bet came in the 24th with the site still showing 0–0.
  assert.equal(lateReason(state(0, 0), firstHalf(23, 20), "match_winner", timeline([goal(22, "home")])), "placed after a goal that hadn't shown yet");
  // The site already showed it: not late.
  assert.equal(lateReason(state(1, 0), firstHalf(23, 20), "match_winner", timeline([goal(22, "home")])), null);
  // A goal after the bet: not late.
  assert.equal(lateReason(state(0, 0), firstHalf(23, 20), "match_winner", timeline([goal(30, "home")])), null);
});

test("a goal in the same minute as the bet counts as before it, and so does one up to 15 seconds after the bet: it may have been", () => {
  assert.equal(lateReason(state(0, 0), firstHalf(22, 50), "goals_2_5", timeline([goal(23, "away")])), "placed after a goal that hadn't shown yet");
  // The 23rd minute began 22:00 in: a bet at 21:50 is inside the 15-second buffer, one at 21:40 isn't.
  assert.equal(lateReason(state(0, 0), firstHalf(21, 50), "goals_2_5", timeline([goal(23, "away")])), "placed after a goal that hadn't shown yet");
  assert.equal(lateReason(state(0, 0), firstHalf(21, 40), "goals_2_5", timeline([goal(23, "away")])), null);
});

const at = (date) => date.getTime();
const seen = (home, away, date) => ({ home, away, seenAt: date });

test("a goal's time: the start of its minute, or 30 s before the site saw it if that's earlier, never more than 2 minutes before", () => {
  const line = timeline();
  assert.equal(minuteStart(goal(23, "home"), line), at(firstHalf(22)));
  assert.equal(minuteStart(goal(45, "home", 2), line), at(firstHalf(46)));
  assert.equal(minuteStart(goal(57, "home"), line), at(secondHalf(11)));
  assert.equal(minuteStart(goal(23, "home"), { first: null, second: null, goals: [], cards: [] }), null);
  // Seen 40 s into the minute: the minute's start is earlier than 30 s before.
  assert.equal(eventTime(at(firstHalf(22)), at(firstHalf(22, 40))), at(firstHalf(22)));
  // Seen 2:10 after the minute began (a slow feed): 30 s before it was seen is still inside 2 minutes.
  assert.equal(eventTime(at(firstHalf(22)), at(firstHalf(24, 10))), at(firstHalf(22, 10)));
  // Kick-off times that put the goal after the site saw it are wrong: only when it was seen counts, 2 minutes back.
  assert.equal(eventTime(at(firstHalf(25)), at(firstHalf(24))), at(firstHalf(22)));
  assert.equal(eventTime(null, at(firstHalf(24))), at(firstHalf(22)));
  assert.equal(eventTime(at(firstHalf(22)), null), at(firstHalf(22)));
});

test("no kick-off times and the site's own minute behind the goal's: when the site saw the goal decides (the Arsenal W / Norwich case)", () => {
  // The feed's timeline has the goal in the 67th minute but no kick-off times. The site showed 66' and 0–0 when the
  // bet was placed, 4 s after the goal went in; the feed brought the goal 40 s later.
  const goalAt = secondHalf(21, 20);
  const noKickOffs = { first: null, second: null, goals: [goal(67, "home")], cards: [] };
  const bet = new Date(at(goalAt) + 4_000);
  // The old rule only had minutes: 67 after 66, so the bet stood.
  assert.equal(lateDecision({ state: state(0, 0, 66), placedAt: bet, marketKey: "match_winner", timeline: noKickOffs, seen: [] }).late, true, "even on minutes alone, a goal in the minute after the site's counts now");
  const decision = lateDecision({ state: state(0, 0, 66), placedAt: bet, marketKey: "match_winner", timeline: noKickOffs, seen: [seen(1, 0, new Date(at(goalAt) + 44_000))] });
  assert.equal(decision.late, true);
  assert.match(decision.detail, /goal 1–0 at 67'/);
  // A bet three minutes before the feed brought the goal stands.
  assert.equal(lateDecision({ state: state(0, 0, 63), placedAt: new Date(at(goalAt) - 136_000), marketKey: "match_winner", timeline: noKickOffs, seen: [seen(1, 0, new Date(at(goalAt) + 44_000))] }).late, false);
});

test("kick-off times a minute late in the feed don't save a bet the site saw the goal after", () => {
  // The feed says the second half began a minute later than it did, so by its clock the goal is a minute later too.
  const lateClock = { first: FIRST, second: SECOND + 60, goals: [goal(56, "away")], cards: [] };
  const goalAt = secondHalf(10, 5);
  const bet = new Date(at(goalAt) + 15_000);
  // The minute alone: by the feed's clock the 56th minute began at 11:00 into the half, after the bet.
  assert.equal(lateDecision({ state: state(0, 0), placedAt: bet, marketKey: "match_winner", timeline: lateClock, seen: [] }).late, false);
  // With when the site saw it (25 s after the goal), the goal went in at least 30 s before that: before the bet.
  assert.equal(lateDecision({ state: state(0, 0), placedAt: bet, marketKey: "match_winner", timeline: lateClock, seen: [seen(0, 1, new Date(at(goalAt) + 25_000))] }).late, true);
});

test("two bets on one goal 25 s apart, both before the feed brought it: both are void", () => {
  const line = timeline([goal(31, "away")]);
  const goalAt = firstHalf(30, 30);
  const scoreSeen = [seen(0, 1, new Date(at(goalAt) + 50_000))];
  for (const after of [14_000, 39_000]) {
    assert.equal(lateDecision({ state: state(0, 0, 30), placedAt: new Date(at(goalAt) + after), marketKey: "match_winner", timeline: line, seen: scoreSeen }).reason, "placed after a goal that hadn't shown yet");
  }
});

test("without a timeline, when the site saw each score decides: up to 2 minutes (and the buffer) before it", () => {
  const scoreSeen = [seen(1, 0, firstHalf(40))];
  assert.equal(lateDecision({ state: state(0, 0, 38), placedAt: firstHalf(39), marketKey: "match_winner", timeline: null, seen: scoreSeen }).late, true);
  assert.equal(lateDecision({ state: state(0, 0, 37), placedAt: firstHalf(37, 50), marketKey: "match_winner", timeline: null, seen: scoreSeen }).late, true);
  assert.equal(lateDecision({ state: state(0, 0, 37), placedAt: firstHalf(37, 40), marketKey: "match_winner", timeline: null, seen: scoreSeen }).late, false);
  // The site was already showing it: fine.
  assert.equal(lateDecision({ state: state(1, 0, 41), placedAt: firstHalf(41), marketKey: "match_winner", timeline: null, seen: scoreSeen }).late, false);
  // Corners aren't checked, whatever happened.
  assert.equal(lateDecision({ state: state(0, 0, 38), placedAt: firstHalf(39), marketKey: "corners_9_5", timeline: null, seen: scoreSeen }).late, false);
});

test("with a timeline, a score the site saw that the timeline doesn't have (a goal VAR took back) doesn't void anything", () => {
  const scoreSeen = [seen(1, 0, firstHalf(40))];
  assert.equal(lateDecision({ state: state(0, 0, 38), placedAt: firstHalf(39), marketKey: "match_winner", timeline: timeline([]), seen: scoreSeen }).late, false);
});

test("between two readings of the feed: a goal, a red card, a VAR check or a penalty stops a live bet; a yellow only stops a cards bet", () => {
  const mark = (extra = {}) => ({ home: 0, away: 0, goals: 0, cards: 1, reds: 0, vars: 0, missedPenalties: 0, events: 1, last: null, at: "x", ...extra });
  assert.equal(newInFeed(mark(), mark(), false), null);
  assert.equal(newInFeed(mark(), mark({ goals: 1 }), false), "a goal");
  assert.equal(newInFeed(mark(), mark({ home: 1 }), false), "a goal", "the fixture's score counts even before its timeline has the goal");
  assert.equal(newInFeed(mark(), mark({ reds: 1, cards: 2 }), false), "a red card");
  assert.equal(newInFeed(mark(), mark({ vars: 1 }), false), "a VAR check");
  assert.equal(newInFeed(mark(), mark({ missedPenalties: 1 }), false), "a penalty");
  assert.equal(newInFeed(mark(), mark({ cards: 2 }), false), null);
  assert.equal(newInFeed(mark(), mark({ cards: 2 }), true), "a card");
});

test("a match-result price no shorter for the side that just scored than before its goal is the wrong way round", () => {
  const before = { home: 4.0, draw: 3.4, away: 1.9 };
  // Köln: 4.00 before the home goal, 4.33 after it.
  assert.equal(wrongWayAfterGoal({ marketKey: "match_winner", selectionKey: "home", price: 4.33, side: "home", before }), true);
  assert.equal(wrongWayAfterGoal({ marketKey: "match_winner", selectionKey: "home", price: 4.0, side: "home", before }), true);
  assert.equal(wrongWayAfterGoal({ marketKey: "match_winner", selectionKey: "home", price: 2.2, side: "home", before }), false);
  // Only the side that scored, and only the match result.
  assert.equal(wrongWayAfterGoal({ marketKey: "match_winner", selectionKey: "away", price: 3.0, side: "home", before }), false);
  assert.equal(wrongWayAfterGoal({ marketKey: "goals_2_5", selectionKey: "over", price: 2.0, side: "home", before }), false);
  assert.equal(wrongWayAfterGoal({ marketKey: "match_winner", selectionKey: "home", price: 4.5, side: "home", before: {} }), false);
});

test("second-half goals and added time line up with the second half's kick-off", () => {
  // 10:05 into the second half is the 56th minute.
  assert.equal(lateReason(state(1, 0), secondHalf(10, 5), "match_winner", timeline([goal(12, "home"), goal(57, "away")])), null);
  assert.equal(lateReason(state(1, 0), secondHalf(10, 5), "match_winner", timeline([goal(12, "home"), goal(56, "away")])), "placed after a goal that hadn't shown yet");
  // First-half added time: 45+3 comes after a bet at 45+2, 45+2 doesn't.
  assert.equal(lateReason(state(0, 0), firstHalf(46, 10), "match_winner", timeline([goal(45, "home", 3)])), null);
  assert.equal(lateReason(state(0, 0), firstHalf(46, 10), "match_winner", timeline([goal(45, "home", 2)])), "placed after a goal that hadn't shown yet");
});

test("a goal doesn't make a corners or cards bet late; a card the site hadn't shown makes a cards bet late", () => {
  assert.ok(isCornersMarket("corners_9_5") && isCornersMarket("home_corners_4_5") && isCornersMarket("away_corners_3_5"));
  assert.ok(isCardsMarket("cards_4_5") && isCardsMarket("home_cards_1_5") && !isCardsMarket("match_winner"));
  assert.equal(lateReason(state(0, 0), firstHalf(30), "corners_9_5", timeline([goal(20, "home")])), null);
  assert.equal(lateReason(state(0, 0, null, 2), firstHalf(30), "cards_4_5", timeline([goal(20, "home")], [goal(10, "home"), goal(25, "away")])), null);
  assert.equal(
    lateReason(state(0, 0, null, 2), firstHalf(30), "cards_4_5", timeline([], [goal(10, "home"), goal(25, "away"), goal(30, "home")])),
    "placed after a card that hadn't shown yet",
  );
  // No timeline for the cards when it was placed: it can't be told, so it stands.
  assert.equal(lateReason(state(0, 0, null, null), firstHalf(30), "cards_4_5", timeline([], [goal(10, "home"), goal(29, "away")])), null);
});

test("a red card the site hadn't shown makes any bet but corners and cards late; bets that didn't record the reds stand", () => {
  const cards = [goal(10, "home"), red(28, "away")];
  // One card shown (the yellow), no red: placed in the 30th minute, after the 28th-minute red.
  assert.equal(lateReason(state(0, 0, 29, 1, 0), firstHalf(29, 30), "match_winner", timeline([], cards)), "placed after a red card that hadn't shown yet");
  assert.equal(lateReason(state(0, 0, 29, 1, 0), firstHalf(29, 30), "goals_2_5", timeline([], cards)), "placed after a red card that hadn't shown yet");
  // The red was showing: fine. Placed before it: fine.
  assert.equal(lateReason(state(0, 0, 29, 2, 1), firstHalf(29, 30), "match_winner", timeline([], cards)), null);
  assert.equal(lateReason(state(0, 0, 20, 1, 0), firstHalf(20), "match_winner", timeline([], cards)), null);
  // Corners aren't checked; a cards bet goes by every card, as before.
  assert.equal(lateReason(state(0, 0, 29, 1, 0), firstHalf(29, 30), "corners_9_5", timeline([], cards)), null);
  assert.equal(lateReason(state(0, 0, 29, 1, 0), firstHalf(29, 30), "cards_3_5", timeline([], cards)), "placed after a card that hadn't shown yet");
  // A bet from before the reds were recorded: only goals are checked.
  assert.equal(lateReason(state(0, 0, 29, 1), firstHalf(29, 30), "match_winner", timeline([], cards)), null);
});

test("stored states and timelines are read safely", () => {
  assert.deepEqual(liveStateOf({ home: 1, away: 0, minute: 30, cards: 2 }), state(1, 0, 30, 2));
  assert.deepEqual(liveStateOf({ home: 1, away: 0, minute: 30, cards: 2, reds: 1, audit: { submittedAt: "x" } }), state(1, 0, 30, 2, 1));
  assert.deepEqual(liveStateOf({ home: 1, away: 0 }), state(1, 0, null, null));
  assert.equal(liveStateOf(null), null);
  assert.equal(liveStateOf({ home: "1" }), null);
  assert.equal(timelineOf({ goals: "x" }), null);
  assert.deepEqual(timelineOf({ goals: [], cards: [] }), { first: null, second: null, goals: [], cards: [] });
});

test("the feed's timeline: VAR's cancelled goals out, own goals for the other side, every card, both kick-offs", () => {
  const raw = {
    fixture: { id: 1, date: "2026-10-18T18:00:00+00:00", status: { short: "FT", elapsed: 90 }, periods: { first: FIRST, second: SECOND } },
    league: { id: 1, name: "L", country: "C", season: 2026 },
    teams: { home: { id: 10, name: "Home" }, away: { id: 20, name: "Away" } },
    goals: { home: 2, away: 1 },
    events: [
      { time: { elapsed: 12, extra: null }, team: { id: 10, name: "Home" }, player: { id: 1, name: "A" }, assist: { id: null, name: null }, type: "Goal", detail: "Normal Goal" },
      { time: { elapsed: 30, extra: null }, team: { id: 20, name: "Away" }, player: { id: 2, name: "B" }, assist: { id: null, name: null }, type: "Card", detail: "Yellow Card" },
      { time: { elapsed: 40, extra: null }, team: { id: 20, name: "Away" }, player: { id: 3, name: "C" }, assist: { id: null, name: null }, type: "Goal", detail: "Normal Goal" },
      { time: { elapsed: 41, extra: null }, team: { id: 20, name: "Away" }, player: { id: null, name: null }, assist: { id: null, name: null }, type: "Var", detail: "Goal cancelled" },
      { time: { elapsed: 45, extra: 2 }, team: { id: 20, name: "Away" }, player: { id: 4, name: "D" }, assist: { id: null, name: null }, type: "Goal", detail: "Own Goal" },
      { time: { elapsed: 70, extra: null }, team: { id: 10, name: "Home" }, player: { id: 5, name: "E" }, assist: { id: null, name: null }, type: "Card", detail: "Red Card" },
      { time: { elapsed: 88, extra: null }, team: { id: 20, name: "Away" }, player: { id: 6, name: "F" }, assist: { id: null, name: null }, type: "Goal", detail: "Penalty" },
    ],
  };
  const parsed = parseLateTimeline(raw, { home: 2, away: 1 });
  assert.equal(parsed.first, FIRST);
  assert.equal(parsed.second, SECOND);
  assert.deepEqual(parsed.goals, [goal(12, "home"), goal(45, "home", 2), goal(88, "away")]);
  // The red one is marked, for the red card check.
  assert.deepEqual(parsed.cards, [goal(30, "away"), red(70, "home")]);
  // Goals that don't add up to the result: no timeline rather than a wrong one.
  assert.equal(parseLateTimeline(raw, { home: 3, away: 1 }), null);
});

test("the feed's delay: each goal taken in the middle of its minute, from its half's kick-off", () => {
  const line = timeline([goal(10, "home"), goal(50, "away")]);
  // The 10th minute is 9:00–10:00 in; its middle is 9:30.
  assert.equal(goalTime(goal(10, "home"), line), FIRST + 9.5 * 60);
  assert.equal(goalTime(goal(50, "away"), line), SECOND + 4.5 * 60);
  const seen = [
    { eventName: "Home v Away", homeScore: 1, awayScore: 0, source: "odds", seenAt: new Date((FIRST + 9.5 * 60 + 20) * 1000), timeline: line },
    { eventName: "Home v Away", homeScore: 1, awayScore: 1, source: "scores", seenAt: new Date((SECOND + 4.5 * 60 + 40) * 1000), timeline: line },
    // A score the timeline can't explain (a goal taken back): left out.
    { eventName: "Home v Away", homeScore: 0, awayScore: 1, source: "scores", seenAt: new Date((FIRST + 30 * 60) * 1000), timeline: line },
  ];
  const delay = feedDelay(seen);
  assert.equal(delay.goals, 2);
  assert.equal(delay.average, 30);
  assert.equal(delay.slowest, 40);
  assert.deepEqual(delay.bySource, { odds: { goals: 1, average: 20 }, scores: { goals: 1, average: 40 } });
  assert.equal(delay.recent[0].score, "1–1");
  assert.equal(delay.recent[0].seconds, 40);
  assert.deepEqual(feedDelay([]), { goals: 0, average: null, median: null, p90: null, slowest: null, bySource: {}, recent: [] });
});
