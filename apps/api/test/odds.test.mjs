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
  const corners = markets.filter((m) => m.key.startsWith("corners_"));
  assert.ok(corners.length >= 1 && corners.length <= 3, "up to three corner lines");
  assert.ok(corners.every((m) => /^corners_\d+_5$/.test(m.key)), "only half lines, so no pushes");
  assert.match(corners[0].name, /^Total corners \d+\.5$/);
  const cs = markets.find((m) => m.key === "correct_score");
  assert.ok(cs.selections.every((s) => /^\d-\d$/.test(s.key)));
});
