// Run with `npm test --workspace apps/api` (builds first). Covers the pure
// odds code: pricing math and API-Football parsing against the mock feed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ApiFootballClient, eventStatus, parseLiveOdds, parseMarkets } from "../dist/odds/api-football.js";
import { mockFetchJson } from "../dist/odds/mock-feed.js";
import { bigSwing, cooldownFor, eventPause, freshBlocker, freshUntil, laterCooldown, marketGroup, mergePause, sameLivePrice, sameScorePause, scoreChanged, smallPriceMove, takenWithoutAsking } from "../dist/odds/live-guard.js";
import { countLineDead, countSelectionDead, countStatsStale } from "../dist/odds/count-guard.js";
import { lagSample } from "../dist/odds/feed-delay.js";
import { applyMargin, eventOpen, livePause, liveSideUnpriced, marketPause, marketStale, pauseSummary, priceCeiling, selectionQuote, teamMargin, teamPrice } from "../dist/odds/pricing.js";
import { hotMatches, minuteRoom } from "../dist/odds/live-polling.js";

test("a margin comes off the feed price and rounds down to the cent", () => {
  assert.equal(applyMargin(2.0, 5), 1.9);
  assert.equal(applyMargin(1.9, 0), 1.9);
  assert.equal(applyMargin(3.33, 10), 2.99);
  assert.equal(applyMargin(1.02, 10), 1.01, "never below 1.01");
});

test("an Owner can give back margin but never price above the feed", () => {
  assert.equal(teamMargin(5, 3), 8);
  assert.equal(teamMargin(5, -5), 0);
  assert.equal(teamMargin(5, -9), 0);
  assert.equal(teamMargin(40, 30), 50);
});

test("an Owner's own price wins over the margin", () => {
  assert.equal(teamPrice({ feedOdds: 2.5, baseMargin: 5, ownerMargin: 2 }), 2.32);
  assert.equal(teamPrice({ feedOdds: 2.5, baseMargin: 5, ownerMargin: 2, override: 2.75 }), 2.75);
});

test("API-Football statuses map to event statuses", () => {
  assert.equal(eventStatus("NS"), "UPCOMING");
  assert.equal(eventStatus("2H"), "LIVE");
  assert.equal(eventStatus("HT"), "LIVE");
  assert.equal(eventStatus("PEN"), "COMPLETED");
  assert.equal(eventStatus("PST"), "POSTPONED");
  assert.equal(eventStatus("CANC"), "CANCELLED");
});

test("markets are parsed from a bookmaker's odds, and half-priced markets dropped", () => {
  const raw = {
    fixture: { id: 1 },
    bookmakers: [
      {
        id: 8,
        name: "Bet365",
        bets: [
          { id: 1, name: "Match Winner", values: [{ value: "Home", odd: "2.10" }, { value: "Draw", odd: "3.20" }, { value: "Away", odd: "3.40" }] },
          { id: 5, name: "Goals Over/Under", values: [{ value: "Over 2.5", odd: "2.00" }] },
          { id: 99, name: "Corners", values: [{ value: "Over 9.5", odd: "1.90" }] },
        ],
      },
    ],
  };
  const markets = parseMarkets(raw, "Tirana", "Partizani", 8);
  assert.equal(markets.length, 1);
  assert.deepEqual(
    markets[0].selections.map((s) => [s.key, s.name, s.odds]),
    [["home", "Tirana", 2.1], ["draw", "Draw", 3.2], ["away", "Partizani", 3.4]],
  );
});

test("the mock feed answers like API-Football", async () => {
  const now = Date.UTC(2026, 8, 28, 12, 0);
  const client = new ApiFootballClient(mockFetchJson(() => now));
  const today = await client.fixturesByDate("2026-09-28");
  assert.ok(today.some((f) => f.country === "Albania"));
  const live = await client.liveFixtures();
  assert.ok(live.length >= 2 && live.every((f) => f.status === "LIVE"));
  const upcoming = today.find((f) => f.status === "UPCOMING");
  const odds = await client.odds(upcoming.leagueId, upcoming.season, "2026-09-28", 8);
  const raw = odds.find((o) => String(o.fixture.id) === upcoming.externalId);
  assert.deepEqual(parseMarkets(raw, upcoming.homeTeam, upcoming.awayTeam, 8).map((m) => m.key), ["match_winner", "double_chance", "goals_2_5", "btts"]);
});

const liveRaw = (overrides = {}) => ({
  fixture: { id: 7, status: { long: "Second Half", elapsed: 62 } },
  status: { stopped: false, blocked: false, finished: false },
  odds: [
    { id: 59, name: "Fulltime Result", values: [{ value: "Home", odd: "1.40" }, { value: "Draw", odd: "4.20", suspended: false }, { value: "Away", odd: "8.00" }] },
    {
      id: 36,
      name: "Over/Under Line",
      values: [
        { value: "Over", odd: "1.30", handicap: "1.5" },
        { value: "Over", odd: "2.10", handicap: "2.5" },
        { value: "Under", odd: "1.70", handicap: "2.5", suspended: true },
      ],
    },
    { id: 999, name: "Next Corner", values: [{ value: "Home", odd: "1.9" }] },
  ],
  ...overrides,
});

test("live odds map onto our markets, and a suspended outcome suspends its market", () => {
  const parsed = parseLiveOdds(liveRaw(), "Tirana", "Partizani");
  assert.equal(parsed.externalId, "7");
  assert.equal(parsed.stopped, false);
  assert.deepEqual(parsed.markets.map((m) => m.key), ["match_winner", "goals_1_5", "goals_2_5"]);
  const winner = parsed.markets[0];
  assert.equal(winner.suspended, false);
  assert.deepEqual(winner.selections.map((s) => [s.name, s.odds]), [["Tirana", 1.4], ["Draw", 4.2], ["Partizani", 8]]);
  const [low, goals] = parsed.markets.slice(1);
  assert.equal(low.name, "Total goals 1.5");
  assert.deepEqual(low.selections.map((s) => [s.key, s.odds]), [["over", 1.3], ["under", 0]]);
  assert.equal(low.suspended, true, "no Under 1.5 price");
  assert.equal(goals.suspended, true, "Under 2.5 is suspended");
  assert.equal(goals.selections[0].odds, 2.1, "each line keeps its own price");
  assert.equal(goals.selections[1].odds, 1.7, "a suspended price is kept, so a pause can see that it moved");
  assert.equal(parseLiveOdds(liveRaw({ status: { stopped: false, blocked: true } }), "A", "B").stopped, true);
});

