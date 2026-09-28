// Run with `npm test --workspace apps/api` (builds first). Covers the pure
// odds code: pricing math and API-Football parsing against the mock feed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiFootballClient, eventStatus, parseLiveOdds, parseMarkets } from "../dist/odds/api-football.js";
import { mockFetchJson } from "../dist/odds/mock-feed.js";
import { applyMargin, eventOpen, selectionQuote, teamMargin, teamPrice } from "../dist/odds/pricing.js";

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
  assert.deepEqual(parsed.markets.map((m) => m.key), ["match_winner", "goals_2_5"]);
  const winner = parsed.markets[0];
  assert.equal(winner.suspended, false);
  assert.deepEqual(winner.selections.map((s) => [s.name, s.odds]), [["Tirana", 1.4], ["Draw", 4.2], ["Partizani", 8]]);
  const goals = parsed.markets[1];
  assert.equal(goals.suspended, true, "Under 2.5 is suspended");
  assert.equal(goals.selections[0].odds, 2.1, "only the 2.5 line counts");
  assert.equal(parseLiveOdds(liveRaw({ status: { stopped: false, blocked: true } }), "A", "B").stopped, true);
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

test("live prices ignore an Owner's fixed price and pause on a suspended market", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const event = { status: "LIVE", startsAt: new Date("2026-01-01T11:00:00Z"), suspended: false, hidden: false, liveStopped: false, liveOddsAt: now };
  const input = { event, market: { liveSuspended: false }, selection: { feedOdds: 2.0, liveOdds: 3.0, result: null }, baseMargin: 5, ownerMargin: 0, override: 2.5, now };
  assert.deepEqual(selectionQuote(input), { price: 2.85, bettable: true, live: true, suspended: false });
  assert.equal(selectionQuote({ ...input, market: { liveSuspended: true } }).bettable, false);
  assert.equal(selectionQuote({ ...input, selection: { ...input.selection, liveOdds: null } }).bettable, false);
  const prematch = selectionQuote({ ...input, event: { ...event, status: "UPCOMING", startsAt: new Date(now.getTime() + 60_000) } });
  assert.deepEqual(prematch, { price: 2.5, bettable: true, live: false, suspended: false });
});
