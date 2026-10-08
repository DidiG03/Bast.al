// Plinko, end to end against a real Postgres: balls moving Bast.al credit,
// the day's "Plinko" ledger line, the settlement journal, the stake limits,
// the switches and a repeated request. Like the other integration tests it
// empties tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { firstValueFrom, from } = require("rxjs");
const { CasinoService } = require("../dist/casino/casino.service.js");
const { PlinkoService } = require("../dist/casino/plinko.service.js");
const { BettingLimitsService } = require("../dist/commissions/betting-limits.service.js");
const { CommissionsService } = require("../dist/commissions/commissions.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { IdempotencyInterceptor } = require("../dist/idempotency/idempotency.interceptor.js");
const { dayKey, startOfDay } = require("../dist/time.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const limits = new BettingLimitsService(prisma, hierarchy);
const commissions = new CommissionsService(prisma, hierarchy);
const casino = new CasinoService(prisma, limits, commissions, realtime, users, audit);
const plinko = new PlinkoService(prisma, limits, realtime, users, audit);

/** Makes the ball follow `path` (0 left, 1 right), row by row. */
const follow = (path) => {
  let row = 0;
  plinko.draw = () => path[row++ % path.length];
};

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_p${n}`, username: `p${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hp${n}`, role, parentId, ...extra } });
}
const balanceOf = async (account) => Number((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).balance);
async function ledgerTotal(account) {
  const rows = await prisma.balanceTransaction.findMany({ where: { OR: [{ toUserId: account.id }, { fromUserId: account.id }], status: "APPROVED" } });
  return Math.round(rows.reduce((sum, row) => sum + (row.toUserId === account.id ? Number(row.amount) : -Number(row.amount)), 0) * 100) / 100;
}
const todaysLine = (account) => prisma.balanceTransaction.findUnique({ where: { id: `plinko_${account.id}_${dayKey(new Date())}` } });

let sa, owner, manager, pia;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 5000 });
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 900 });
  pia = await user("PLAYER", manager.id, { balance: 100 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: pia.id, actorId: manager.id, type: "DELEGATION", amount: 100, reason: "Top-up" } });
});

test("closed with the Casino's switches, like the other games", async () => {
  await assert.rejects(plinko.drop(pia, 1, 8, "LOW"), /The Casino is closed right now/);
  await casino.setOpen(sa, true);
  await assert.rejects(plinko.drop(pia, 1, 8, "LOW"), /isn't open for your team/);
  await casino.setOpen(owner, true);
  const state = await plinko.state(pia);
  assert.equal(state.closed, null);
  assert.equal(state.tableMax, 10);
  assert.deepEqual(state.game.rows, [8, 12, 16]);
  assert.equal(state.game.pays[16].HIGH.length, 17);
  assert.equal(state.game.payoutRates[16].LOW, 97);
  assert.equal(await balanceOf(pia), 100);
});

test("a ball takes the stake, pays its bucket, and shows in the ledger and the journal", async () => {
  // All left on 8 rows, medium risk: the edge, 13.4 times.
  follow([0]);
  const edge = await plinko.drop(pia, 0.5, 8, "MEDIUM");
  assert.deepEqual([edge.round.rows, edge.round.risk, edge.round.bucket, edge.round.multiplier, edge.round.bet, edge.round.win], [8, "MEDIUM", 0, 13.4, 0.5, 6.7]);
  assert.deepEqual(edge.round.path, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(edge.balance, 106.2);
  assert.equal(await balanceOf(pia), 106.2);

  // Four each way on 8 rows, high risk: the middle, 0.2 times.
  follow([0, 1]);
  const middle = await plinko.drop(pia, 2, 8, "HIGH");
  assert.deepEqual([middle.round.bucket, middle.round.multiplier, middle.round.win], [4, 0.2, 0.4]);
  assert.equal(await balanceOf(pia), 104.6);

  const line = await todaysLine(pia);
  assert.deepEqual([line.type, Number(line.amount), line.reason], ["CASINO", 4.6, "Plinko: 2 balls"]);
  const journal = await prisma.settlementEntry.findFirstOrThrow({ where: { casinoSpinId: edge.round.id } });
  assert.deepEqual([journal.bets, Number(journal.stake), Number(journal.payout), journal.ownerId, journal.managerId], [0, 0.5, 6.7, owner.id, manager.id]);
  assert.equal(await ledgerTotal(pia), 104.6, "the ledger adds up to the balance");

  const state = await plinko.state(pia);
  assert.deepEqual(state.recent.map((row) => row.multiplier), [0.2, 13.4]);
  assert.equal((await casino.state(pia)).recent.length, 0, "Plinko balls aren't in the slot's list");
});

test("a big win goes in the audit log", async () => {
  follow([1]);
  const ball = await plinko.drop(pia, 0.2, 16, "HIGH");
  assert.deepEqual([ball.round.bucket, ball.round.multiplier, ball.round.win], [16, 1000, 200]);
  const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "casino.big_win" } });
  assert.equal(log.metadata.game, "plinko");
  assert.equal(log.metadata.multiplier, 1000);
});

test("bad stakes and boards, the max stake, the daily loss limit and a low balance stop a ball, and nothing moves", async () => {
  follow([0, 1]);
  const balance = await balanceOf(pia);
  await assert.rejects(plinko.drop(pia, 0.3, 8, "LOW"), /Pick one of the stakes/);
  await assert.rejects(plinko.drop(pia, 1, 10, "LOW"), /8, 12 or 16 rows/);
  await assert.rejects(plinko.drop(pia, 1, 8, "EXTREME"), /Pick a risk/);

  await prisma.bettingLimit.create({ data: { playerId: pia.id, managerMaxStake: 2 } });
  assert.equal((await plinko.state(pia)).tableMax, 2);
  await assert.rejects(plinko.drop(pia, 5, 8, "LOW"), /most a ball can cost you is \$2\.00/);

  const used = await limits.usedToday(pia.id);
  await prisma.bettingLimit.update({ where: { playerId: pia.id }, data: { managerMaxStake: null, managerDailyLossLimit: used + 0.5 } });
  await assert.rejects(plinko.drop(pia, 1, 8, "LOW"), /daily loss limit/);
  await prisma.bettingLimit.delete({ where: { playerId: pia.id } });

  await prisma.user.update({ where: { id: pia.id }, data: { balance: 0.4 } });
  await assert.rejects(plinko.drop(pia, 0.5, 8, "LOW"), /balance is too low/);
  await prisma.user.update({ where: { id: pia.id }, data: { balance } });
  assert.equal(await balanceOf(pia), balance);
  assert.equal(await prisma.casinoSpin.count({ where: { kind: "PLINKO" } }), 3);
});

test("Plinko profit counts in commissions, and the Casino page shows it as its own game", async () => {
  const fromDay = startOfDay(new Date()).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const balls = await prisma.casinoSpin.findMany({ where: { playerId: pia.id } });
  const staked = balls.reduce((sum, ball) => sum + Number(ball.stake), 0);
  const won = balls.reduce((sum, ball) => sum + Number(ball.win), 0);
  const net = Math.round((staked - won) * 100) / 100;

  const team = await commissions.team(owner, undefined, fromDay, to);
  assert.equal(team.managers.find((row) => row.id === manager.id).net, net);

  const page = await casino.admin(owner, fromDay, to);
  assert.deepEqual(page.players.map((row) => [row.username, row.spins, row.plinko.balls, row.net]), [[pia.username, 0, 3, net]]);
  assert.deepEqual(page.games.plinko, { spins: 3, staked: Math.round(staked * 100) / 100, won: Math.round(won * 100) / 100, payoutRate: Math.round((won / staked) * 1000) / 10 });
  assert.deepEqual(page.games.slot, { spins: 0, staked: 0, won: 0, payoutRate: null });
});

test("the same ball sent twice drops once", async () => {
  follow([0, 0, 0, 0, 0, 0, 0, 1]);
  const interceptor = new IdempotencyInterceptor(prisma);
  const body = { bet: 1, rows: 8, risk: "LOW" };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ actor: { id: pia.id }, headers: { "idempotency-key": "plinko-key-0123456789" }, originalUrl: "/casino/plinko/drop", path: "/casino/plinko/drop", method: "POST", body }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  };
  const send = () => firstValueFrom(interceptor.intercept(context, { handle: () => from(plinko.drop(pia, body.bet, body.rows, body.risk)) }));
  const before = await balanceOf(pia);
  const first = await send();
  const again = await send();
  assert.equal(again.round.id, first.round.id);
  assert.equal(first.round.multiplier, 1.8);
  assert.equal(await balanceOf(pia), Math.round((before + 0.8) * 100) / 100, "paid once");
  assert.equal(await ledgerTotal(pia), await balanceOf(pia));
});

test("teardown", async () => {
  await prisma.$disconnect();
});