test("every half-goal line in the live goals market gets its own market", () => {
  const values = [
    { value: "Over", odd: "1.05", handicap: "0.5" },
    { value: "Under", odd: "9.00", handicap: "0.5" },
    { value: "Over 3.5", odd: "3.40" },
    { value: "Under 3.5", odd: "1.30" },
    { value: "Over", odd: "2.00", handicap: "3" },
    { value: "Under", odd: "1.80", handicap: "3" },
    { value: "Over", odd: "1.90", handicap: "2.75" },
  ];
  const parsed = parseLiveOdds(liveRaw({ odds: [{ id: 25, name: "Match Goals", values }] }), "A", "B");
  assert.deepEqual(parsed.markets.map((m) => [m.key, m.suspended]), [["goals_0_5", false], ["goals_3_5", false]], "whole and quarter lines are skipped");
  assert.deepEqual(parsed.markets[1].selections.map((s) => [s.name, s.odds]), [["Over 3.5", 3.4], ["Under 3.5", 1.3]]);
});

test("the wider in-play markets map onto the markets we already settle", () => {
  const odds = [
    { id: 48, name: "Draw No Bet", values: [{ value: "Home", odd: "1.50" }, { value: "Away", odd: "2.60" }] },
    { id: 68, name: "Goals Odd/Even", values: [{ value: "Odd", odd: "1.90" }, { value: "Even", odd: "1.90" }] },
    { id: 19, name: "1x2 (1st Half)", values: [{ value: "1", odd: "3.00" }, { value: "X", odd: "1.80" }, { value: "2", odd: "5.00" }] },
    { id: 35, name: "To Win 2nd Half", values: [{ value: "Home", odd: "2.20" }, { value: "Draw", odd: "2.90", suspended: true }, { value: "Away", odd: "3.60" }] },
    { id: 58, name: "Home Team Goals", values: [{ value: "Over", odd: "1.70", handicap: "1.5" }, { value: "Under", odd: "2.05", handicap: "1.5" }] },
    { id: 177, name: "Over/Under (2nd Half)", values: [{ value: "Over 0.5", odd: "1.25" }, { value: "Under 0.5", odd: "3.75" }] },
    { id: 37, name: "Total Corners", values: [{ value: "Over", odd: "1.83", handicap: "9.5" }, { value: "Under", odd: "1.83", handicap: "9.5" }] },
    { id: 23, name: "Final Score", values: [{ value: "1:0", odd: "4.50" }, { value: "2-1", odd: "9.00" }, { value: "0:0", odd: "7.00", suspended: true }] },
    { id: 64, name: "Half Time/Full Time", values: [{ value: "Home/Home", odd: "2.50" }, { value: "1/X", odd: "8.00" }] },
    { id: 29, name: "Result / Both Teams To Score", values: [{ value: "Home & Yes", odd: "4.00" }, { value: "Draw/No", odd: "6.50" }] },
    { id: 999, name: "Which team will score the 2nd goal?", values: [{ value: "Home", odd: "1.90" }] },
  ];
  const parsed = parseLiveOdds(liveRaw({ odds }), "Tirana", "Partizani");
  const byKey = Object.fromEntries(parsed.markets.map((m) => [m.key, m]));
  assert.deepEqual(Object.keys(byKey).sort(), ["corners_9_5", "correct_score", "draw_no_bet", "h1_winner", "h2_goals_0_5", "h2_winner", "home_goals_1_5", "ht_ft", "odd_even", "result_btts"]);
  assert.deepEqual(byKey.h1_winner.selections.map((s) => [s.key, s.odds]), [["home", 3], ["draw", 1.8], ["away", 5]], "1X2 symbols count as Home/Draw/Away");
  assert.equal(byKey.h2_winner.suspended, true, "a three-way market is off while one outcome is");
  assert.equal(byKey.home_goals_1_5.name, "Tirana goals 1.5");
  assert.deepEqual(byKey.correct_score.selections.map((s) => s.key), ["1-0", "2-1"], "a suspended scoreline is left out");
  assert.equal(byKey.correct_score.suspended, false);
  assert.deepEqual(byKey.ht_ft.selections.map((s) => [s.key, s.odds]), [["home_home", 2.5], ["home_draw", 8]], "partial markets keep what's priced");
  assert.equal(byKey.ht_ft.suspended, false);
  assert.deepEqual(byKey.result_btts.selections.map((s) => s.key), ["home_yes", "draw_no"]);
  const order = parsed.markets.map((m) => m.key);
  assert.ok(order.indexOf("draw_no_bet") < order.indexOf("h1_winner") && order.indexOf("h1_winner") < order.indexOf("corners_9_5"), "live markets keep the pre-match order");
});

test("a real /odds/live answer maps onto our markets", () => {
  const { response } = JSON.parse(readFileSync(new URL("./fixtures/api-football-live-odds.json", import.meta.url), "utf8"));
  const stopped = parseLiveOdds(response[0], "Home FC", "Away FC");
  assert.equal(stopped.stopped, true);
  assert.deepEqual(
    stopped.markets.map((m) => m.key),
    ["match_winner", "double_chance", "goals_2_5", "goals_3_5", "draw_no_bet", "home_goals_1_5", "odd_even", "h2_btts", "corners_3_5"],
  );
  // Everything in this answer is suspended, and the prices are kept so a pause can see a move. A suspended scoreline is still left out.
  assert.ok(stopped.markets.every((m) => m.suspended));
  assert.ok(stopped.markets.find((m) => m.key === "goals_2_5").selections.every((s) => s.odds > 1));

  const open = parseLiveOdds(response[1], "Chile", "Switzerland");
  const byKey = Object.fromEntries(open.markets.map((m) => [m.key, m]));
  assert.deepEqual(Object.keys(byKey).sort(), ["away_goals_1_5", "away_goals_2_5", "h1_goals_0_5", "h1_goals_1_5", "h1_winner", "ht_ft"], "whole corner lines (Over/Exactly/Under 8) are skipped");
  assert.deepEqual(byKey.h1_winner.selections.map((s) => [s.name, s.odds]), [["Chile", 3.1], ["Draw", 1.615], ["Switzerland", 7]]);
  assert.equal(byKey.ht_ft.selections.length, 9, "1/X-style HT/FT values all map");
  assert.equal(byKey.ht_ft.selections.find((s) => s.key === "draw_away").odds, 8.5);
  assert.ok(open.markets.every((m) => !m.suspended));
});

test("live double chance comes as \"Home or Draw\" and \"Away or Draw\"", () => {
  const values = [
    { value: "Home or Draw", odd: "1.222" },
    { value: "Away or Draw", odd: "1.444" },
    { value: "Home or Away", odd: "1.615" },
  ];
  const [market] = parseLiveOdds(liveRaw({ odds: [{ id: 72, name: "Double Chance", values }] }), "A", "B").markets;
  assert.deepEqual(market.selections.map((s) => [s.key, s.odds]), [["home_draw", 1.222], ["home_away", 1.615], ["draw_away", 1.444]]);
  assert.equal(market.suspended, false);
});

