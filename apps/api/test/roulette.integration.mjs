// Roulette, end to end against a real Postgres: rounds moving Bast.al credit,
// the day's "Roulette" ledger line, the settlement journal, the table limit,
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
const { RouletteService } = require("../dist/casino/roulette.service.js");
const { TABLE_MAX, WHEEL } = require("../dist/casino/roulette.js");
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
const roulette = new RouletteService(prisma, limits, realtime, users, audit);

/** Makes the wheel stop on `number`. */
const landOn = (number) => {
  roulette.draw = () => WHEEL.indexOf(number);
};

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_r${n}`, username: `r${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hr${n}`, role, parentId, ...extra } });
}
const balanceOf = async (account) => Number((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).balance);
async function ledgerTotal(account) {
  const rows = await prisma.balanceTransaction.findMany({ where: { OR: [{ toUserId: account.id }, { fromUserId: account.id }], status: "APPROVED" } });
  return Math.round(rows.reduce((sum, row) => sum + (row.toUserId === account.id ? Number(row.amount) : -Number(row.amount)), 0) * 100) / 100;
}
const todaysLine = (account) => prisma.balanceTransaction.findUnique({ where: { id: `roulette_${account.id}_${dayKey(new Date())}` } });

let sa, owner, manager, rita;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_spins", "casino_free_spins", "casino_gambles", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 5000 });
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 900 });
  rita = await user("PLAYER", manager.id, { balance: 200 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: rita.id, actorId: manager.id, type: "DELEGATION", amount: 200, reason: "Top-up" } });
});

test("closed with the Casino's switches, like the slot", async () => {
  await assert.rejects(roulette.spin(rita, [{ spot: "RED", amount: 1 }]), /The Casino is closed right now/);
  await casino.setOpen(sa, true);
  await assert.rejects(roulette.spin(rita, [{ spot: "RED", amount: 1 }]), /isn't open for your team/);
  await casino.setOpen(owner, true);
  const state = await roulette.state(rita);
  assert.equal(state.closed, null);
  assert.equal(state.tableMax, TABLE_MAX);
  assert.equal(state.game.wheel.length, 37);
  assert.equal(await balanceOf(rita), 200);
});

test("a round pays the winning spots, takes the losing ones, and shows in the ledger and the journal", async () => {
  landOn(17);
  const result = await roulette.spin(rita, [
    { spot: "17", amount: 1 },
    { spot: "BLACK", amount: 5 },
    { spot: "RED", amount: 5 },
    { spot: "0-1", amount: 2 },
  ]);
  // 17 is black: 36 back for the number, 10 for black.
  assert.deepEqual([result.number, result.label, result.color, result.staked, result.win], [17, "17", "BLACK", 13, 46]);
  assert.deepEqual(result.winners, [{ spot: "17", amount: 1, win: 36 }, { spot: "BLACK", amount: 5, win: 10 }]);
  assert.equal(WHEEL[result.stop], 17);
  assert.equal(result.balance, 233);
  assert.equal(await balanceOf(rita), 233);

  const line = await todaysLine(rita);
  assert.deepEqual([line.type, Number(line.amount), line.reason], ["CASINO", 33, "Roulette: 1 spin"]);
  const journal = await prisma.settlementEntry.findFirstOrThrow({ where: { casinoSpinId: result.round.id } });
  assert.deepEqual([journal.bets, Number(journal.stake), Number(journal.payout), journal.ownerId, journal.managerId], [0, 13, 46, owner.id, manager.id]);
  assert.equal(await ledgerTotal(rita), 233, "the ledger adds up to the balance");
});

test("0 is a number of its own, and outside bets lose on it", async () => {
  landOn(0);
  const result = await roulette.spin(rita, [{ spot: "0", amount: 0.5 }, { spot: "EVEN", amount: 10 }]);
  assert.deepEqual([result.label, result.color, result.win], ["0", "GREEN", 18]);
  assert.equal(await balanceOf(rita), 233 - 10.5 + 18);
  assert.deepEqual([Number((await todaysLine(rita)).amount), (await todaysLine(rita)).reason], [33 + 7.5, "Roulette: 2 spins"]);
  const state = await roulette.state(rita);
  assert.deepEqual(state.history.map((row) => row.label), ["0", "17"]);
  assert.deepEqual(state.recent[0].bets, [{ spot: "0", amount: 0.5, win: 18 }, { spot: "EVEN", amount: 10, win: 0 }]);
  assert.equal((await casino.state(rita)).recent.length, 0, "roulette rounds aren't in the slot's list");
});

test("illegal bets, the table limit, the daily loss limit and a low balance stop a round, and nothing moves", async () => {
  landOn(5);
  const balance = await balanceOf(rita);
  await assert.rejects(roulette.spin(rita, [{ spot: "00", amount: 1 }]), /no "00" on the table/);
  await assert.rejects(roulette.spin(rita, [{ spot: "RED", amount: 0.3 }]), /chips/);
  await assert.rejects(roulette.spin(rita, [{ spot: "RED", amount: 60 }, { spot: "BLACK", amount: 41 }]), /most you can have on the table in one spin is 100\.00 ALL/);

  await prisma.bettingLimit.create({ data: { playerId: rita.id, ownerMaxStake: 20 } });
  assert.equal((await roulette.state(rita)).tableMax, 20);
  await assert.rejects(roulette.spin(rita, [{ spot: "RED", amount: 10 }, { spot: "BLACK", amount: 10.5 }]), /20\.00 ALL/);
  await prisma.bettingLimit.update({ where: { playerId: rita.id }, data: { ownerMaxStake: 150 } });
  assert.equal((await roulette.state(rita)).tableMax, 150, "a higher max stake raises the table limit");

  const used = await limits.usedToday(rita.id);
  await prisma.bettingLimit.update({ where: { playerId: rita.id }, data: { ownerMaxStake: null, ownerDailyLossLimit: used + 1 } });
  await assert.rejects(roulette.spin(rita, [{ spot: "RED", amount: 2 }]), /daily loss limit/);
  await prisma.bettingLimit.delete({ where: { playerId: rita.id } });

  await prisma.user.update({ where: { id: rita.id }, data: { balance: 1 } });
  await assert.rejects(roulette.spin(rita, [{ spot: "RED", amount: 2 }]), /balance is too low/);
  await prisma.user.update({ where: { id: rita.id }, data: { balance } });
  assert.equal(await balanceOf(rita), balance);
  assert.equal(await prisma.casinoSpin.count({ where: { kind: "ROULETTE" } }), 2);
});

test("a roulette round ends a slot win waiting for double or nothing; the win stays", async () => {
  await prisma.casinoGamble.create({ data: { playerId: rita.id, amount: 4 } });
  landOn(1);
  await roulette.spin(rita, [{ spot: "1", amount: 1 }]);
  assert.equal(await prisma.casinoGamble.count({ where: { playerId: rita.id } }), 0);
});

test("roulette profit counts in commissions, and the Casino page shows each game", async () => {
  const fromDay = startOfDay(new Date()).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const rounds = await prisma.casinoSpin.findMany({ where: { playerId: rita.id } });
  const staked = rounds.reduce((sum, round) => sum + Number(round.stake), 0);
  const won = rounds.reduce((sum, round) => sum + Number(round.win), 0);
  const net = Math.round((staked - won) * 100) / 100;

  const team = await commissions.team(owner, undefined, fromDay, to);
  assert.equal(team.managers.find((row) => row.id === manager.id).net, net);

  const page = await casino.admin(owner, fromDay, to);
  assert.deepEqual(page.players.map((row) => [row.username, row.spins, row.roulette.spins, row.net]), [[rita.username, 0, 3, net]]);
  assert.deepEqual(page.games.roulette, { spins: 3, staked: Math.round(staked * 100) / 100, won: Math.round(won * 100) / 100, payoutRate: Math.round((won / staked) * 1000) / 10 });
  assert.deepEqual(page.games.slot, { spins: 0, staked: 0, won: 0, payoutRate: null });
});

test("the same round sent twice plays once", async () => {
  landOn(2);
  const interceptor = new IdempotencyInterceptor(prisma);
  const bets = [{ spot: "COL2", amount: 1 }];
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ actor: { id: rita.id }, headers: { "idempotency-key": "roulette-key-0123456789" }, originalUrl: "/casino/roulette/spin", path: "/casino/roulette/spin", method: "POST", body: { bets } }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  };
  const send = () => firstValueFrom(interceptor.intercept(context, { handle: () => from(roulette.spin(rita, bets)) }));
  const before = await balanceOf(rita);
  const first = await send();
  const again = await send();
  assert.equal(again.round.id, first.round.id);
  assert.equal(await balanceOf(rita), before + 2, "column 2 paid once");
  assert.equal(await ledgerTotal(rita), await balanceOf(rita));
});

test("teardown", async () => {
  await prisma.$disconnect();
});
