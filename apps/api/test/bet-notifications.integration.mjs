// What a Player is told when their bets settle, against a real Postgres: a win
// and a loss on one match each get a notification saying which pick, at what
// score, for how much, and an accumulator gets its own with its picks and
// stake. Like the other integration tests it empties tables, so it only runs
// against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { SettlementService } = require("../dist/bets/settlement.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { teamOf } = require("../dist/bets/team.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const prisma = new PrismaClient();
/** Every notification settlement sends. */
const sent = [];
const notifications = { create: async (n) => (sent.push(n), n) };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_bn${n}`, username: `bn${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hbn${n}`, role, parentId, ...extra } });
}
/** A match with the 1X2 market, kicked off two hours ago. */
async function match(name, home, away) {
  return prisma.event.create({
    data: {
      sport: "football", provider: "api-football", externalId: `bn-${name}`, name, league: "Superiore", homeTeam: home, awayTeam: away, startsAt: new Date(Date.now() - 2 * 3_600_000), status: "LIVE",
      markets: { create: { key: "match_winner", name: "Match winner", selections: { create: [["home", home], ["draw", "Draw"], ["away", away]].map(([key, name], sortOrder) => ({ key, name, feedOdds: 2, sortOrder })) } } },
    },
    include: { markets: { include: { selections: { orderBy: { sortOrder: "asc" } } } } },
  });
}
const finish = (event, home, away) => prisma.event.update({ where: { id: event.id }, data: { status: "COMPLETED", resultHome: home, resultAway: away, finishedAt: new Date() } });

let player, team, tirana, vllaznia;

test("setup", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "favourite_events", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  const sa = await user("SUPER_ADMIN", null);
  const owner = await user("OWNER", sa.id, { commissionRate: 10 });
  const manager = await user("MANAGER", owner.id, { commissionRate: 20 });
  player = await user("PLAYER", manager.id, { balance: 1000 });
  team = await teamOf(prisma, player.id);
  tirana = await match("Tirana v Partizani", "Tirana", "Partizani");
  vllaznia = await match("Vllaznia v Egnatia", "Vllaznia", "Egnatia");
});

test("a winning single: which pick, the score, what came back", async () => {
  const [home] = tirana.markets[0].selections;
  await prisma.bet.create({ data: { playerId: player.id, selectionId: home.id, stake: 250, odds: 2.5, description: "Tirana", ...team } });
  await finish(tirana, 2, 1);
  sent.length = 0;
  await settlement.settleEvent(tirana.id);
  assert.equal(sent.length, 1);
  const [win] = sent;
  assert.equal(win.title, "You won");
  assert.equal(win.severity, "SUCCESS");
  assert.deepEqual(
    { ...win.metadata, betId: typeof win.metadata.betId },
    { bet: "single", outcome: "WON", amount: 625, stake: 250, event: "Tirana v Partizani", score: "2–1", pick: "Tirana", market: "Match winner", odds: 2.5, picks: 1, betId: "string" },
  );
});

test("a losing single says it lost, with the stake; an accumulator gets its own, with its picks", async () => {
  const [, draw] = vllaznia.markets[0].selections;
  await prisma.bet.create({ data: { playerId: player.id, selectionId: draw.id, stake: 100, odds: 3.2, description: "Draw", ...team } });
  await prisma.bet.create({
    data: {
      playerId: player.id, kind: "ACCUMULATOR", stake: 50, odds: 6, description: "Accumulator · 2 picks", ...team,
      legs: { create: [{ selectionId: draw.id, odds: 3, description: "Draw" }, { selectionId: tirana.markets[0].selections[0].id, odds: 2, description: "Tirana", sortOrder: 1, result: "WON" }] },
    },
  });
  await finish(vllaznia, 1, 0);
  sent.length = 0;
  await settlement.settleEvent(vllaznia.id);
  const single = sent.find((n) => n.metadata?.bet === "single");
  const accumulator = sent.find((n) => n.metadata?.bet === "accumulator");
  assert.equal(single.title, "Bet lost");
  assert.deepEqual([single.metadata.outcome, single.metadata.stake, single.metadata.score, single.metadata.pick, single.metadata.amount], ["LOST", 100, "1–0", "Draw", 0]);
  assert.equal(accumulator.title, "Accumulator lost");
  assert.deepEqual([accumulator.metadata.outcome, accumulator.metadata.stake, accumulator.metadata.picks, accumulator.metadata.odds], ["LOST", 50, 2, 6]);
  assert.equal(accumulator.deepLink, "/dashboard/bet?tab=settled");
});

test("teardown", async () => {
  await prisma.$disconnect();
});