test("the mock feed prices live matches and suspends them just after a goal", async () => {
  const start = Date.parse("2026-01-01T12:00:00Z");
  let now = start + 70 * 60_000; // Tirana (kick-off 50 min before start) is in the second half
  const client = new ApiFootballClient(mockFetchJson(() => now, start));
  const live = await client.liveOdds();
  assert.ok(live.length > 0);
  for (const raw of live) {
    const parsed = parseLiveOdds(raw, "H", "A");
    assert.ok(parsed.markets.some((m) => m.key === "match_winner"));
    const goals = raw.teams.home.goals + raw.teams.away.goals;
    const lines = parsed.markets.filter((m) => m.key.startsWith("goals_")).map((m) => Number(m.key.slice(6).replace("_", ".")));
    assert.ok(lines.length > 0 || goals >= 5, "lines above the score are offered");
    assert.ok(lines.every((line) => line > goals), "decided lines drop off");
    for (const market of parsed.markets) for (const s of market.selections) assert.ok(s.odds > 1);
  }
});

test("live matches take bets only with fresh prices the feed hasn't stopped", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const base = { status: "LIVE", startsAt: new Date("2026-01-01T11:00:00Z"), suspended: false, hidden: false, liveStopped: false, liveOddsAt: new Date(now.getTime() - 20_000) };
  assert.equal(eventOpen(base, now), true);
  assert.equal(eventOpen({ ...base, liveOddsAt: new Date(now.getTime() - 120_000) }, now), false, "stale prices");
  assert.equal(eventOpen({ ...base, liveOddsAt: null }, now), false, "never priced live");
  assert.equal(eventOpen({ ...base, liveStopped: true }, now), false, "feed stopped");
  assert.equal(eventOpen({ ...base, suspended: true }, now), false, "Super Admin suspended");
  assert.equal(eventOpen({ ...base, status: "UPCOMING", startsAt: new Date(now.getTime() + 60_000) }, now), true);
  assert.equal(eventOpen({ ...base, status: "UPCOMING", startsAt: new Date(now.getTime() - 60_000) }, now), false, "kicked off but not live yet");
});

test("a whole live match pauses only for the feed, a slow competition and the last minutes; a goal pauses its markets", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const base = { status: "LIVE", startsAt: new Date("2026-01-01T11:00:00Z"), suspended: false, hidden: false, liveStopped: false, liveOddsAt: new Date(now.getTime() - 5_000), elapsed: 60 };
  assert.equal(livePause(base, now), null);
  assert.equal(livePause({ ...base, liveCooldownUntil: new Date(now.getTime() + 30_000), liveCooldownReason: "goal" }, now), null, "a goal pauses markets, not the match");
  assert.equal(livePause({ ...base, liveSlowCompetition: true }, now), "competition");
  assert.equal(eventOpen({ ...base, liveSlowCompetition: true }, now), false, "pre-match only where the feed is too slow");
  assert.equal(livePause({ ...base, elapsed: 89 }, now), "late");
  assert.equal(livePause({ ...base, elapsed: 88 }, now), null);
  assert.equal(livePause({ ...base, liveStopped: true }, now), "bookmaker");
  assert.equal(livePause({ ...base, liveOddsAt: null, elapsed: 0, startsAt: new Date(now.getTime() - 30_000) }, now), "bookmaker", "kick-off, no prices yet");
  assert.equal(livePause({ ...base, status: "UPCOMING" }, now), null, "only live matches pause");

  const reading = (homeScore, awayScore, stopped = false) => ({ homeScore, awayScore, stopped });
  assert.equal(cooldownFor(reading(0, 0), reading(1, 0), false, now).reason, "goal");
  assert.equal(cooldownFor(reading(0, 0), reading(1, 0), false, now).until.getTime(), now.getTime() + 90_000);
  assert.equal(cooldownFor(reading(1, 0), reading(0, 0), false, now).reason, "goal", "a goal taken back by VAR");
  assert.equal(cooldownFor(reading(null, null), reading(0, 0), false, now), null, "the first reading isn't a goal");
  assert.equal(cooldownFor(reading(0, 0), reading(0, 0), true, now).reason, "swing");
  assert.equal(cooldownFor(reading(0, 0, true), reading(0, 0, false), false, now).reason, "reopen");
  assert.equal(cooldownFor(reading(0, 0), reading(0, 0), false, now), null);

  const long = { until: new Date(now.getTime() + 90_000), reason: "goal" };
  assert.deepEqual(laterCooldown(long, { until: new Date(now.getTime() + 15_000), reason: "reopen" }), long, "a short pause never cuts a goal pause short");
  assert.equal(laterCooldown({ until: null, reason: null }, long), long);

  assert.equal(scoreChanged(reading(0, 0), reading(1, 0)), true);
  assert.equal(scoreChanged(reading(1, 0), reading(1, 0)), false, "the prices moving after a goal is not another goal");
  assert.equal(scoreChanged(reading(null, null), reading(0, 0)), false);

  assert.equal(bigSwing([2.0, 3.4, 4.0], [2.1, 3.3, 4.2]), false, "normal drift");
  assert.equal(bigSwing([2.0, 3.4, 4.0], [1.4, 3.8, 7.0]), true, "a red card or a penalty");
  assert.equal(bigSwing([1.8, 3.6, 26.0], [1.75, 3.7, 34.0]), false, "a long shot drifting isn't a jump");
  assert.equal(bigSwing([2.0, 3.3, 3.8], [3.2, 3.4, 2.4]), true, "a red card: 50% down to 31%");
  assert.equal(bigSwing([null, 3.4], [1.2, 3.4]), false, "an outcome coming back isn't a jump");
  assert.equal(smallPriceMove(1.9, 1.95), true, "a tick is taken");
  assert.equal(smallPriceMove(2, 2.5), false, "2.00 to 2.50 is a real move");
  assert.equal(smallPriceMove(1, 1.5), false, "a price of 1 is not a price");
  assert.equal(takenWithoutAsking(1.9, 1.95), true, "a tick up is taken");
  assert.equal(takenWithoutAsking(1.95, 1.9), false, "a tick down asks first");
  assert.equal(takenWithoutAsking(2, 2.5), false, "a real move up asks first");
});

