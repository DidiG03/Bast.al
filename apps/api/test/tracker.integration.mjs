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
const tracker = new TrackerService(prisma, async () => ({ ok: true, json: async () => ({ matches: [] }) }));
const player = { id: "p", role: "PLAYER", parentId: null, username: "p" };
const kickoff = new Date(Date.now() - 30 * 60_000);
let united, women, tennis, upcoming, later;

const event = (data) => prisma.event.create({ data: { sport: "football", league: "Premier League", status: "LIVE", startsAt: kickoff, provider: "api-football", ...data } });

test("setup", async () => {
  await prisma.$executeRawUnsafe("DELETE FROM tracker_fixtures");
  for (const table of ["live_pauses", "goals_seen", "settlement_entries", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\""]) await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  united = await event({ name: "Manchester United vs Wolverhampton Wanderers", homeTeam: "Manchester United", awayTeam: "Wolverhampton Wanderers" });
  women = await event({ name: "Arsenal W vs Chelsea W", homeTeam: "Arsenal W", awayTeam: "Chelsea W" });
  tennis = await event({ sport: "tennis", name: "A vs B", homeTeam: "A", awayTeam: "B" });
  upcoming = await event({ status: "UPCOMING", name: "Leeds vs Everton", homeTeam: "Leeds", awayTeam: "Everton" });
  later = await event({ status: "UPCOMING", name: "Fulham vs Brentford", homeTeam: "Fulham", awayTeam: "Brentford", startsAt: new Date(Date.now() + 3 * 86_400_000) });
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
  assert.deepEqual(await tracker.forEvent(player, women.id, "en", "light"), { show: false, reason: "unavailable" }, "no confident match: the page says the tracker isn't available");
  assert.deepEqual(await tracker.forEvent(player, tennis.id, "en", "light"), { show: false }, "not football");
  assert.equal((await tracker.forEvent(player, upcoming.id, "en", "light")).show, true, "not started yet, within a day: SportScore's kick-off card");
  assert.deepEqual(await tracker.forEvent(player, later.id, "en", "light"), { show: false }, "days away");
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
  // Off only when both the widget and the early goal signals (which also use the links) are off.
  process.env.LIVE_TRACKER_ENABLED = "false";
  process.env.EARLY_GOALS = "off";
  assert.equal(await feed.sync(), null, "switched off: no call");
  assert.equal(calls.length, 0);
  process.env.LIVE_TRACKER_ENABLED = "true";
  delete process.env.EARLY_GOALS;
  const result = await feed.sync(new Date("2026-11-02T18:00:00Z"));
  // The live list once; the women's match it doesn't have is then looked up by team.
  const listed = () => calls.filter((url) => new URL(url).searchParams.get("status") === "live");
  assert.equal(listed().length, 1);
  assert.equal(result.fetched, 1);
  assert.equal((await prisma.trackerMapping.findUnique({ where: { eventId: united.id } })).externalId, "manchester-united-vs-wolverhampton");
  // Just after midnight UTC it also reads yesterday's list.
  await feed.sync(new Date("2026-11-03T00:30:00Z"));
  assert.deepEqual(listed().slice(1).map((url) => new URL(url).searchParams.get("date")), ["2026-11-03", "2026-11-02"]);
  // Every live football match settled (mapped, or kept without one by hand): no more calls.
  await tracker.setManual(women.id, null);
  calls.length = 0;
  assert.equal(await feed.sync(), null);
  assert.equal(calls.length, 0);
  // SportScore failing is only logged.
  await tracker.clearManual(women.id);
  // A failed live list no longer ends the sync: the matches are looked up by team, which fail too here. Nothing throws.
  const down = new TrackerService(prisma, async () => ({ ok: false, status: 503 }));
  assert.deepEqual(await down.sync(), { fetched: 0, matched: 0 });
});

test("a match page before kick-off reads that day's not-started fixtures, once in a while", async () => {
  const calls = [];
  const kick = new Date(Date.now() + 2 * 3_600_000);
  const soon = await event({ status: "UPCOMING", name: "Roma vs Lazio", homeTeam: "AS Roma", awayTeam: "Lazio", startsAt: kick });
  const body = { matches: [{ home: "Roma", away: "Lazio", status: "upcoming", time: kick.toISOString(), url: "/football/match/lazio-vs-roma/r1z/" }] };
  const feed = new TrackerService(prisma, async (url) => (calls.push(url), { ok: true, json: async () => body }));
  const view = await feed.forEvent(player, soon.id, "en", "dark");
  assert.equal(view.src, "https://sportscore.com/embed/lazio-vs-roma?lang=en&theme=dark");
  assert.equal(new URL(calls[0]).searchParams.get("status"), "upcoming");
  assert.equal(new URL(calls[0]).searchParams.get("date"), kick.toISOString().slice(0, 10));
  // Another unpaired match the same day within 10 minutes: no second read.
  const other = await event({ status: "UPCOMING", name: "Genoa vs Torino", homeTeam: "Genoa", awayTeam: "Torino", startsAt: kick });
  assert.deepEqual(await feed.forEvent(player, other.id, "en", "dark"), { show: false, reason: "unavailable" }, "not found: the page says so");
  assert.equal(calls.filter((url) => new URL(url).searchParams.get("status") === "upcoming").length, 1, "the day's list isn't read again (only the teams are looked up)");
});

