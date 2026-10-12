// Live prices pushed to the pages, against a real Postgres: each team's
// Players get their own team's prices (the feed less that team's margin), the
// first push of a match carries everything and the next only what changed, a
// goal sends the new score, and staff are told to fetch instead.
// Like the other integration tests it empties tables, so it only runs against
// a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const prisma = new PrismaClient();
/** Everything pushed, by topic. */
const pushed = [];
const realtime = { publishTopic: async (topic, event) => void pushed.push({ topic, event }), publishAll: async () => undefined, listenerCount: () => 0 };
const sync = new OddsSyncService(prisma, realtime);
const odds = new OddsService(prisma, new AuditService(prisma), sync, realtime);

let match, cheap, dear;
const reading = (home, away, winner, elapsed = 30) => ({
  externalId: "x",
  stopped: false,
  finished: false,
  homeScore: home,
  awayScore: away,
  elapsed,
  markets: [{ key: "match_winner", name: "Match winner", sortOrder: 0, suspended: false, selections: Object.entries(winner).map(([key, price], sortOrder) => ({ key, name: key, odds: price, sortOrder })) }],
});
/** A push's prices, lowest first (the order selections come in isn't fixed). */
const pricesOf = (delta) => delta.prices.map(([, price]) => price).sort((a, b) => a - b);
const to = (topic) => pushed.filter((push) => push.topic === topic).map((push) => push.event);

test("setup: a live match, two Owners with different margins", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "favourite_events", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default", baseOddsMargin: 5 }, update: { baseOddsMargin: 5 } });
  const sa = await prisma.user.create({ data: { clerkId: "clerk_lp1", username: "lp_sa", emailCipher: "x", emailHash: "hlp1", role: "SUPER_ADMIN" } });
  cheap = await prisma.user.create({ data: { clerkId: "clerk_lp2", username: "lp_cheap", emailCipher: "x", emailHash: "hlp2", role: "OWNER", parentId: sa.id, oddsMargin: -5 } });
  dear = await prisma.user.create({ data: { clerkId: "clerk_lp3", username: "lp_dear", emailCipher: "x", emailHash: "hlp3", role: "OWNER", parentId: sa.id, oddsMargin: 5 } });
  match = await prisma.event.create({ data: { sport: "football", provider: "api-football", externalId: "push-1", name: "A v B", league: "League", homeTeam: "A", awayTeam: "B", startsAt: new Date(Date.now() - 1_800_000), status: "LIVE", homeScore: 0, awayScore: 0 } });
});

test("the first push carries the match and its prices, each team at its own margin", async () => {
  await sync.applyLiveOdds(match.id, reading(0, 0, { home: 2, draw: 3, away: 4 }));
  pushed.length = 0;
  await odds.pushLive([match.id]);
  const [toCheap] = to(`team:${cheap.id}`);
  const [toDear] = to(`team:${dear.id}`);
  const [toNoTeam] = to("team:none");
  assert.equal(toCheap.type, "odds.live");
  const [delta] = toCheap.events;
  assert.equal(delta.id, match.id);
  assert.deepEqual([delta.header.live, delta.header.homeScore, delta.header.awayScore, delta.header.bettable], [true, 0, 0, true]);
  // Base 5% less the cheap Owner's 5% is the feed price; the dear one's 10% takes 2.00 to 1.80; no team, 5%.
  assert.deepEqual(pricesOf(delta), [2, 3, 4]);
  assert.deepEqual(pricesOf(toDear.events[0]), [1.8, 2.7, 3.6]);
  assert.deepEqual(pricesOf(toNoTeam.events[0]), [1.9, 2.85, 3.8]);
  assert.deepEqual(to("staff"), [{ type: "odds.changed" }], "staff fetch for themselves");
});

