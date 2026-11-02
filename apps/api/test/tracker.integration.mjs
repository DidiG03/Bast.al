// The live match tracker end to end against a real Postgres: importing
// SportScore fixtures maps our matches; a live football match with a
// confident mapping gets the embed; anything else (switch off, no embed
// address, not live, not football, no confident match) gets { show: false };
// a manual mapping wins. Empties tables, so only runs on a "_test" database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { TrackerService } = require("../dist/tracker/tracker.service.js");

const prisma = new PrismaClient();
const tracker = new TrackerService(prisma);
const player = { id: "p", role: "PLAYER", parentId: null, username: "p" };
const kickoff = new Date(Date.now() - 30 * 60_000);
let united, women, tennis, upcoming;

const event = (data) => prisma.event.create({ data: { sport: "football", league: "Premier League", status: "LIVE", startsAt: kickoff, provider: "api-football", ...data } });

test("setup", async () => {
  await prisma.$executeRawUnsafe("DELETE FROM tracker_fixtures");
  for (const table of ["live_pauses", "goals_seen", "settlement_entries", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\""]) await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  united = await event({ name: "Manchester United vs Wolverhampton Wanderers", homeTeam: "Manchester United", awayTeam: "Wolverhampton Wanderers" });
  women = await event({ name: "Arsenal W vs Chelsea W", homeTeam: "Arsenal W", awayTeam: "Chelsea W" });
  tennis = await event({ sport: "tennis", name: "A vs B", homeTeam: "A", awayTeam: "B" });
  upcoming = await event({ status: "UPCOMING", name: "Leeds vs Everton", homeTeam: "Leeds", awayTeam: "Everton" });
  process.env.LIVE_TRACKER_ENABLED = "true";
  process.env.SPORTSCORE_EMBED_URL = "https://sportscore.com/embed/{id}?lang={lang}&theme={theme}";
  process.env.NODE_ENV = "test";
});

test("import maps the matches it is sure about", async () => {
  const result = await tracker.importFixtures([
    { id: "ss1", home: "Manchester Utd", away: "Wolverhampton", kickoff: new Date(kickoff.getTime() + 5 * 60_000).toISOString() },
    { id: "ss2", home: "Arsenal", away: "Chelsea", kickoff: kickoff.toISOString() },
    { id: "ss3", home: "Leeds United", away: "Everton", kickoff: kickoff.toISOString() },
  ]);
  assert.equal(result.imported, 3);
  const rows = Object.fromEntries((await prisma.trackerMapping.findMany()).map((row) => [row.eventId, row]));
  assert.equal(rows[united.id].externalId, "ss1");
  assert.equal(rows[women.id].externalId, null, "the men's fixture isn't the women's match");
  assert.equal(rows[women.id].method, "none");
  assert.equal(rows[upcoming.id].externalId, "ss3");
});

test("a live football match with a confident mapping gets the embed and the attribution link", async () => {
  assert.deepEqual(await tracker.forEvent(player, united.id, "sq", "dark"), { show: true, provider: "sportscore", src: "https://sportscore.com/embed/ss1?lang=sq&theme=dark", attributionUrl: "https://sportscore.com/" });
});

test("hidden otherwise", async () => {
  assert.deepEqual(await tracker.forEvent(player, women.id, "en", "light"), { show: false }, "no confident match");
  assert.deepEqual(await tracker.forEvent(player, tennis.id, "en", "light"), { show: false }, "not football");
  assert.deepEqual(await tracker.forEvent(player, upcoming.id, "en", "light"), { show: false }, "not live");
  process.env.LIVE_TRACKER_ENABLED = "false";
  assert.deepEqual(await tracker.forEvent(player, united.id, "en", "light"), { show: false }, "switched off");
  process.env.LIVE_TRACKER_ENABLED = "true";
  const saved = process.env.SPORTSCORE_EMBED_URL;
  process.env.SPORTSCORE_EMBED_URL = "https://elsewhere.example/{id}";
  assert.deepEqual(await tracker.forEvent(player, united.id, "en", "light"), { show: false }, "an embed address off sportscore.com");
  process.env.SPORTSCORE_EMBED_URL = saved;
  await assert.rejects(tracker.forEvent(player, "nope", "en", "light"), /Match not found/);
});

test("manual mapping wins, and null keeps a match without a tracker", async () => {
  await tracker.setManual(women.id, "ss-w");
  assert.equal((await tracker.forEvent(player, women.id, "en", "light")).src, "https://sportscore.com/embed/ss-w?lang=en&theme=light");
  await tracker.setManual(united.id, null);
  assert.deepEqual(await tracker.forEvent(player, united.id, "en", "light"), { show: false });
  await tracker.importFixtures([{ id: "ss1", home: "Manchester Utd", away: "Wolverhampton", kickoff: kickoff.toISOString() }]);
  assert.equal((await prisma.trackerMapping.findUnique({ where: { eventId: united.id } })).method, "manual", "an import doesn't undo a manual choice");
  await tracker.clearManual(united.id);
  assert.equal((await tracker.forEvent(player, united.id, "en", "light")).show, true, "back to automatic");
});

test("sync: reads SportScore's live list only when a live football match still needs a tracker, and maps it", async () => {
  await prisma.trackerMapping.deleteMany();
  await prisma.trackerFixture.deleteMany();
  const calls = [];
  const body = { matches: [{ home: "Manchester Utd", away: "Wolverhampton", status: "live", time: kickoff.toISOString(), url: "/football/match/manchester-united-vs-wolverhampton/u1x/" }] };
  const feed = new TrackerService(prisma, async (url) => (calls.push(url), { ok: true, json: async () => body }));
  process.env.LIVE_TRACKER_ENABLED = "false";
  assert.equal(await feed.sync(), null, "switched off: no call");
  assert.equal(calls.length, 0);
  process.env.LIVE_TRACKER_ENABLED = "true";
  const result = await feed.sync(new Date("2026-11-02T18:00:00Z"));
  assert.equal(calls.length, 1);
  assert.equal(result.fetched, 1);
  assert.equal((await prisma.trackerMapping.findUnique({ where: { eventId: united.id } })).externalId, "manchester-united-vs-wolverhampton");
  // Just after midnight UTC it also reads yesterday's list.
  await feed.sync(new Date("2026-11-03T00:30:00Z"));
  assert.deepEqual(calls.slice(1).map((url) => new URL(url).searchParams.get("date")), ["2026-11-03", "2026-11-02"]);
  // Every live football match settled (mapped, or kept without one by hand): no more calls.
  await tracker.setManual(women.id, null);
  calls.length = 0;
  assert.equal(await feed.sync(), null);
  assert.equal(calls.length, 0);
  // SportScore failing is only logged.
  await tracker.clearManual(women.id);
  const down = new TrackerService(prisma, async () => ({ ok: false, status: 503 }));
  assert.equal(await down.sync(), null);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