test("a goal pauses the goal markets; others stay open only if priced after it", () => {
  const goalAt = new Date("2026-01-01T12:00:00Z");
  assert.equal(marketGroup("match_winner"), "goals");
  assert.equal(marketGroup("odd_even"), "goals", "a goal flips odd/even");
  assert.equal(marketGroup("home_cards_1_5"), "cards");
  assert.equal(marketGroup("corners_9_5"), "corners");
  const goal = (marketKey, pricedSinceEvent = false) => eventPause({ reason: "goal", marketKey, pricedSinceEvent, now: goalAt });
  for (const key of ["match_winner", "double_chance", "goals_2_5", "btts", "correct_score", "draw_no_bet", "home_goals_1_5", "result_btts"]) {
    const pause = goal(key, true);
    assert.ok(pause, `${key} pauses`);
    assert.equal(pause.until.getTime() - goalAt.getTime(), 90_000, "the fallback");
    assert.equal(pause.reopenFrom.getTime() - goalAt.getTime(), 15_000, "15 s at least");
  }
  // A goal or a red card leaves the markets it doesn't change open, priced or not. Corners stay open on a red card.
  assert.equal(goal("cards_3_5", true), null);
  assert.equal(goal("cards_3_5", false), null, "a goal leaves cards open");
  assert.equal(goal("corners_9_5", false), null, "a goal leaves corners open");
  assert.ok(eventPause({ reason: "red", marketKey: "cards_3_5", pricedSinceEvent: false, now: goalAt }));
  assert.equal(eventPause({ reason: "red", marketKey: "corners_9_5", pricedSinceEvent: false, now: goalAt }), null, "a red card leaves corners open");
  assert.equal(eventPause({ reason: "red", marketKey: "corners_9_5", pricedSinceEvent: true, now: goalAt }), null);
  assert.equal(eventPause({ reason: "swing", marketKey: "goals_2_5", pricedSinceEvent: true, now: goalAt }).until.getTime() - goalAt.getTime(), 30_000);
});

test("a paused market reopens on fresh prices after the event, never before 15 s; otherwise the fallback", () => {
  const goalAt = new Date("2026-01-01T12:00:00Z");
  const at = (seconds) => new Date(goalAt.getTime() + seconds * 1000);
  const pause = eventPause({ reason: "goal", marketKey: "match_winner", pricedSinceEvent: true, now: goalAt });
  const fresh = { stopped: false, scoreKnown: true, priced: true, bookmakerUpdate: at(9), movedAt: at(10) };
  // (a) fresh prices 10 s after the goal: it reopens at 15 s
  assert.equal(freshUntil(pause, fresh, at(10)).getTime(), at(15).getTime());
  assert.equal(freshUntil(pause, fresh, at(20)).getTime(), at(20).getTime(), "fresh prices later: now");
  // (b) no fresh prices: the fallback stands
  assert.equal(freshUntil(pause, { ...fresh, bookmakerUpdate: at(-2), movedAt: at(10) }, at(10)).getTime(), at(15).getTime(), "this feed's update time stays old; prices that moved still reopen");
  assert.equal(freshUntil(pause, { ...fresh, bookmakerUpdate: at(-2), movedAt: at(-2) }, at(10)), null, "neither the bookmaker time nor the prices moved");
  assert.equal(freshUntil(pause, { ...fresh, movedAt: at(-30) }, at(10)).getTime(), at(15).getTime(), "a later bookmaker time reopens even before its own prices move");
  assert.equal(freshUntil(pause, { ...fresh, bookmakerUpdate: goalAt, movedAt: goalAt }, at(10)).getTime(), at(15).getTime(), "prices written with the goal differ from the ones before it, so it reopens at 15 s");
  assert.equal(freshUntil(pause, { ...fresh, bookmakerUpdate: goalAt, movedAt: goalAt }, at(20)).getTime(), at(20).getTime(), "the same prices still qualify after the minimum, before 90 s");
  assert.equal(freshUntil(pause, { ...fresh, scoreKnown: false }, at(10)), null, "the score isn't the latest");
  assert.equal(freshUntil(pause, { ...fresh, stopped: true }, at(10)), null, "blocked");
  assert.equal(freshUntil(pause, { ...fresh, priced: false }, at(10)), null, "not priced");
  assert.equal(freshUntil(pause, fresh, at(95)), null, "already over");
  assert.equal(marketPause({ liveSuspended: false, livePausedUntil: pause.until, livePauseReason: "goal" }, at(89)), "goal");
  assert.equal(marketPause({ liveSuspended: false, livePausedUntil: pause.until, livePauseReason: "goal" }, at(90)), null);
  // A goal pause cannot be pushed past 90 s, and a bookmaker block during it is named without ending our pause early.
  assert.equal(marketPause({ liveSuspended: false, livePausedAt: goalAt, livePausedUntil: at(180), livePauseReason: "goal" }, at(89)), "goal");
  assert.equal(marketPause({ liveSuspended: false, livePausedAt: goalAt, livePausedUntil: at(180), livePauseReason: "goal" }, at(90)), null, "90 s is the end, even if a later reading wrote a later until");
  assert.equal(freshBlocker(pause, { ...fresh, stopped: true }, at(20)), "bookmaker blocking the match");
  assert.equal(marketPause({ liveSuspended: false, livePausedAt: goalAt, livePausedUntil: pause.until, livePauseReason: "goal" }, at(20)), "goal", "our pause is still running while the bookmaker blocks");
  const priced = { livePausedAt: goalAt, livePausedUntil: at(15), liveReopenFrom: at(15), livePauseReason: "goal", name: "Match winner", sortOrder: 0 };
  assert.equal(pauseSummary([priced], at(10)).exact, true, "fresh prices: the banner says Back in, not Back within");

  // A jump or a reopen during a goal's pause is the market catching up, not a new event.
  // A second goal during the same pause does not stretch it past the first fallback.
  assert.equal(mergePause(pause, eventPause({ reason: "swing", marketKey: "match_winner", pricedSinceEvent: true, now: at(8) }), at(8)), pause);
  const second = mergePause(pause, eventPause({ reason: "goal", marketKey: "match_winner", pricedSinceEvent: true, now: at(40) }), at(40));
  assert.equal(second.pausedAt.getTime(), at(40).getTime());
  assert.equal(second.reopenFrom.getTime(), at(55).getTime());
  assert.equal(second.until.getTime(), at(130).getTime(), "a second goal starts its own 90 s, not longer");
  assert.equal(marketPause({ liveSuspended: false, livePausedAt: goalAt, livePausedUntil: at(130), livePauseReason: "goal" }, at(91)), null, "past the fallback from when it started, even if the stored end is later");
  assert.equal(marketPause({ liveSuspended: false, livePausedAt: goalAt, livePausedUntil: at(90), livePauseReason: "goal" }, at(89)), "goal");
});