test("nothing changed: nothing sent to the teams", async () => {
  await sync.applyLiveOdds(match.id, reading(0, 0, { home: 2, draw: 3, away: 4 }));
  pushed.length = 0;
  await odds.pushLive([match.id]);
  assert.deepEqual(to(`team:${cheap.id}`), []);
});

test("one price moves: only that price", async () => {
  await sync.applyLiveOdds(match.id, reading(0, 0, { home: 2.1, draw: 3, away: 4 }));
  pushed.length = 0;
  await odds.pushLive([match.id]);
  const [{ events }] = to(`team:${cheap.id}`);
  assert.equal(events[0].header, undefined, "same score and minute");
  assert.equal(events[0].prices.length, 1);
  assert.equal(events[0].prices[0][1], 2.1);
});

test("a goal: the new score and the pause go out with the prices", async () => {
  await sync.applyLiveOdds(match.id, reading(1, 0, { home: 1.4, draw: 4.5, away: 8 }, 31));
  pushed.length = 0;
  await odds.pushLive([match.id]);
  const [{ events }] = to(`team:${dear.id}`);
  assert.deepEqual([events[0].header.homeScore, events[0].header.awayScore, events[0].header.elapsed], [1, 0, 31]);
  assert.equal(events[0].header.bettable, false);
  assert.equal(events[0].header.livePause, "goal");
});

test("saving live prices pushes them without being asked", async () => {
  sync.onLiveSaved = (ids) => odds.pushLive(ids);
  sync.client = { liveOddsFor: async () => ({ fixture: { id: 1, status: { elapsed: 32 } }, teams: {}, odds: [] }) };
  pushed.length = 0;
  await sync.verifyLive([match.id]);
  assert.ok(pushed.some((push) => push.topic === "staff"), "the save was announced");
});

/** The match as the fixtures list sends it. */
const fixture = (status, period, home, away, elapsed, result = null) => ({
  externalId: "push-1", leagueId: 1, season: 2026, league: "League", country: "X", leagueLogo: null, countryFlag: null,
  homeTeam: "A", awayTeam: "B", homeLogo: null, awayLogo: null, startsAt: match.startsAt,
  status, elapsed, period, homeScore: home, awayScore: away, result, halfTime: null, extraTime: false,
});

test("the score check pushes a new minute, and full time, without waiting for prices", async () => {
  sync.onLiveSaved = (ids) => odds.pushLive(ids);
  let listed = [fixture("LIVE", "2H", 1, 0, 60)];
  let byId = [];
  sync.client = { liveFixtures: async () => listed, fixturesByIds: async () => byId };
  pushed.length = 0;
  assert.equal(await sync.syncLive(), 0);
  const [minute] = to(`team:${cheap.id}`);
  assert.equal(minute.events[0].header.elapsed, 60);

  pushed.length = 0;
  assert.equal(await sync.syncLive(), 0);
  assert.deepEqual(to(`team:${cheap.id}`), [], "same minute: nothing");

  // Off the live list: fetched by id, finished.
  listed = [];
  byId = [fixture("COMPLETED", "FT", 2, 0, 90, { home: 2, away: 0 })];
  pushed.length = 0;
  assert.equal(await sync.syncLive(), 1);
  const [fullTime] = to(`team:${cheap.id}`);
  assert.deepEqual([fullTime.events[0].header.status, fullTime.events[0].header.live, fullTime.events[0].header.period], ["COMPLETED", false, "FT"]);
});

test("a match seen to finish is settled at once", async () => {
  await prisma.event.update({ where: { id: match.id }, data: { status: "LIVE", period: "2H", finishedAt: null } });
  let settled = 0;
  sync.onFinished = async () => void settled++;
  sync.client = { liveFixtures: async () => [], fixturesByIds: async () => [fixture("COMPLETED", "FT", 2, 0, 90, { home: 2, away: 0 })], fixtureDetails: async () => [] };
  sync.quotaLeft = null;
  await sync.liveScoresRun();
  assert.equal(settled, 1);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
