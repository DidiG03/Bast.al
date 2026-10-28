// Live picks on the slip, end to end against a real Postgres: a corners line
// the feed has moved on from (11.5 to 12.5) is suspended, and the slip is told
// so and offered the same side of the line now on offer; when the old line
// comes back, it reopens at its new price. A corner pauses the corners
// markets only, and the slip is told why and until when; the match banner
// names the corners lines once. Like the other integration tests it empties
// tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
delete process.env.API_FOOTBALL_KEY;
delete process.env.ODDS_FEED_MOCK;

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");

const prisma = new PrismaClient();
const sync = new OddsSyncService(prisma);
const odds = new OddsService(prisma, new AuditService(prisma), sync);

/** A reading: markets as { key: { outcome: price } }. */
const reading = (markets) => ({
  externalId: "x",
  stopped: false,
  finished: false,
  homeScore: 0,
  awayScore: 0,
  elapsed: 60,
  bookmakerUpdate: new Date(Date.now() - 500).toISOString(),
  markets: Object.entries(markets).map(([key, outcomes], sortOrder) => ({
    key,
    name: key.startsWith("corners_") ? `Total corners ${key.slice(8).replace("_", ".")}` : key,
    sortOrder,
    suspended: false,
    selections: Object.entries(outcomes).map(([outcome, price], order) => ({ key: outcome, name: outcome === "over" ? "Over" : outcome === "under" ? "Under" : outcome, odds: price, sortOrder: order })),
  })),
});

let player;
let match;
const pickOf = async (key, outcome) => prisma.selection.findFirstOrThrow({ where: { key: outcome, market: { eventId: match.id, key } } });
const slip = async (selection) => (await odds.selections({ id: player.id, role: "PLAYER", parentId: player.parentId }, [selection.id]))[0];

test("setup", async () => {
  for (const table of ["live_pauses", "goals_seen", "settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  const sa = await prisma.user.create({ data: { clerkId: "clerk_ls1", username: "ls_sa", emailCipher: "x", emailHash: "hls1", role: "SUPER_ADMIN" } });
  const owner = await prisma.user.create({ data: { clerkId: "clerk_ls2", username: "ls_owner", emailCipher: "x", emailHash: "hls2", role: "OWNER", parentId: sa.id } });
  player = await prisma.user.create({ data: { clerkId: "clerk_ls3", username: "ls_player", emailCipher: "x", emailHash: "hls3", role: "PLAYER", parentId: owner.id } });
  match = await prisma.event.create({
    data: {
      sport: "football", provider: "api-football", externalId: "ls-1", name: "Liverpool v Chelsea", league: "Premier League", homeTeam: "Liverpool", awayTeam: "Chelsea",
      startsAt: new Date(Date.now() - 60 * 60_000), status: "LIVE", period: "2H", elapsed: 60, homeScore: 0, awayScore: 0,
      // A fresh corners count, so corners lines can be bet on.
      matchCentre: { corners: [6, 4], yellow: [1, 1], red: [0, 0], moments: [] }, matchCentreAt: new Date(),
    },
  });
});

test("a corners line the feed moved on from is suspended, and the slip offers the line it offers now; back, it reopens at its new price", async () => {
  await sync.applyLiveOdds(match.id, reading({ match_winner: { home: 2, draw: 3.4, away: 3.8 }, corners_11_5: { over: 1.61, under: 2.2 } }));
  const over115 = await pickOf("corners_11_5", "over");
  assert.equal((await slip(over115)).bettable, true);

  await sync.applyLiveOdds(match.id, reading({ match_winner: { home: 2, draw: 3.4, away: 3.8 }, corners_12_5: { over: 1.8, under: 1.95 } }));
  assert.equal((await prisma.market.findFirstOrThrow({ where: { eventId: match.id, key: "corners_11_5" } })).liveSuspended, true, "no longer offered");
  const moved = await slip(over115);
  assert.equal(moved.bettable, false);
  const over125 = await pickOf("corners_12_5", "over");
  assert.equal(moved.replacement?.id, over125.id, "the same side of the line on offer now");
  assert.equal(moved.replacement.name, "Over");
  assert.ok(moved.replacement.price > 1);

  await sync.applyLiveOdds(match.id, reading({ match_winner: { home: 2, draw: 3.4, away: 3.8 }, corners_11_5: { over: 1.44, under: 2.6 } }));
  const back = await slip(over115);
  assert.equal(back.bettable, true, "back on offer");
  assert.equal(back.replacement, null);
  assert.ok(back.price < 1.61, "at its new price, for the slip to show and ask about");
});

test("a dropped reading without any corners line leaves them as they were (a red card can drop them once)", async () => {
  await sync.applyLiveOdds(match.id, reading({ match_winner: { home: 2, draw: 3.4, away: 3.8 } }));
  assert.equal((await prisma.market.findFirstOrThrow({ where: { eventId: match.id, key: "corners_11_5" } })).liveSuspended, false);
});

test("a corner pauses the corners markets only: the slip says why and until when, and the banner names them once", async () => {
  await sync.applyLiveOdds(match.id, reading({ match_winner: { home: 2, draw: 3.4, away: 3.8 }, corners_11_5: { over: 1.44, under: 2.6 }, corners_12_5: { over: 1.8, under: 1.95 } }));
  await sync.pauseMarkets(match.id, { reason: "corner", pricedSinceEvent: new Set() }, null, new Date());
  const over115 = await pickOf("corners_11_5", "over");
  const paused = await slip(over115);
  assert.equal(paused.bettable, false);
  assert.equal(paused.pause.reason, "corner");
  assert.ok(Date.parse(paused.pause.until) > Date.now(), "with when it's back");
  assert.equal(paused.replacement, null, "a pause isn't a line moved on from: it comes back as it is");
  const winner = await pickOf("match_winner", "home");
  assert.equal((await slip(winner)).bettable, true, "the match itself stays open");
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: match.id } })).liveCooldownUntil, null, "no pause on the whole match");
  const [listed] = await odds.events({ id: player.id, role: "PLAYER", parentId: player.parentId }, "live");
  assert.equal(listed.marketPause.reason, "corner");
  assert.deepEqual(listed.marketPause.markets, ["Total corners"], "the lines of one market named once");
});

test("teardown", async () => {
  await prisma.$disconnect();
});
