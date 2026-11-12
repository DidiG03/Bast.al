
// Listing every match the bookmaker prices, whatever its league, against a
// real Postgres with a stand-in feed. Empties the tables it uses, so it only
// runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
delete process.env.API_FOOTBALL_KEY;
delete process.env.ODDS_FEED_MOCK;
delete process.env.API_FOOTBALL_LEAGUES;
delete process.env.API_FOOTBALL_ALL_PRICED;

const prisma = new PrismaClient();

const today = new Date().toISOString().slice(0, 10);
const kickOff = new Date(Date.now() + 3 * 3_600_000);
const fixture = (id, leagueId, league, country) => ({
  externalId: String(id), leagueId, season: 2026, league, country, leagueLogo: null, countryFlag: null,
  homeTeam: `Home ${id}`, awayTeam: `Away ${id}`, homeLogo: null, awayLogo: null, startsAt: kickOff, status: "UPCOMING",
  elapsed: null, period: "NS", homeScore: null, awayScore: null, result: null, halfTime: null, extraTime: false, extraTimeScore: null, penalties: null,
});
const bets = [
  { id: 1, name: "Match Winner", values: [{ value: "Home", odd: "2.10" }, { value: "Draw", odd: "3.20" }, { value: "Away", odd: "3.40" }] },
  { id: 2, name: "Corners Over Under", values: [{ value: "Over 9.5", odd: "1.90" }, { value: "Under 9.5", odd: "1.90" }] },
];
const raw = (id) => ({ fixture: { id }, bookmakers: [{ id: 8, name: "Bet365", bets }] });

// 39: on the synced list. 9001: not, but the feed has its events and statistics. 9002: not, and it doesn't.
// 9003: not, and the bookmaker doesn't price it.
const fixtures = [fixture(101, 39, "Premier League", "England"), fixture(102, 9001, "Covered Cup", "Iceland"), fixture(103, 9002, "Regional Women", "Brazil"), fixture(104, 9003, "Unpriced League", "Peru")];
const asked = [];
const client = {
  fixturesByDate: async (date) => (date === today ? fixtures : []),
  oddsByDate: async (date) => (asked.push(`date:${date}`), date === today ? [raw(101), raw(102), raw(103)] : []),
  odds: async (league, _season, date) => (asked.push(`league:${league}:${date}`), []),
  currentLeagues: async () => [
    { id: 39, name: "Premier League", type: "League", country: "England", coverage: { events: true, statistics: true } },
    { id: 9001, name: "Covered Cup", type: "Cup", country: "Iceland", coverage: { events: true, statistics: true } },
    { id: 9002, name: "Regional Women", type: "League", country: "Brazil", coverage: { events: false, statistics: false } },
  ],
};

test("every match the bookmaker prices is listed; a league without events or statistics gets only score markets", async () => {
  await prisma.event.deleteMany({ where: { provider: "api-football" } });
  const sync = new OddsSyncService(prisma);
  sync.client = client;
  sync.days = 1;
  for (const step of ["syncLive", "syncMatchCentres", "syncStats", "syncGoals", "syncLateChecks", "recheckResults", "recordStatus"]) sync[step] = async () => 0;
  await sync.syncFull(true);

  const events = await prisma.event.findMany({ where: { provider: "api-football" }, include: { markets: true }, orderBy: { externalId: "asc" } });
  assert.deepEqual(events.map((e) => e.externalId), ["101", "102", "103"], "the unpriced league stays off the board");
  const keys = (id) => events.find((e) => e.externalId === id).markets.map((m) => m.key).sort();
  assert.deepEqual(keys("101"), ["corners_9_5", "match_winner"], "a synced league keeps every market");
  assert.deepEqual(keys("102"), ["corners_9_5", "match_winner"], "a covered league keeps every market");
  assert.deepEqual(keys("103"), ["match_winner"], "a league without events or statistics only gets score markets");
  assert.equal(events.find((e) => e.externalId === "103").scoreOnly, true);
  assert.equal(events.find((e) => e.externalId === "101").scoreOnly, false);
  assert.deepEqual(asked, [`date:${today}`], "the day's pages replace the request a league");
});

test("API_FOOTBALL_ALL_PRICED=false keeps to the synced leagues", async () => {
  await prisma.event.deleteMany({ where: { provider: "api-football" } });
  process.env.API_FOOTBALL_ALL_PRICED = "false";
  asked.length = 0;
  const sync = new OddsSyncService(prisma);
  delete process.env.API_FOOTBALL_ALL_PRICED;
  sync.client = client;
  sync.days = 1;
  for (const step of ["syncLive", "syncMatchCentres", "syncStats", "syncGoals", "syncLateChecks", "recheckResults", "recordStatus"]) sync[step] = async () => 0;
  await sync.syncFull(true);
  const events = await prisma.event.findMany({ where: { provider: "api-football" }, select: { externalId: true } });
  assert.deepEqual(events.map((e) => e.externalId), ["101"]);
  assert.deepEqual(asked, [`league:39:${today}`]);
  await prisma.$disconnect();
});
