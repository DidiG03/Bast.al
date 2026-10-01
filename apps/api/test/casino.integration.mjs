// The Casino, end to end against a real Postgres: spins moving Bast.al
// credit, the day's ledger line, the settlement journal, free spins, limits
// and switches. Like the other integration tests it empties tables, so it
// only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { firstValueFrom, from } = require("rxjs");
const { SeededRandomNumberGenerator } = require("pokie");
const { CasinoService } = require("../dist/casino/casino.service.js");
const { LINES, REEL_STRIPS, playRound } = require("../dist/casino/game.js");
const { BettingLimitsService } = require("../dist/commissions/betting-limits.service.js");
const { CommissionsService } = require("../dist/commissions/commissions.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { DataResetService } = require("../dist/users/data-reset.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { IdempotencyInterceptor } = require("../dist/idempotency/idempotency.interceptor.js");
const { dayKey, startOfDay } = require("../dist/time.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const prisma = new PrismaClient();
const sent = [];
const notifications = { create: async (n) => (sent.push(n), n) };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const limits = new BettingLimitsService(prisma, hierarchy);
const commissions = new CommissionsService(prisma, hierarchy);
const casino = new CasinoService(prisma, limits, commissions, realtime, users, audit);

/** A random source that stops each reel where we say. */
const stopsAt = (stops) => {
  let reel = 0;
  return { getRandomInt: () => stops[reel++ % stops.length] };
};
/** Reel stops for the first seeded round that `wanted` accepts. */
function stopsWhere(wanted) {
  for (let seed = 1; seed < 100_000; seed++) {
    const round = playRound(new SeededRandomNumberGenerator(seed));
    if (wanted(round)) return round.stops;
  }
  throw new Error("no such round");
}
const losing = stopsWhere((round) => round.win === 0 && round.freeSpins === 0);
const sevens = REEL_STRIPS.map((strip) => (strip.indexOf("SEVEN") - 1 + strip.length) % strip.length);
const withFreeSpins = stopsWhere((round) => round.freeSpins > 0);

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_c${n}`, username: `c${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hc${n}`, role, parentId, ...extra } });
}
const balanceOf = async (account) => Number((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).balance);
/** Everything in the Player's ledger, signed from their side: it must always add up to the balance. */
async function ledgerTotal(account) {
  const rows = await prisma.balanceTransaction.findMany({ where: { OR: [{ toUserId: account.id }, { fromUserId: account.id }], status: "APPROVED" } });
  return Math.round(rows.reduce((sum, row) => sum + (row.toUserId === account.id ? Number(row.amount) : -Number(row.amount)), 0) * 100) / 100;
}
const todaysLine = (account) => prisma.balanceTransaction.findUnique({ where: { id: `casino_${account.id}_${dayKey(new Date())}` } });

let sa, owner, otherOwner, manager, cara;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_spins", "casino_free_spins", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 5000 });
  otherOwner = await user("OWNER", sa.id);
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 900 });
  cara = await user("PLAYER", manager.id, { balance: 100 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: cara.id, actorId: manager.id, type: "DELEGATION", amount: 100, reason: "Top-up" } });
});

test("closed until Super Admin opens the site and the Owner opens their team", async () => {
  await assert.rejects(casino.spin(cara, 1), /The Casino is closed right now/);
  assert.equal((await casino.state(cara)).closed, "The Casino is closed right now.");
  await casino.setOpen(sa, true);
  await assert.rejects(casino.spin(cara, 1), /The Casino isn't open for your team/);
  await assert.rejects(casino.setOpen(owner, true, otherOwner.id), /only open or close the Casino for their own team/);
  await assert.rejects(casino.setOpen(manager, true), /Only Super Admin and Owners/);
  await casino.setOpen(owner, true);
  assert.equal((await casino.state(cara)).closed, null);
  assert.equal((await users.me(await prisma.user.findUniqueOrThrow({ where: { id: cara.id } }), false)).casinoOpen, true);
  await assert.rejects(casino.spin(cara, 3), /Choose a bet of/);
  assert.equal(await balanceOf(cara), 100, "nothing was taken while it was closed");
});

test("a losing spin takes the stake, and shows in the ledger and the journal with the team", async () => {
  casino.rng = stopsAt(losing);
  const result = await casino.spin(cara, 1);
  assert.deepEqual([result.win, result.spin.stake, result.balance], [0, 1, 99]);
  assert.equal(await balanceOf(cara), 99);
  const line = await todaysLine(cara);
  assert.deepEqual([line.type, Number(line.amount), line.reason], ["CASINO", -1, "Casino: 1 spin"]);
  const journal = await prisma.settlementEntry.findFirstOrThrow({ where: { casinoSpinId: result.spin.id } });
  assert.deepEqual(
    [journal.betId, journal.bets, Number(journal.stake), Number(journal.payout), journal.ownerId, journal.managerId, Number(journal.ownerRate), Number(journal.managerRate)],
    [null, 0, 1, 0, owner.id, manager.id, 10, 20],
  );
  assert.equal(await ledgerTotal(cara), 99, "the ledger adds up to the balance");
});

test("a win adds to the balance, and the day's line keeps adding up", async () => {
  casino.rng = stopsAt(sevens);
  const result = await casino.spin(cara, 2);
  const paid = result.lines.reduce((sum, line) => sum + line.win, 0) + (result.scatter?.win ?? 0);
  assert.ok(result.lines.some((line) => line.symbol === "SEVEN" && line.count === 5), "five sevens on the middle row");
  assert.ok(result.win >= 300, "1,500 line bets at 20 cents");
  assert.equal(result.win, Math.round(paid * 100) / 100);
  assert.equal(await balanceOf(cara), 99 - 2 + result.win);
  const line = await todaysLine(cara);
  assert.deepEqual([Number(line.amount), line.reason], [-1 - 2 + result.win, "Casino: 2 spins"]);
  assert.equal(await ledgerTotal(cara), await balanceOf(cara));
  assert.ok((await prisma.auditLog.findMany({ where: { action: "casino.big_win" } })).length >= 1, "a win of 100 times the bet is in the audit log");
});

test("free spins play at the bet that won them and cost nothing", async () => {
  casino.rng = stopsAt(withFreeSpins);
  const won = await casino.spin(cara, 0.5);
  assert.ok(won.freeSpinsWon > 0);
  assert.deepEqual(won.freeSpins, { remaining: won.freeSpinsWon, bet: 0.5 });

  const before = await balanceOf(cara);
  casino.rng = stopsAt(losing);
  const free = await casino.spin(cara, 10);
  assert.equal(free.free, true);
  assert.deepEqual([free.spin.stake, free.spin.bet, free.win], [0, 0.5, 0], "played at 50 cents, whatever the Player picked");
  assert.equal(await balanceOf(cara), before, "a free spin costs nothing");
  assert.equal(free.freeSpins.remaining, won.freeSpinsWon - 1);

  await prisma.casinoFreeSpins.update({ where: { playerId: cara.id }, data: { remaining: 1 } });
  const last = await casino.spin(cara, 10);
  assert.equal(last.free, true);
  assert.equal(last.freeSpins, null);
  assert.equal(await prisma.casinoFreeSpins.count({ where: { playerId: cara.id } }), 0);
  assert.equal(await ledgerTotal(cara), await balanceOf(cara));
});

test("the max stake, the shared daily loss limit, a low balance and a suspended Manager stop a spin", async () => {
  casino.rng = stopsAt(losing);
  await prisma.bettingLimit.create({ data: { playerId: cara.id, ownerMaxStake: 1 } });
  await assert.rejects(casino.spin(cara, 2), /The most this Player can stake on one bet is \$1\.00/);

  const used = await limits.usedToday(cara.id);
  await prisma.bettingLimit.update({ where: { playerId: cara.id }, data: { ownerMaxStake: null, ownerDailyLossLimit: used + 0.4 } });
  await assert.rejects(casino.spin(cara, 0.5), /daily loss limit/);
  await prisma.bettingLimit.delete({ where: { playerId: cara.id } });

  const balance = await balanceOf(cara);
  await prisma.user.update({ where: { id: cara.id }, data: { balance: 0.2 } });
  await assert.rejects(casino.spin(cara, 0.5), /balance is too low/);
  await prisma.user.update({ where: { id: cara.id }, data: { balance } });

  await prisma.user.update({ where: { id: manager.id }, data: { status: "SUSPENDED" } });
  await assert.rejects(casino.spin(cara, 0.5), /Manager's account is suspended/);
  await prisma.user.update({ where: { id: manager.id }, data: { status: "ACTIVE" } });
  assert.equal(await balanceOf(cara), balance, "nothing moved");
});

test("casino profit counts in commissions, and the Casino page shows it per Player", async () => {
  const from = startOfDay(new Date()).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const spins = await prisma.casinoSpin.findMany({ where: { playerId: cara.id } });
  const staked = spins.reduce((sum, spin) => sum + Number(spin.stake), 0);
  const won = spins.reduce((sum, spin) => sum + Number(spin.win), 0);
  const net = Math.round((staked - won) * 100) / 100;

  const team = await commissions.team(owner, undefined, from, to);
  const mine = team.managers.find((row) => row.id === manager.id);
  assert.equal(mine.net, net, "the team's profit includes the casino");
  assert.equal(mine.bets, 0, "spins aren't counted as bets");
  assert.equal(mine.commission, Math.round(net * 0.2 * 100) / 100);
  assert.equal(team.totals.superAdminCut, Math.round(net * 0.1 * 100) / 100);

  const page = await casino.admin(owner, from, to);
  assert.deepEqual(page.players.map((row) => [row.username, row.spins, row.net]), [[cara.username, spins.length, net]]);
  assert.equal(page.totals.spins, spins.length);
  assert.deepEqual(page.teams, [{ ownerId: owner.id, username: owner.username, open: true }]);
  assert.equal((await casino.admin(manager, from, to)).teamOpen, true);
  const all = await casino.admin(sa, from, to);
  assert.equal(all.siteOpen, true);
  assert.deepEqual(all.teams.map((row) => [row.username, row.open]).sort(), [[otherOwner.username, false], [owner.username, true]].sort());
});

test("the same spin request sent twice spins once", async () => {
  casino.rng = stopsAt(losing);
  const interceptor = new IdempotencyInterceptor(prisma);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ actor: { id: cara.id }, headers: { "idempotency-key": "spin-key-0123456789" }, originalUrl: "/casino/spin", path: "/casino/spin", method: "POST", body: { bet: 0.5 } }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  };
  const send = () => firstValueFrom(interceptor.intercept(context, { handle: () => from(casino.spin(cara, 0.5)) }));
  const before = await prisma.casinoSpin.count({ where: { playerId: cara.id } });
  const first = await send();
  const again = await send();
  assert.equal(again.spin.id, first.spin.id);
  assert.equal(await prisma.casinoSpin.count({ where: { playerId: cara.id } }), before + 1);
});

test("spins count as money history, and the data reset clears them", async () => {
  assert.equal(await users.hasMoneyHistory(cara.id), true);
  const clerk = { api: { users: { verifyPassword: async () => ({ verified: true }) } }, deleteUserStrict: async () => undefined };
  const reset = new DataResetService(prisma, clerk, audit, { get: () => undefined });
  const spins = await prisma.casinoSpin.count();
  const done = await reset.reset(sa, { username: sa.username, password: "right" });
  assert.equal(done.casinoSpins, spins);
  assert.equal(await prisma.casinoSpin.count(), 0);
  assert.equal(await prisma.casinoFreeSpins.count(), 0);
  assert.equal(await prisma.user.count(), 1);
});

test("teardown", async () => {
  await prisma.$disconnect();
});

// Keeps LINES in use: a line bet is a tenth of the bet.
assert.equal(LINES, 10);
