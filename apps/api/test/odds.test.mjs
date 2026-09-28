// Run with `npm test --workspace apps/api` (builds first). Covers the pure
// odds code: pricing math and API-Football parsing against the mock feed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiFootballClient, eventStatus, parseMarkets } from "../dist/odds/api-football.js";
import { mockFetchJson } from "../dist/odds/mock-feed.js";
import { applyMargin, teamMargin, teamPrice } from "../dist/odds/pricing.js";

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