test("a market the feed hasn't priced live for 5 minutes is stale; the banner lists what's paused", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const event = { status: "LIVE", startsAt: new Date("2026-01-01T11:00:00Z"), period: "2H" };
  // (e)
  assert.equal(marketStale(event, { liveSuspended: true, liveQuotedAt: new Date(now.getTime() - 6 * 60_000) }, now), true);
  assert.equal(marketStale(event, { liveSuspended: false, liveQuotedAt: new Date(now.getTime() - 60_000) }, now), false);
  assert.equal(marketStale(event, { liveSuspended: true, liveQuotedAt: null }, now, false), true, "never priced live since kick-off");
  assert.equal(marketStale({ ...event, period: "HT" }, { liveSuspended: true, liveQuotedAt: new Date(now.getTime() - 6 * 60_000) }, now), false, "not at half-time");
  assert.equal(liveSideUnpriced("corners_9_5", false), true, "corners the feed never prices leave the board");
  assert.equal(liveSideUnpriced("cards_3_5", false), true);
  assert.equal(liveSideUnpriced("corners_9_5", true), false);
  assert.equal(liveSideUnpriced("match_winner", false), false);
  const summary = pauseSummary(
    [
      { name: "Match winner", sortOrder: 0, livePausedAt: now, livePausedUntil: new Date(now.getTime() + 90_000), liveReopenFrom: new Date(now.getTime() + 15_000), livePauseReason: "goal" },
      { name: "Total goals 2.5", sortOrder: 2, livePausedAt: now, livePausedUntil: new Date(now.getTime() + 15_000), liveReopenFrom: new Date(now.getTime() + 15_000), livePauseReason: "goal" },
      { name: "Total corners 9.5", sortOrder: 9, livePausedUntil: new Date(now.getTime() - 1) },
    ],
    now,
  );
  assert.deepEqual(summary, { reason: "goal", count: 2, markets: ["Match winner", "Total goals 2.5"], until: new Date(now.getTime() + 90_000).toISOString(), exact: false });
});

test("the same goal does not start another pause, and the banner ends with the last market", () => {
  const start = new Date("2026-01-01T12:00:00Z");
  const later = new Date(start.getTime() + 47_000);
  const active = { reason: "goal", until: new Date(start.getTime() + 90_000) };
  assert.equal(sameScorePause(active, "goal", "1:0", "1:0", later), true, "the same score 47 s later");
  assert.equal(sameScorePause(active, "ahead", "1:0", "1:0", later), true, "the timeline repeating that score");
  assert.equal(sameScorePause(active, "goal", "1:0", "2:0", later), false, "a new goal");
  assert.equal(sameScorePause(active, "red", "1:0", "1:0", later), false, "a red card is its own pause");
  assert.equal(sameScorePause({ reason: "goal", until: new Date(start.getTime() + 10_000) }, "goal", "1:0", "1:0", later), false, "after the pause has ended");

  const now = new Date("2026-01-01T12:00:10Z");
  const opened = { name: "Match winner", sortOrder: 0, livePausedAt: start, livePausedUntil: new Date(now.getTime() - 1_000), liveReopenFrom: new Date(start.getTime() + 15_000), livePauseReason: "goal" };
  assert.equal(pauseSummary([opened], now), null, "every market reopened: the banner ends");
  const waiting = { name: "Both teams to score", sortOrder: 2, livePausedAt: start, livePausedUntil: new Date(start.getTime() + 15_000), liveReopenFrom: new Date(start.getTime() + 15_000), livePauseReason: "goal" };
  const summary = pauseSummary([opened, waiting], now);
  assert.equal(summary.count, 1);
  assert.equal(summary.markets[0], "Both teams to score");
  assert.equal(summary.exact, true, "fresh prices: Back in, not Back within");
  assert.equal(summary.until, waiting.livePausedUntil.toISOString());
});

test("matches waiting for fresh prices and the most exposed are read on their own, within the minute's limit", () => {
  const now = 1_000_000;
  const picked = hotMatches(
    [
      { eventId: "quiet", exposure: 0, waiting: false, lastRead: null },
      { eventId: "big", exposure: 5_000, waiting: false, lastRead: now - 6_000 },
      { eventId: "small", exposure: 100, waiting: false, lastRead: now - 6_000 },
      { eventId: "paused", exposure: 0, waiting: true, lastRead: now - 7_000 },
      { eventId: "just read", exposure: 9_000, waiting: true, lastRead: now - 1_000 },
    ],
    now,
    2,
  );
  assert.deepEqual(picked.map((match) => match.eventId), ["paused", "big"]);
  assert.equal(minuteRoom(100, 450, 4), true);
  assert.equal(minuteRoom(90, 450, 4), false, "a fifth of the minute is kept back");
  assert.equal(minuteRoom(null, null, 4), true);
});

test("live odds carry the score and minute they were made for, and can be fetched for one match", async () => {
  const parsed = parseLiveOdds({ ...liveRaw(), teams: { home: { goals: 2 }, away: { goals: 1 } } }, "A", "B");
  assert.equal(parsed.homeScore, 2);
  assert.equal(parsed.awayScore, 1);
  assert.equal(parsed.elapsed, 62);
  assert.equal(parseLiveOdds(liveRaw(), "A", "B").homeScore, null, "no score sent");

  let now = Date.UTC(2026, 0, 1, 12);
  const client = new ApiFootballClient(mockFetchJson(() => now, now));
  now += 3 * 3_600_000;
  const all = await client.liveOdds();
  for (let step = 0; step < 48 && all.length === 0; step++) {
    now += 15 * 60_000;
    all.push(...(await client.liveOdds()));
  }
  assert.ok(all.length > 0, "the mock feed has a live match");
  const one = await client.liveOddsFor(String(all[0].fixture.id));
  assert.equal(one.fixture.id, all[0].fixture.id);
  assert.equal(await client.liveOddsFor("999999"), null);
});

test("live prices ignore an Owner's fixed price and pause on a suspended market", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const event = { status: "LIVE", startsAt: new Date("2026-01-01T11:00:00Z"), suspended: false, hidden: false, liveStopped: false, liveOddsAt: now };
  const input = { event, market: { liveSuspended: false }, selection: { feedOdds: 2.0, liveOdds: 3.0, result: null }, baseMargin: 5, ownerMargin: 0, override: 2.15, now };
  assert.deepEqual(selectionQuote(input), { price: 2.85, bettable: true, live: true, suspended: false });
  assert.equal(selectionQuote({ ...input, market: { liveSuspended: true } }).bettable, false);
  assert.equal(selectionQuote({ ...input, selection: { ...input.selection, liveOdds: null } }).bettable, false);
  const prematch = selectionQuote({ ...input, event: { ...event, status: "UPCOMING", startsAt: new Date(now.getTime() + 60_000) } });
  assert.deepEqual(prematch, { price: 2.15, bettable: true, live: false, suspended: false });
});

