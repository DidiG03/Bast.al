// Run with `npm test --workspace apps/api` (builds first). Covers the pure
// odds code: pricing math and API-Football parsing against the mock feed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ApiFootballClient, eventStatus, parseLiveOdds, parseMarkets } from "../dist/odds/api-football.js";
import { mockFetchJson } from "../dist/odds/mock-feed.js";
import { bigSwing, cooldownFor, laterCooldown } from "../dist/odds/live-guard.js";
import { applyMargin, eventOpen, livePause, selectionQuote, teamMargin, teamPrice } from "../dist/odds/pricing.js";

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
    ["match_winner", "double_chance", "draw_no_bet", "odd_even", "h2_btts"],
  );
  // Everything in this answer is suspended: fixed markets come back off the board; lines and correct score, with nothing priced, are left out, which suspends them.
  assert.ok(stopped.markets.every((m) => m.suspended));

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

test("live betting pauses after a goal, a price jump or a reopen, and in the last minutes", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const base = { status: "LIVE", startsAt: new Date("2026-01-01T11:00:00Z"), suspended: false, hidden: false, liveStopped: false, liveOddsAt: new Date(now.getTime() - 5_000), elapsed: 60 };
  assert.equal(livePause(base, now), null);
  assert.equal(livePause({ ...base, liveCooldownUntil: new Date(now.getTime() + 30_000), liveCooldownReason: "goal" }, now), "goal");
  assert.equal(eventOpen({ ...base, liveCooldownUntil: new Date(now.getTime() + 30_000), liveCooldownReason: "goal" }, now), false);
  assert.equal(eventOpen({ ...base, liveCooldownUntil: new Date(now.getTime() - 1), liveCooldownReason: "goal" }, now), true, "the pause runs out");
  assert.equal(livePause({ ...base, elapsed: 89 }, now), "late");
  assert.equal(livePause({ ...base, elapsed: 88 }, now), null);
  assert.equal(livePause({ ...base, liveStopped: true }, now), "feed");
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

  assert.equal(bigSwing([2.0, 3.4, 4.0], [2.1, 3.3, 4.2]), false, "normal drift");
  assert.equal(bigSwing([2.0, 3.4, 4.0], [1.4, 3.8, 7.0]), true, "a red card or a penalty");
  assert.equal(bigSwing([1.8, 3.6, 26.0], [1.75, 3.7, 34.0]), false, "a long shot drifting isn't a jump");
  assert.equal(bigSwing([2.0, 3.3, 3.8], [3.2, 3.4, 2.4]), true, "a red card: 50% down to 31%");
  assert.equal(bigSwing([null, 3.4], [1.2, 3.4]), false, "an outcome coming back isn't a jump");
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
  const tx = {
    selection: { findMany: async () => [], upsert: async () => ({}), updateMany: async () => ({}) },
    market: { updateMany: async () => ({}), upsert: async () => ({ id: "m1" }) },
  };
  const prisma = {
    event: {
      findMany: async () => [saved],
      findUniqueOrThrow: async () => saved,
      update: async ({ data }) => updates.push(data),
    },
    $transaction: async (fn) => fn(tx),
  };
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
  assert.equal(last.liveCooldownReason, "goal", "the goal the feed knows about pauses the match");
  assert.ok(last.liveCooldownUntil > new Date());

  // Once the feed stops pricing the match, it's marked stopped.
  service.verifying.clear();
  answer = null;
  await service.verifyLive(["e1"]);
  assert.equal(updates.at(-1).liveStopped, true);
});