test("SportScore's live list empty while matches are live: the match is found by team, the tracker shows, links already made stay", async () => {
  await prisma.trackerMapping.deleteMany();
  await prisma.trackerFixture.deleteMany();
  const start = new Date(Date.now() - 80 * 60_000);
  const croatia = await event({ name: "Croatia vs Czech Republic", league: "UEFA Nations League", homeTeam: "Croatia", awayTeam: "Czech Republic", startsAt: start });
  const kept = await event({ name: "Spain vs England", league: "UEFA Nations League", homeTeam: "Spain", awayTeam: "England", startsAt: start });
  await prisma.trackerMapping.create({ data: { eventId: kept.id, externalId: "spain-vs-england", confidence: 1, method: "auto" } });
  const calls = [];
  const live = { home: "Croatia", away: "Czechia", home_score: "2", away_score: "1", status: "live", time: start.toISOString(), url: "/football/match/czechia-vs-croatia/23xmvkh6y1e2qg8/" };
  const feed = new TrackerService(prisma, async (url) => {
    calls.push(url);
    const query = new URL(url).searchParams;
    // status=live: empty, as on 15 Nov 2026. By team, Croatia's game is there (Czech Republic is "czechia" there).
    const team = query.get("team");
    const matches = query.get("status") === "live" ? [] : team === "croatia" ? [live] : [];
    return { ok: true, json: async () => ({ count: matches.length, matches }) };
  });
  // Other live matches in the test database are left to manual "none" so only these two count.
  for (const other of [united, women]) await tracker.setManual(other.id, null);
  const result = await feed.sync();
  assert.equal(result.fetched, 0, "the live list was empty");
  assert.ok(calls.some((url) => new URL(url).searchParams.get("team") === "croatia"), "looked up by team");
  assert.equal((await prisma.trackerMapping.findUnique({ where: { eventId: croatia.id } })).externalId, "czechia-vs-croatia");
  assert.equal((await prisma.trackerMapping.findUnique({ where: { eventId: kept.id } })).externalId, "spain-vs-england", "an empty live list unlinks nothing");
  const view = await feed.forEvent(player, croatia.id, "en", "dark");
  assert.equal(view.show, true);
  assert.equal(view.src, "https://sportscore.com/embed/czechia-vs-croatia?lang=en&theme=dark");
  assert.equal((await feed.forEvent(player, kept.id, "sq", "light")).show, true);
});

test("no fixture anywhere: the page is told the tracker is unavailable, and SportScore isn't asked again for 10 minutes", async () => {
  const lonely = await event({ name: "Nowhere vs Nobody", homeTeam: "Nowhere", awayTeam: "Nobody", startsAt: new Date(Date.now() - 20 * 60_000) });
  const calls = [];
  const feed = new TrackerService(prisma, async (url) => (calls.push(url), { ok: true, json: async () => ({ matches: [], teams: [] }) }));
  assert.deepEqual(await feed.forEvent(player, lonely.id, "en", "light"), { show: false, reason: "unavailable" });
  const asked = calls.length;
  assert.ok(asked > 0);
  await feed.forEvent(player, lonely.id, "en", "light");
  assert.equal(calls.length, asked, "the lookup isn't repeated on every view");
  const down = new TrackerService(prisma, async () => ({ ok: false, status: 503 }));
  assert.deepEqual(await down.forEvent(player, lonely.id, "en", "light"), { show: false, reason: "unavailable" }, "SportScore down: the same note");
});

test("SportScore's embed failing (503): the page is told the tracker is unavailable, not given a frame that shows an error", async () => {
  const live = await event({ name: "Embed down vs Somebody", homeTeam: "Embed down", awayTeam: "Somebody", startsAt: new Date(Date.now() - 10 * 60_000) });
  await tracker.setManual(live.id, "embed-down-vs-somebody");
  const down = new TrackerService(prisma, async () => ({ ok: false, status: 503 }));
  assert.deepEqual(await down.forEvent(player, live.id, "en", "light"), { show: false, reason: "unavailable" });
  const up = new TrackerService(prisma, async () => ({ ok: true, status: 200, json: async () => ({ matches: [] }) }));
  assert.equal((await up.forEvent(player, live.id, "en", "light")).show, true);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