test("the extra markets parse from a real API-Football response", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(new URL("./fixtures/api-football-odds.json", import.meta.url), "utf8"));
  const markets = parseMarkets(raw, "Home FC", "Away FC", 8);
  const keys = markets.map((m) => m.key);
  // The original four keep their keys and stay first.
  assert.deepEqual(keys.slice(0, 2), ["match_winner", "double_chance"]);
  assert.ok(keys.indexOf("goals_2_5") < keys.indexOf("goals_1_5"));
  for (const key of ["goals_0_5", "goals_3_5", "draw_no_bet", "h1_winner", "ht_ft", "correct_score", "odd_even", "h1_goals_0_5", "h2_goals_1_5"]) {
    assert.ok(keys.includes(key), `missing ${key}`);
  }
  assert.equal(new Set(keys).size, keys.length, "market keys are unique");
  for (const market of markets) {
    assert.ok(market.selections.length >= 2, `${market.key} has outcomes`);
    for (const s of market.selections) assert.ok(Number.isFinite(s.odds) && s.odds > 1, `${market.key}/${s.key} is priced`);
  }
  const ht = markets.find((m) => m.key === "ht_ft");
  assert.equal(ht.selections.length, 9);
  assert.equal(ht.selections.find((s) => s.key === "home_draw").name, "Home FC / Draw");
  const corners = markets.filter((m) => m.key.startsWith("corners_") && m.key !== "corners_1x2" && m.key !== "corners_range");
  assert.ok(corners.length >= 1 && corners.length <= 3, "up to three corner lines");
  assert.ok(corners.every((m) => /^corners_\d+_5$/.test(m.key)), "only half lines, so no pushes");
  assert.match(corners[0].name, /^Total corners \d+\.5$/);
  const cs = markets.find((m) => m.key === "correct_score");
  assert.ok(cs.selections.every((s) => /^\d-\d$/.test(s.key)));
});

test("the combo, team, half and goal-event markets parse from a real API-Football answer", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(new URL("./fixtures/api-football-odds-wide.json", import.meta.url), "utf8")).response[0];
  const markets = parseMarkets(raw, "Home FC", "Away FC", 8);
  const byKey = new Map(markets.map((m) => [m.key, m]));
  for (const key of [
    "result_goals_2_5", "goals_btts_2_5", "home_exact_goals", "away_exact_goals", "goal_range", "winning_margin",
    "h1_exact_goals", "h2_exact_goals", "h1_odd_even", "h2_odd_even", "home_odd_even", "away_odd_even",
    "score_both_halves", "home_highest_half", "away_highest_half", "corners_1x2", "corners_range",
    "first_team_score", "last_team_score", "win_from_behind", "scorer_anytime", "scorer_first", "scorer_last",
  ]) {
    assert.ok(byKey.has(key), `missing ${key}`);
  }
  assert.deepEqual(byKey.get("result_goals_2_5").selections.map((s) => s.key), ["home_over", "home_under", "draw_over", "draw_under", "away_over", "away_under"]);
  assert.equal(byKey.get("result_goals_2_5").selections[0].name, "Home FC / Over 2.5");
  assert.deepEqual(byKey.get("goals_btts_2_5").selections.map((s) => s.name), ["Over 2.5 / Yes", "Over 2.5 / No", "Under 2.5 / Yes", "Under 2.5 / No"]);
  assert.deepEqual(byKey.get("home_exact_goals").selections.map((s) => s.key), ["0", "1", "2", "3+"]);
  assert.equal(byKey.get("winning_margin").selections.length, 10);
  assert.equal(byKey.get("winning_margin").selections.find((s) => s.key === "no_goal").name, "0–0");
  assert.deepEqual(byKey.get("corners_range").selections.map((s) => s.key), ["u6", "6-8", "9-11", "12-14", "o14"]);
  assert.deepEqual(byKey.get("first_team_score").selections.map((s) => s.key), ["home", "away", "none"]);
  for (const market of markets) for (const s of market.selections) assert.ok(Number.isFinite(s.odds) && s.odds > 1, `${market.key}/${s.key} is priced`);
  assert.equal(new Set(markets.map((m) => m.key)).size, markets.length, "market keys are unique");
});

test("Super Admin's league pick decides which new matches are synced; listed ones keep syncing", async () => {
  const saved = process.env.ODDS_FEED_MOCK;
  const key = process.env.API_FOOTBALL_KEY;
  process.env.ODDS_FEED_MOCK = "true";
  delete process.env.API_FOOTBALL_KEY;
  try {
    const { OddsSyncService } = await import("../dist/odds/odds-sync.service.js");
    let stored = null;
    const listed = new Set();
    const upserted = [];
    const prisma = {
      platformSettings: {
        findUnique: async () => ({ oddsCompetitions: stored }),
        upsert: async ({ update }) => void (stored = update.oddsCompetitions?.leagues ? update.oddsCompetitions : null),
      },
      event: { findMany: async ({ where }) => (where.externalId?.in ?? []).filter((id) => listed.has(id)).map((externalId) => ({ externalId })) },
    };
    const sync = new OddsSyncService(prisma);
    // The made-up kick-offs sit around "now"; pinned to midday so just after midnight none falls on yesterday's date.
    const midday = new Date();
    midday.setUTCHours(12, 0, 0, 0);
    sync.client = new ApiFootballClient(mockFetchJson(() => midday.getTime(), midday.getTime()));
    sync.upsertEvent = async (fixture) => (upserted.push(fixture.externalId), fixture.externalId);
    for (const name of ["upsertMarkets", "syncLive", "syncStats", "recordStatus"]) sync[name] = async () => 0;
    const run = async () => {
      upserted.length = 0;
      await sync.syncFull(true);
      return [...upserted].sort();
    };

    const everything = await run();
    assert.ok(everything.length >= 6, "mock mode takes every made-up league until Super Admin picks");

    await sync.saveChoice({ leagues: [9002], countries: [] }); // Premier League only
    assert.deepEqual(await run(), ["900004", "900005"]);

    listed.add("900006"); // Inter v Juventus is already on the board
    assert.deepEqual(await run(), ["900004", "900005", "900006"], "a listed match from a league turned off keeps its prices fresh");

    await sync.saveChoice({ leagues: [], countries: ["albania"] });
    assert.ok((await run()).includes("900003"), "a whole country is matched case-insensitively");

    await sync.saveChoice(null);
    assert.equal(stored, null);
    assert.deepEqual((await sync.savedChoice()), null);
    assert.deepEqual(await run(), everything, "reset goes back to the defaults");

    const leagues = await sync.availableLeagues();
    assert.ok(leagues.some((l) => l.id === 9002 && l.name === "Premier League" && l.country === "England" && l.type === "League"));
  } finally {
    if (saved === undefined) delete process.env.ODDS_FEED_MOCK;
    else process.env.ODDS_FEED_MOCK = saved;
    if (key !== undefined) process.env.API_FOOTBALL_KEY = key;
  }
});

