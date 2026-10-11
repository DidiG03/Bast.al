// The clean-up job against a real Postgres: a week of odds history and of
// matches nobody bet on is kept, older ones go (in batches), and a match with
// any bet on it is never touched. Like the other integration tests it empties
// tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { RetentionService } = require("../dist/maintenance/retention.service.js");
const { teamOf } = require("../dist/bets/team.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const prisma = new PrismaClient();
const retention = new RetentionService(prisma);
const DAY = 86_400_000;
const now = new Date();
const daysAgo = (days) => new Date(now.getTime() - days * DAY);

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_r${n}`, username: `r${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hr${n}`, role, parentId, ...extra } });
}
/** A match with one market of three picks, starting `days` days ago. */
async function match(name, days) {
  return prisma.event.create({
    data: {
      sport: "football", provider: "api-football", externalId: `ret-${name}`, name, league: "League", homeTeam: "Home", awayTeam: "Away", startsAt: daysAgo(days),
      markets: { create: { key: "match_winner", name: "Match winner", selections: { create: ["home", "draw", "away"].map((key, sortOrder) => ({ key, name: key, feedOdds: 2, sortOrder })) } } },
    },
    include: { markets: { include: { selections: true } } },
  });
}
const exists = async (event) => (await prisma.event.count({ where: { id: event.id } })) === 1;

let player, oldUnused, oldSingle, oldAccumulator, recentUnused;

test("setup: matches old and recent, with and without bets, and plenty of old price history", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  const sa = await user("SUPER_ADMIN", null);
  const owner = await user("OWNER", sa.id);
  player = await user("PLAYER", owner.id, { balance: 100 });
  const team = await teamOf(prisma, player.id);

  oldUnused = await match("old unused", 10);
  oldSingle = await match("old with a single", 20);
  oldAccumulator = await match("old with an accumulator leg", 20);
  recentUnused = await match("recent unused", 3);
  await prisma.bet.create({ data: { playerId: player.id, selectionId: oldSingle.markets[0].selections[0].id, stake: 10, odds: 2, status: "LOST", settledAt: daysAgo(19), ...team } });
  await prisma.bet.create({
    data: { playerId: player.id, kind: "ACCUMULATOR", stake: 5, odds: 4, ...team, legs: { create: [{ selectionId: oldAccumulator.markets[0].selections[1].id, odds: 2, description: "leg" }] } },
  });
  // More old matches than one batch holds.
  for (let i = 0; i < 230; i += 50) {
    await prisma.event.createMany({ data: Array.from({ length: Math.min(50, 230 - i) }, (_, k) => ({ sport: "football", provider: "api-football", externalId: `ret-bulk-${i + k}`, name: `Bulk ${i + k}`, league: "League", startsAt: daysAgo(8 + ((i + k) % 5)) })) });
  }
  // Price history: more old rows than one batch holds, and some recent ones.
  const selection = recentUnused.markets[0].selections[0].id;
  for (let i = 0; i < 12_000; i += 4_000) {
    await prisma.oddsSnapshot.createMany({ data: Array.from({ length: 4_000 }, (_, k) => ({ selectionId: selection, price: 2, recordedAt: daysAgo(8 + ((i + k) % 3)) })) });
  }
  await prisma.oddsSnapshot.createMany({ data: Array.from({ length: 5 }, () => ({ selectionId: selection, price: 2, recordedAt: daysAgo(2) })) });
});

test("a week is kept; older price history and unused matches go; matches with bets stay", async () => {
  const removed = await retention.run(now);
  assert.equal(removed.oddsHistory, 12_000, "every snapshot older than a week, across several batches");
  assert.equal(removed.unusedEvents, 231, "the old unused match and the 230 bulk ones, across several batches");
  assert.equal(await prisma.oddsSnapshot.count(), 5, "the recent price history stays");
  assert.equal(await exists(oldUnused), false);
  assert.equal(await prisma.selection.count({ where: { market: { eventId: oldUnused.id } } }), 0, "its markets and picks went with it");
  assert.equal(await exists(oldSingle), true, "a match with a single on it stays");
  assert.equal(await exists(oldAccumulator), true, "a match with an accumulator leg on it stays");
  assert.equal(await exists(recentUnused), true, "a match from this week stays");
  assert.equal(await prisma.bet.count(), 2, "bets are never touched");
  assert.equal(await prisma.event.count({ where: { name: { startsWith: "Bulk" } } }), 0);
});

test("running again finds nothing more to do", async () => {
  const removed = await retention.run(now);
  assert.equal(removed.oddsHistory, 0);
  assert.equal(removed.unusedEvents, 0);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
