// Match stats for everyone and starred matches, against a real Postgres:
// opening a match's stats fetches them only when what's saved is out of date
// (once for everyone asking together, never without quota to spare), a live
// match someone is looking at joins the live sync's list, and stars are kept
// per account. Like the other integration tests it empties tables, so it only
// runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { ApiFootballClient } = require("../dist/odds/api-football.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const prisma = new PrismaClient();
const sync = new OddsSyncService(prisma);
const odds = new OddsService(prisma, new AuditService(prisma), sync);

/** The feed: every request it gets, answered with a match centre for each fixture asked about. */
const asked = [];
sync.mode = "api-football";
sync.client = new ApiFootballClient(async (path, params) => {
  asked.push(params.ids);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    response: String(params.ids)
      .split("-")
      .map((id) => ({
        fixture: { id: Number(id), date: "", status: { short: "2H", elapsed: 60 } },
        league: { id: 1, name: "", country: "", season: 2026 },
        teams: { home: { id: 1, name: "A" }, away: { id: 2, name: "B" } },
        goals: { home: 1, away: 0 },
        events: [{ time: { elapsed: 10 }, team: { id: 1, name: "A" }, player: { id: 1, name: "Hoxha" }, assist: { id: null, name: null }, type: "Goal", detail: "Normal Goal" }],
        statistics: [
          { team: { id: 1, name: "A" }, statistics: [{ type: "Corner Kicks", value: 5 }, { type: "Fouls", value: 8 }] },
          { team: { id: 2, name: "B" }, statistics: [{ type: "Corner Kicks", value: 2 }, { type: "Fouls", value: 11 }] },
        ],
      })),
  };
});
/** Opens a match's stats as `who`, as a fresh read (not the 2 seconds everyone shares). */
const open = (who, event) => {
  odds.forgetLists();
  return odds.matchCentre(who, event.id);
};