test("a live bet's match is checked with the feed itself, and a goal found there pauses it", async () => {
  const { OddsSyncService } = await import("../dist/odds/odds-sync.service.js");
  const saved = { id: "e1", externalId: "7", homeTeam: "A", awayTeam: "B", name: "A v B", homeScore: 0, awayScore: 0, liveStopped: false, liveCooldownUntil: null, liveCooldownReason: null };
  const updates = [];
  // Live readings save only what changed: the match's markets are read, new ones created, changed prices updated in one statement.
  const tx = {
    selection: { createMany: async () => ({ count: 0 }) },
    market: { findMany: async () => [], create: async () => ({ id: "m1" }), updateMany: async () => ({}) },
    $executeRaw: async () => 0,
  };
  const prisma = {
    event: {
      findMany: async () => [saved],
      findUniqueOrThrow: async () => saved,
      update: async ({ data }) => updates.push(data),
    },
    // The match-result prices just before the goal are kept with it.
    selection: { findMany: async () => [{ key: "home", liveOdds: 2.1 }, { key: "draw", liveOdds: 3.2 }, { key: "away", liveOdds: 3.6 }] },
    goalSeen: { createMany: async ({ data }) => (goals.push(...data), { count: data.length }) },
    market: { findMany: async () => [{ id: "m1", key: "match_winner", liveSuspended: false, livePausedAt: null, livePausedUntil: null, liveReopenFrom: null, livePauseReason: null, liveMovedAt: null, liveQuotedAt: null }], updateMany: async ({ data }) => marketUpdates.push(data) },
    livePause: { create: async () => ({}), updateMany: async () => ({}) },
    $transaction: async (fn) => fn(tx),
  };
  const goals = [];
  const marketUpdates = [];
  const service = new OddsSyncService(prisma);
  let calls = 0;
  let answer = { ...liveRaw(), fixture: { id: 7, status: { elapsed: 63 } }, teams: { home: { goals: 1 }, away: { goals: 0 } } };
  service.client = new ApiFootballClient(async (path, params) => {
    calls++;
    assert.equal(path, "/odds/live");
    assert.equal(params.fixture, "7", "asks about that one match");
    return { response: answer ? [answer] : [] };
  });

  // Two bets at the same moment share one request.
  await Promise.all([service.verifyLive(["e1"]), service.verifyLive(["e1", "e1"])]);
  assert.equal(calls, 1);
  const last = updates.at(-1);
  assert.equal(last.homeScore, 1);
  assert.equal(last.elapsed, 63);
  assert.equal(last.liveCooldownReason, "goal", "the match keeps the goal as its latest pause");
  assert.ok(last.liveCooldownUntil > new Date());
  assert.equal(marketUpdates.at(-1).livePauseReason, "goal", "the goal the feed knows about pauses the goal markets");
  assert.ok(marketUpdates.at(-1).livePausedUntil > new Date());
  // The site saw it then, with who scored and the prices from before it.
  assert.equal(goals.length, 1);
  assert.deepEqual(goals[0].beforeGoal, { side: "home", home: 2.1, draw: 3.2, away: 3.6 });
  assert.equal(goals[0].source, "odds");

  // A response with no odds is not the bookmaker blocking the match. That flag comes only from status.stopped or status.blocked.
  service.verifying.clear();
  answer = null;
  const written = updates.length;
  await service.verifyLive(["e1"]);
  assert.equal(updates.length, written);
});

