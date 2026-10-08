// Super Admin's "Delete all test data", end to end against a real Postgres,
// with Clerk stood in for. Like the other integration tests it empties
// tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { DataResetService } = require("../dist/users/data-reset.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { teamOf } = require("../dist/bets/team.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const prisma = new PrismaClient();
const audit = new AuditService(prisma);

/** Clerk: the password is "right"; `down` sign-ins fail to delete, `gone` ones were deleted already. */
const clerkState = { deleted: [], down: new Set(), gone: new Set() };
const failure = (status) => Object.assign(new Error(`Clerk ${status}`), { status });
const clerk = {
  api: { users: { verifyPassword: async ({ password }) => (password === "right" ? { verified: true } : Promise.reject(failure(422))) } },
  deleteUserStrict: async (clerkId) => {
    if (clerkState.down.has(clerkId)) throw failure(503);
    if (clerkState.gone.has(clerkId)) throw failure(404);
    clerkState.deleted.push(clerkId);
  },
};
const settings = {};
const reset = new DataResetService(prisma, clerk, audit, { get: (name) => settings[name] });

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_r${n}`, username: `r${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hr${n}`, role, parentId, ...extra } });
}

let sa, owner, manager, player, event;

test("setup: a platform full of test data", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "login_history", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { balance: 5000, commissionRate: 10 });
  manager = await user("MANAGER", owner.id, { balance: 800, commissionRate: 20 });
  player = await user("PLAYER", manager.id, { balance: 50 });
  await prisma.loginHistory.create({ data: { userId: sa.id, sessionId: "sess_sa", ipAddress: "84.20.70.1" } });
  await prisma.loginHistory.create({ data: { userId: player.id, sessionId: "sess_p", ipAddress: "84.20.70.2" } });
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default", baseOddsMargin: 5 }, update: { baseOddsMargin: 5 } });

  event = await prisma.event.create({ data: { name: "Tirana v Vllaznia", league: "Superiore", startsAt: new Date(), provider: "api-football", externalId: "r1", volume: 50 } });
  const market = await prisma.market.create({ data: { eventId: event.id, key: "match_winner", name: "Match winner" } });
  const selection = await prisma.selection.create({ data: { marketId: market.id, key: "home", name: "Tirana", feedOdds: 2 } });
  await prisma.oddsOverride.create({ data: { ownerId: owner.id, selectionId: selection.id, odds: 2.1 } });
  await prisma.bettingLimit.create({ data: { playerId: player.id, ownerMaxStake: 100 } });

  const bet = await prisma.bet.create({ data: { playerId: player.id, selectionId: selection.id, stake: 50, odds: 2, status: "LOST", settledAt: new Date(), ...(await teamOf(prisma, player.id)) } });
  await prisma.settlementEntry.create({ data: { betId: bet.id, playerId: player.id, ownerId: owner.id, managerId: manager.id, ownerRate: 10, managerRate: 20, bets: 1, stake: 50, payout: 0 } });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: player.id, actorId: manager.id, type: "DELEGATION", amount: 100, reason: "Top-up" } });
  const paid = await prisma.balanceTransaction.create({ data: { fromUserId: owner.id, toUserId: manager.id, actorId: owner.id, type: "DELEGATION", amount: 10, reason: "Commission" } });
  await prisma.commissionPayout.create({ data: { userId: manager.id, periodFrom: new Date(Date.now() - 7 * 86_400_000), periodTo: new Date(), amount: 10, transactionId: paid.id } });
  await prisma.notification.create({ data: { userId: sa.id, type: "LOW_BALANCE", title: "Low balance", message: "Test" } });
  await audit.log({ actorId: owner.id, action: "user.create", targetId: player.id });
});

test("the preview says what would go", async () => {
  const preview = await reset.preview(sa);
  assert.deepEqual(preview, { enabled: true, accounts: 3, bets: 1, casinoSpins: 0, ledgerEntries: 2, notifications: 1, auditEntries: 1 });
  await assert.rejects(reset.preview(owner), /Only Super Admin/);
});

test("the wrong username or password deletes nothing", async () => {
  await assert.rejects(reset.reset(sa, { username: "someone", password: "right" }), /Type your own username/);
  await assert.rejects(reset.reset(sa, { username: sa.username, password: "wrong" }), /password isn't right/);
  await assert.rejects(reset.reset(owner, { username: owner.username, password: "right" }), /Only Super Admin/);
  assert.equal(await prisma.user.count(), 4);
  assert.deepEqual(clerkState.deleted, []);
});

test("if Clerk fails part way, the database isn't touched, and trying again finishes", async () => {
  clerkState.down.add(player.clerkId);
  await assert.rejects(reset.reset(sa, { username: sa.username, password: "right" }), /1 of 3 sign-ins couldn't be deleted in Clerk, so nothing else was deleted yet/);
  assert.equal(await prisma.user.count(), 4, "every account is still there");
  assert.equal(await prisma.bet.count(), 1);
  assert.deepEqual(clerkState.deleted.sort(), [owner.clerkId, manager.clerkId].sort());

  // Clerk is back. The two deleted before now answer "not found", which counts as done.
  clerkState.down.clear();
  clerkState.gone.add(owner.clerkId).add(manager.clerkId);
  const done = await reset.reset(sa, { username: ` ${sa.username.toUpperCase()} `, password: "right" });
  assert.deepEqual(done, { accounts: 3, bets: 1, casinoSpins: 0, ledgerEntries: 2, commissionPayouts: 1, signIns: 3 });
  assert.ok(clerkState.deleted.includes(player.clerkId));
});

test("only Super Admin, the settings and the matches are left", async () => {
  const left = await prisma.user.findMany({ select: { id: true } });
  assert.deepEqual(left.map((row) => row.id), [sa.id]);
  for (const [name, count] of [
    ["bets", prisma.bet.count()],
    ["ledger", prisma.balanceTransaction.count()],
    ["journal", prisma.settlementEntry.count()],
    ["payouts", prisma.commissionPayout.count()],
    ["notifications", prisma.notification.count()],
    ["overrides", prisma.oddsOverride.count()],
    ["limits", prisma.bettingLimit.count()],
  ]) {
    assert.equal(await count, 0, name);
  }
  assert.deepEqual((await prisma.loginHistory.findMany()).map((row) => row.userId), [sa.id], "Super Admin's own sign-in history stays");
  const match = await prisma.event.findUniqueOrThrow({ where: { id: event.id }, include: { markets: { include: { selections: true } } } });
  assert.equal(Number(match.volume), 0, "the test bets no longer count in what was bet on it");
  assert.equal(match.markets[0].selections.length, 1, "the match and its prices stay");
  assert.equal(Number((await prisma.platformSettings.findUniqueOrThrow({ where: { id: "default" } })).baseOddsMargin), 5);
  const log = await prisma.auditLog.findMany();
  assert.deepEqual(log.map((row) => [row.action, row.actorId]), [["data.reset", sa.id]], "the audit log keeps one line: that it was cleared, and by whom");
});

test("DATA_RESET=off turns it off", async () => {
  settings.DATA_RESET = "off";
  assert.equal((await reset.preview(sa)).enabled, false);
  await assert.rejects(reset.reset(sa, { username: sa.username, password: "right" }), /turned off on this server/);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