let n = 0;
async function user(role, parentId) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_mc${n}`, username: `mc${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hmc${n}`, role, parentId } });
}
const actor = (u) => ({ id: u.id, role: u.role, parentId: u.parentId });
const HOUR = 3_600_000;
async function match(name, data) {
  n += 1;
  return prisma.event.create({ data: { sport: "football", provider: "api-football", externalId: String(1000 + n), name, league: "League", homeTeam: "A", awayTeam: "B", startsAt: new Date(Date.now() - HOUR), ...data } });
}

let player, other, live, finished, soon, later, hidden;

test("setup", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "favourite_events", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  const sa = await user("SUPER_ADMIN", null);
  const owner = await user("OWNER", sa.id);
  player = await user("PLAYER", owner.id);
  other = await user("PLAYER", owner.id);
  live = await match("Live v Match", { status: "LIVE", elapsed: 60, period: "2H", homeScore: 1, awayScore: 0 });
  finished = await match("Old v Match", { status: "COMPLETED", finishedAt: new Date(Date.now() - 2 * HOUR), homeScore: 2, awayScore: 2 });
  soon = await match("Soon v Match", { status: "UPCOMING", startsAt: new Date(Date.now() + HOUR) });
  later = await match("Later v Match", { status: "UPCOMING", startsAt: new Date(Date.now() + 5 * HOUR) });
  hidden = await match("Hidden v Match", { status: "LIVE", hidden: true });
});

test("a live match's stats: fetched when opened, then served from what's saved", async () => {
  asked.length = 0;
  const first = await open(actor(player), live);
  assert.deepEqual(asked, [live.externalId], "one request for this match");
  assert.deepEqual(first.centre.corners, [5, 2]);
  assert.deepEqual(first.centre.stats, [
    { type: "Corner Kicks", home: 5, away: 2 },
    { type: "Fouls", home: 8, away: 11 },
    { type: "Yellow Cards", home: 0, away: 0 },
    { type: "Red Cards", home: 0, away: 0 },
  ]);
  assert.equal(first.centre.moments[0].player, "Hoxha");
  assert.deepEqual([first.status, first.elapsed, first.period, first.homeScore, first.awayScore], ["LIVE", 60, "2H", 1, 0]);

  await open(actor(other), live);
  assert.equal(asked.length, 1, "fresh enough: no second request");
});

test("everyone opening a stale match together shares one request", async () => {
  await prisma.event.update({ where: { id: live.id }, data: { matchCentreAt: new Date(Date.now() - 5 * 60_000) } });
  asked.length = 0;
  odds.forgetLists();
  await Promise.all([odds.matchCentre(actor(player), live.id), odds.matchCentre(actor(other), live.id), odds.matchCentre(actor(player), live.id)]);
  assert.equal(asked.length, 1);
});

test("a finished match is fetched once for its final numbers, then kept", async () => {
  asked.length = 0;
  await open(actor(player), finished);
  await open(actor(player), finished);
  assert.deepEqual(asked, [finished.externalId]);
});

test("before kick-off: only within 90 minutes (for the team sheets), at most every 10 minutes", async () => {
  asked.length = 0;
  const far = await open(actor(player), later);
  assert.equal(far.centre, null);
  await open(actor(player), soon);
  await open(actor(player), soon);
  assert.deepEqual(asked, [soon.externalId]);
});

test("without quota to spare, what's saved is what's shown", async () => {
  await prisma.event.update({ where: { id: live.id }, data: { matchCentreAt: new Date(Date.now() - 5 * 60_000) } });
  asked.length = 0;
  sync.quotaLeft = 100;
  const shown = await open(actor(player), live);
  sync.quotaLeft = null;
  assert.equal(asked.length, 0);
  assert.deepEqual(shown.centre.corners, [5, 2], "the saved numbers");
});

test("a hidden match's stats aren't shown to a Player, or fetched", async () => {
  asked.length = 0;
  await assert.rejects(open(actor(player), hidden), /Match not found/);
  assert.equal(asked.length, 0);
});

test("the live sync refreshes a live match someone is looking at, without a bet on it", async () => {
  await prisma.event.update({ where: { id: live.id }, data: { matchCentreAt: new Date(Date.now() - 5 * 60_000) } });
  asked.length = 0;
  assert.equal(await sync.syncMatchCentres(), 1);
  assert.deepEqual(asked, [live.externalId]);
  sync.centreInterest.clear();
  asked.length = 0;
  assert.equal(await sync.syncMatchCentres(), 0, "nobody looking and no bets: left alone");
});

test("stars: per account, newest first, off again, and gone with the match", async () => {
  await odds.setFavourite(actor(player), live.id, true);
  assert.deepEqual(await odds.setFavourite(actor(player), soon.id, true), [soon.id, live.id]);
  assert.deepEqual(await odds.setFavourite(actor(player), soon.id, true), [soon.id, live.id], "starring twice is the same");
  assert.deepEqual(await odds.favourites(actor(other)), [], "another account's stars are its own");
  assert.deepEqual(await odds.setFavourite(actor(player), live.id, false), [soon.id]);
  await assert.rejects(odds.setFavourite(actor(player), hidden.id, true), /Match not found/);
  await assert.rejects(odds.setFavourite(actor(player), "no-such-match", true), /Match not found/);
  await prisma.event.delete({ where: { id: soon.id } });
  assert.deepEqual(await odds.favourites(actor(player)), []);
});

test("at most 200 stars", async () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ sport: "football", provider: "api-football", externalId: `star-${i}`, name: `Star ${i}`, league: "League", startsAt: new Date(Date.now() + HOUR) }));
  await prisma.event.createMany({ data: many });
  const ids = (await prisma.event.findMany({ where: { name: { startsWith: "Star " } }, select: { id: true } })).map((event) => event.id);
  await prisma.favouriteEvent.createMany({ data: ids.map((eventId) => ({ userId: other.id, eventId })) });
  await assert.rejects(odds.setFavourite(actor(other), live.id, true), /up to 200/);
});

test("a live match the bookmaker has every market off the board for says so; one market back and it doesn't", async () => {
  await prisma.event.update({ where: { id: live.id }, data: { liveOddsAt: new Date() } });
  const winner = await prisma.market.create({ data: { eventId: live.id, key: "match_winner", name: "Match winner", liveSuspended: true } });
  await prisma.market.create({ data: { eventId: live.id, key: "goals_2_5", name: "Goals 2.5", liveSuspended: true } });
  const flag = async () => {
    odds.forgetLists();
    return (await odds.events(actor(player), "live", undefined, "list")).find((event) => event.id === live.id).allMarketsSuspended;
  };
  assert.equal(await flag(), true);
  await prisma.market.update({ where: { id: winner.id }, data: { liveSuspended: false } });
  assert.equal(await flag(), false);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