test("a live cards bet fetches the match's events right then; bets at the same moment share the request, and a match the feed left out fails", async () => {
  const { OddsSyncService } = await import("../dist/odds/odds-sync.service.js");
  const updates = [];
  const prisma = { event: { findMany: async () => [{ id: "e1", externalId: "7" }], update: async ({ where, data }) => updates.push({ id: where.id, ...data }) } };
  const service = new OddsSyncService(prisma);
  service.mode = "api-football";
  let calls = 0;
  let send = true;
  const card = (minute, detail) => ({ time: { elapsed: minute, extra: null }, team: { id: 10, name: "A" }, player: { id: 1, name: "P" }, assist: { id: null, name: null }, type: "Card", detail });
  service.client = new ApiFootballClient(async (path, params) => {
    calls++;
    assert.equal(path, "/fixtures");
    assert.equal(params.ids, "7");
    return { response: send ? [{ fixture: { id: 7 }, teams: { home: { id: 10, name: "A" }, away: { id: 20, name: "B" } }, events: [card(12, "Yellow Card"), card(40, "Second Yellow card")] }] : [] };
  });
  const [marks] = await Promise.all([service.readMarks(["e1"]), service.readMarks(["e1"])]);
  assert.equal(calls, 1);
  assert.deepEqual(updates.at(-1).matchCentre.moments.map((moment) => moment.kind), ["red", "yellow"]);
  // The feed's record of the match: two cards, one of them red, the latest the 40th minute's.
  const mark = marks.get("e1");
  assert.equal(mark.cards, 2);
  assert.equal(mark.reds, 1);
  assert.equal(mark.goals, 0);
  assert.equal(mark.last, "card home 40'");
  service.verifyingCards.clear();
  send = false;
  await assert.rejects(service.readMarks(["e1"]), /didn't send every match/);
  // Nothing to fetch without live picks.
  await service.readMarks([]);
  assert.equal(calls, 2);
});

test("after a goal, a paused market reopens once a later reading is fresh for it", async () => {
  const { OddsSyncService } = await import("../dist/odds/odds-sync.service.js");
  const run = async (secondsSinceGoal, goals = { home: 1, away: 0 }, update = new Date(Date.now() - 2_000).toISOString(), movedSecondsAgo = 3) => {
    const goalAt = new Date(Date.now() - secondsSinceGoal * 1000);
    const saved = { id: "e1", externalId: "7", homeTeam: "A", awayTeam: "B", name: "A v B", homeScore: 1, awayScore: 0, liveStopped: false, liveCooldownUntil: new Date(goalAt.getTime() + 90_000), liveCooldownReason: "goal", liveScoreAhead: null, status: "LIVE", startsAt: new Date(Date.now() - 40 * 60_000), period: "1H" };
    const market = {
      id: "m1",
      key: "match_winner",
      liveSuspended: false,
      livePausedAt: goalAt,
      livePausedUntil: new Date(goalAt.getTime() + 90_000),
      liveReopenFrom: new Date(goalAt.getTime() + 15_000),
      livePauseReason: "goal",
      liveMovedAt: new Date(Date.now() - movedSecondsAgo * 1000),
      liveQuotedAt: new Date(),
    };
    const updates = [];
    const tx = { selection: { createMany: async () => ({ count: 0 }) }, market: { findMany: async () => [], create: async () => ({ id: "m1" }), updateMany: async () => ({}) }, $executeRaw: async () => 0 };
    const prisma = {
      event: { findMany: async () => [saved], findUniqueOrThrow: async () => saved, update: async ({ data }) => updates.push(data) },
      selection: { findMany: async () => [] },
      goalSeen: { createMany: async ({ data }) => ({ count: data.length }) },
      market: { findMany: async () => [market], updateMany: async ({ data }) => updates.push({ market: data }) },
      livePause: { create: async () => ({}), updateMany: async () => ({}) },
      $transaction: async (fn) => fn(tx),
    };
    const service = new OddsSyncService(prisma);
    service.client = new ApiFootballClient(async () => ({ response: [{ ...liveRaw(), update, fixture: { id: 7, status: { elapsed: 34 } }, teams: { home: { goals: goals.home }, away: { goals: goals.away } } }] }));
    await service.verifyLive(["e1"]);
    return { goalAt, market: updates.find((row) => row.market)?.market ?? null, event: updates.at(-1) };
  };
  const reopened = await run(40);
  assert.ok(reopened.market.livePausedUntil <= new Date(), "40 seconds after the goal, fresh prices reopen it now");
  assert.ok(reopened.event.liveCooldownUntil <= new Date(), "and the match's pause ends with its main market");
  const soon = await run(10);
  assert.equal(soon.market.livePausedUntil.getTime(), soon.goalAt.getTime() + 15_000, "10 seconds in, fresh prices: it reopens at 15 s");
  const another = await run(40, { home: 2, away: 0 });
  assert.ok(another.market.livePausedAt > another.goalAt, "another goal starts a new pause");
  assert.ok(another.market.livePausedUntil.getTime() > Date.now() + 80_000);
  // API-Football often keeps an old update time after it has sent new prices, or a new time before a market's own price moves. Either one reopens.
  assert.ok((await run(40, { home: 1, away: 0 }, new Date(Date.now() - 60_000).toISOString())).market.livePausedUntil <= new Date(), "prices that moved reopen even when the update time is old");
  assert.ok((await run(40, { home: 1, away: 0 }, new Date().toISOString(), 60)).market.livePausedUntil <= new Date(), "a later update time reopens even when this market's price hasn't moved");
  assert.equal((await run(40, { home: 1, away: 0 }, new Date(Date.now() - 60_000).toISOString(), 60)).market, null, "old update time and prices that haven't moved: stay paused");
});

test("an over that the live count has already reached is dead, and a stale count holds the market", () => {
  const now = new Date("2026-10-26T19:40:00Z");
  const fresh = new Date(now.getTime() - 20_000);
  const old = new Date(now.getTime() - 90_000);
  const centre = { corners: [2, 1], yellow: [1, 0], red: [0, 0] };
  assert.equal(countLineDead("corners_2_5", "over", 3), true, "3 corners already covers over 2.5, which is 3 or more");
  assert.equal(countLineDead("corners_2_5", "under", 3), true, "under 2.5 is already broken");
  assert.equal(countLineDead("corners_8_5", "over", 8), false, "8 corners still leaves over 8.5 open");
  assert.equal(countLineDead("corners_8_5", "under", 9), true);
  assert.equal(countSelectionDead(centre, fresh, "corners_2_5", "over", now), true);
  assert.equal(countSelectionDead(centre, fresh, "corners_8_5", "over", now), false);
  assert.equal(countSelectionDead(centre, fresh, "home_corners_1_5", "over", now), true, "the home side already has 2");
  assert.equal(countSelectionDead({ yellow: [2, 1], red: [1, 0] }, fresh, "cards_3_5", "over", now), true, "4 cards already covers over 3.5");
  assert.equal(countStatsStale(centre, old, "corners_9_5", now), true, "statistics older than a minute hold corners");
  assert.equal(countStatsStale(null, fresh, "cards_2_5", now), true, "no card count holds cards");
  assert.equal(countStatsStale(centre, fresh, "corners_9_5", now), false);
  assert.equal(countStatsStale(centre, old, "match_winner", now), false, "goals markets are not held for a corner count");
});

test("a corner pauses corners only, a yellow pauses cards only, and a red pauses goals and cards", () => {
  const now = new Date("2026-10-26T19:43:00Z");
  const pause = (reason, marketKey) => eventPause({ reason, marketKey, pricedSinceEvent: false, now });
  assert.ok(pause("corner", "corners_9_5"));
  assert.equal(pause("corner", "match_winner"), null);
  assert.equal(pause("corner", "cards_3_5"), null);
  assert.equal(pause("corner", "corners_9_5").until.getTime() - now.getTime(), 90_000);
  assert.equal(pause("corner", "corners_9_5").reopenFrom.getTime() - now.getTime(), 15_000);
  assert.ok(pause("yellow", "cards_3_5"));
  assert.equal(pause("yellow", "corners_9_5"), null);
  assert.equal(pause("yellow", "match_winner"), null);
  assert.ok(pause("red", "match_winner"));
  assert.ok(pause("red", "cards_3_5"));
  assert.equal(pause("red", "corners_9_5"), null);
  assert.equal(pause("goal", "corners_9_5"), null, "a goal leaves corners open");
});

test("a live bet is never taken at a price other than the slip price", () => {
  assert.equal(sameLivePrice(1.57, 1.61), false, "1.57 on the slip is not 1.61");
  assert.equal(sameLivePrice(1.91, 2.0), false, "a higher live price is not taken either");
  assert.equal(sameLivePrice(1.57, 1.57), true);
  assert.equal(sameLivePrice(2.1, 2.1), true);
});

test("a goal seen before its minute ended still counts toward its competition's lag", () => {
  assert.equal(lagSample({ lagMinMs: -10_000, lagMs: 50_000, provider: "api-football", league: "Superliga" }), 50_000);
  assert.equal(lagSample({ lagMinMs: 40_000, lagMs: 70_000, provider: "api-football", league: "Superliga" }), 40_000, "a usable least-delay stands");
  assert.equal(lagSample({ lagMinMs: -10_000, lagMs: 20 * 60_000, provider: "api-football", league: "Superliga" }), null, "a mismatched minute stays out");
});

test("an Owner's own price can't go more than 10% above the feed price", () => {
  assert.equal(priceCeiling(1.5), 1.65);
  assert.equal(priceCeiling(2.1), 2.31);
  assert.equal(priceCeiling(950), 1000, "never above the highest price there is");
  // A typo (150 for 1.50) is held to the ceiling, and so is a price set before the feed price dropped.
  assert.equal(teamPrice({ feedOdds: 1.5, baseMargin: 5, ownerMargin: 0, override: 150 }), 1.65);
  assert.equal(teamPrice({ feedOdds: 1.5, baseMargin: 5, ownerMargin: 0, override: 1.4 }), 1.4, "a price below the feed stands");
});
