// The Casino, end to end against a real Postgres: spins moving Bast.al
// credit, the day's ledger line, the settlement journal, double or nothing,
// free spins left from the old game, limits and switches. Like the other integration tests it empties tables, so it
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
const { GAME_NAME, GAMBLE_LIMIT, GAMBLE_STEPS, LINES, REEL_STRIPS, SUITS, playRound } = require("../dist/casino/game.js");
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
const losing = stopsWhere((round) => round.win === 0);
/** Four sevens on the middle row, then a lemon. */
const sevens = REEL_STRIPS.map((strip, reel) => (strip.indexOf(reel < 4 ? "SEVEN" : "LEMON") - 1 + strip.length) % strip.length);
/** A small win: 10 line bets, 200 on a 100 spin. */
const smallWin = stopsWhere((round) => round.win === 10);
const RED = SUITS.indexOf("HEARTS");
const BLACK = SUITS.indexOf("SPADES");

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
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_spins", "casino_free_spins", "casino_gambles", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 500000 });
  otherOwner = await user("OWNER", sa.id);
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 90000 });
  cara = await user("PLAYER", manager.id, { balance: 10000 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: cara.id, actorId: manager.id, type: "DELEGATION", amount: 10000, reason: "Top-up" } });
});

test("closed until Super Admin opens the site and the Owner opens their team", async () => {
  await assert.rejects(casino.spin(cara, 100), /The Casino is closed right now/);
  assert.equal((await casino.state(cara)).closed, "The Casino is closed right now.");
  await casino.setOpen(sa, true);
  await assert.rejects(casino.spin(cara, 100), /The Casino isn't open for your team/);
  await assert.rejects(casino.setOpen(owner, true, otherOwner.id), /only open or close the Casino for their own team/);
  await assert.rejects(casino.setOpen(manager, true), /Only Super Admin and Owners/);
  await casino.setOpen(owner, true);
  assert.equal((await casino.state(cara)).closed, null);
  assert.equal((await users.me(await prisma.user.findUniqueOrThrow({ where: { id: cara.id } }), false)).casinoOpen, true);
  await assert.rejects(casino.spin(cara, 300), /Choose a bet of/);
  assert.equal(await balanceOf(cara), 10000, "nothing was taken while it was closed");
});

test("a losing spin takes the stake, and shows in the ledger and the journal with the team", async () => {
  casino.rng = stopsAt(losing);
  const result = await casino.spin(cara, 100);
  assert.deepEqual([result.win, result.spin.stake, result.balance], [0, 100, 9900]);
  assert.equal(await balanceOf(cara), 9900);
  const line = await todaysLine(cara);
  assert.deepEqual([line.type, Number(line.amount), line.reason], ["CASINO", -100, "Casino: 1 spin"]);
  const journal = await prisma.settlementEntry.findFirstOrThrow({ where: { casinoSpinId: result.spin.id } });
  assert.deepEqual(
    [journal.betId, journal.bets, Number(journal.stake), Number(journal.payout), journal.ownerId, journal.managerId, Number(journal.ownerRate), Number(journal.managerRate)],
    [null, 0, 100, 0, owner.id, manager.id, 10, 20],
  );
  assert.equal(await ledgerTotal(cara), 9900, "the ledger adds up to the balance");
});

test("a win adds to the balance, and the day's line keeps adding up", async () => {
  casino.rng = stopsAt(sevens);
  const result = await casino.spin(cara, 250);
  const paid = result.lines.reduce((sum, line) => sum + line.win, 0) + (result.scatter?.win ?? 0);
  assert.ok(result.lines.some((line) => line.symbol === "SEVEN" && line.count === 4), "four sevens on the middle row");
  assert.ok(result.win >= 50000, "1,000 line bets at 50 ALL");
  assert.equal(result.gamble, null, "too big to double: over the limit");
  assert.equal(result.win, Math.round(paid * 100) / 100);
  assert.equal(await balanceOf(cara), 9900 - 250 + result.win);
  const line = await todaysLine(cara);
  assert.deepEqual([Number(line.amount), line.reason], [-100 - 250 + result.win, "Casino: 2 spins"]);
  assert.equal(await ledgerTotal(cara), await balanceOf(cara));
  assert.ok((await prisma.auditLog.findMany({ where: { action: "casino.big_win" } })).length >= 1, "a win of 100 times the bet is in the audit log");
});

test("double or nothing: a right guess doubles the win, a wrong one loses it, and each guess is on the record", async () => {
  casino.rng = stopsAt(smallWin);
  const spun = await casino.spin(cara, 100);
  assert.equal(spun.win, 200);
  assert.deepEqual(spun.gamble, { amount: 200, steps: 0, stepsLeft: GAMBLE_STEPS });
  const afterSpin = await balanceOf(cara);

  casino.drawSuit = () => RED;
  const right = await casino.gamble(cara, "RED");
  assert.deepEqual([right.won, right.color, right.win, right.balance], [true, "RED", 400, afterSpin + 200]);
  assert.deepEqual(right.gamble, { amount: 400, steps: 1, stepsLeft: GAMBLE_STEPS - 1 });
  assert.equal((await casino.state(cara)).gamble.amount, 400, "still open after a reload");

  casino.drawSuit = () => BLACK;
  const wrong = await casino.gamble(cara, "RED");
  assert.deepEqual([wrong.won, wrong.color, wrong.win, wrong.gamble], [false, "BLACK", 0, null]);
  assert.equal(await balanceOf(cara), afterSpin - 200, "the win and the first double are gone");
  await assert.rejects(casino.gamble(cara, "RED"), /no win to double/);

  const guesses = await prisma.casinoSpin.findMany({ where: { playerId: cara.id, kind: "GAMBLE" }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(guesses.map((row) => [Number(row.stake), Number(row.win), row.gamble.pick, row.gamble.suit]), [[200, 400, "RED", "HEARTS"], [400, 0, "RED", "SPADES"]]);
  const journal = await prisma.settlementEntry.findMany({ where: { casinoSpinId: { in: guesses.map((row) => row.id) } } });
  assert.equal(journal.length, 2, "both guesses count in Commissions");
  assert.match((await todaysLine(cara)).reason, /^Casino: 3 spins, 2 double or nothing$/);
  assert.equal(await ledgerTotal(cara), await balanceOf(cara));
});

test("double or nothing stops at its limits, a new spin or collecting", async () => {
  casino.rng = stopsAt(smallWin);
  casino.drawSuit = () => RED;
  await casino.spin(cara, 100);
  await casino.collect(cara);
  await assert.rejects(casino.gamble(cara, "RED"), /no win to double/, "collected");

  await casino.spin(cara, 100);
  casino.rng = stopsAt(losing);
  await casino.spin(cara, 100);
  await assert.rejects(casino.gamble(cara, "RED"), /no win to double/, "a new spin ends it");

  // Doubling stops once the next double would pass the money limit.
  casino.rng = stopsAt(smallWin);
  await casino.spin(cara, 100);
  await prisma.casinoGamble.update({ where: { playerId: cara.id }, data: { amount: GAMBLE_LIMIT / 2 - 1 } });
  await prisma.user.update({ where: { id: cara.id }, data: { balance: { increment: GAMBLE_LIMIT } } });
  const capped = await casino.gamble(cara, "RED");
  assert.equal(capped.won, true);
  assert.equal(capped.gamble, null, "won, and kept: the next double would pass the limit");
  await prisma.user.update({ where: { id: cara.id }, data: { balance: { decrement: GAMBLE_LIMIT } } });

  // The max stake applies to the amount at risk.
  await casino.spin(cara, 100);
  await prisma.bettingLimit.create({ data: { playerId: cara.id, ownerMaxStake: 100 } });
  await assert.rejects(casino.gamble(cara, "RED"), /most this Player can stake on one bet/);
  await prisma.bettingLimit.delete({ where: { playerId: cara.id } });
  await casino.collect(cara);
});

test("free spins left from the old game play at the bet that won them and cost nothing", async () => {
  await prisma.casinoFreeSpins.create({ data: { playerId: cara.id, remaining: 3, bet: 50 } });
  const before = await balanceOf(cara);
  casino.rng = stopsAt(losing);
  const free = await casino.spin(cara, 1000);
  assert.equal(free.free, true);
  assert.deepEqual([free.spin.stake, free.spin.bet, free.win], [0, 50, 0], "played at 50, whatever the Player picked");
  assert.equal(await balanceOf(cara), before, "a free spin costs nothing");
  assert.equal(free.freeSpins.remaining, 2);

  await prisma.casinoFreeSpins.update({ where: { playerId: cara.id }, data: { remaining: 1 } });
  const last = await casino.spin(cara, 1000);
  assert.equal(last.free, true);
  assert.equal(last.freeSpins, null);
  assert.equal(await prisma.casinoFreeSpins.count({ where: { playerId: cara.id } }), 0);
  assert.equal(await ledgerTotal(cara), await balanceOf(cara));
});

test("free spins still owed hold a move, and still play if the Casino closes, with no double or nothing offered", async () => {
  await prisma.casinoFreeSpins.create({ data: { playerId: cara.id, remaining: 2, bet: 50 } });
  const managerB = await user("MANAGER", owner.id);
  await assert.rejects(users.reassignPlayer(owner, cara.id, managerB.id), new RegExp(`${cara.username} still has free spins to play on the fruit slot`));

  await casino.setOpen(owner, false);
  casino.rng = stopsAt(smallWin);
  const free = await casino.spin(cara, 100);
  assert.equal(free.free, true);
  assert.ok(free.win > 0);
  assert.equal(free.gamble, null, "double or nothing is a new bet: not while the Casino is closed");
  casino.rng = stopsAt(losing);
  assert.equal((await casino.spin(cara, 100)).free, true);
  await assert.rejects(casino.spin(cara, 100), /The Casino isn't open for your team/, "once they're played, no paid spin");
  await casino.setOpen(owner, true);
  await prisma.user.delete({ where: { id: managerB.id } });
  assert.equal(await ledgerTotal(cara), await balanceOf(cara));
});

test("an Owner or a Manager can turn the Casino off for one Player; a Manager can't turn it back on over the Owner", async () => {
  const me = async () => users.me(await prisma.user.findUniqueOrThrow({ where: { id: cara.id } }), false);
  await limits.set(owner, cara.id, { casinoOff: true });
  await assert.rejects(casino.spin(cara, 100), /The Casino is turned off for your account/);
  assert.equal((await casino.state(cara)).closed, "The Casino is turned off for your account.");
  assert.equal((await me()).casinoOpen, false, "the Casino tab goes away");

  const managerView = await limits.set(manager, cara.id, { casinoOff: false });
  assert.deepEqual([managerView.owner.casinoOff, managerView.manager.casinoOff, managerView.effective.casinoOff], [true, false, true]);
  await assert.rejects(casino.spin(cara, 100), /turned off for your account/, "the Owner's switch still holds");

  await limits.set(owner, cara.id, { casinoOff: false });
  const off = await limits.set(manager, cara.id, { casinoOff: true });
  assert.deepEqual([off.owner.casinoOff, off.manager.casinoOff, off.effective.casinoOff], [false, true, true]);
  await assert.rejects(casino.spin(cara, 100), /turned off for your account/);
  await assert.rejects(limits.set(otherOwner, cara.id, { casinoOff: false }), /outside your team/);

  await limits.set(manager, cara.id, { casinoOff: false });
  assert.equal((await me()).casinoOpen, true);
  casino.rng = stopsAt(losing);
  await casino.spin(cara, 100);
  await prisma.bettingLimit.delete({ where: { playerId: cara.id } });
  assert.equal(await ledgerTotal(cara), await balanceOf(cara));
});

test("the max stake, the shared daily loss limit, a low balance and a suspended Manager stop a spin", async () => {
  casino.rng = stopsAt(losing);
  await prisma.bettingLimit.create({ data: { playerId: cara.id, ownerMaxStake: 100 } });
  await assert.rejects(casino.spin(cara, 250), /The most this Player can stake on one bet is 100\.00 ALL/);

  const used = await limits.usedToday(cara.id);
  await prisma.bettingLimit.update({ where: { playerId: cara.id }, data: { ownerMaxStake: null, ownerDailyLossLimit: used + 40 } });
  await assert.rejects(casino.spin(cara, 50), /daily loss limit/);
  await prisma.bettingLimit.delete({ where: { playerId: cara.id } });

  const balance = await balanceOf(cara);
  await prisma.user.update({ where: { id: cara.id }, data: { balance: 20 } });
  await assert.rejects(casino.spin(cara, 50), /balance is too low/);
  await prisma.user.update({ where: { id: cara.id }, data: { balance } });

  await prisma.user.update({ where: { id: manager.id }, data: { status: "SUSPENDED" } });
  await assert.rejects(casino.spin(cara, 50), /Manager's account is suspended/);
  await prisma.user.update({ where: { id: manager.id }, data: { status: "ACTIVE" } });
  assert.equal(await balanceOf(cara), balance, "nothing moved");
});

test("casino profit counts in commissions, and the Casino page shows it per Player", async () => {
  const from = startOfDay(new Date()).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const spins = await prisma.casinoSpin.findMany({ where: { playerId: cara.id } });
  const spinCount = spins.filter((spin) => spin.kind === "SPIN").length;
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
  assert.deepEqual(page.players.map((row) => [row.username, row.spins, row.net]), [[cara.username, spinCount, net]]);
  assert.equal(page.totals.spins, spinCount, "guesses count in the money, not as spins");
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
      getRequest: () => ({ actor: { id: cara.id }, headers: { "idempotency-key": "spin-key-0123456789" }, originalUrl: "/casino/spin", path: "/casino/spin", method: "POST", body: { bet: 50 } }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  };
  const send = () => firstValueFrom(interceptor.intercept(context, { handle: () => from(casino.spin(cara, 50)) }));
  const before = await prisma.casinoSpin.count({ where: { playerId: cara.id } });
  const first = await send();
  const again = await send();
  assert.equal(again.spin.id, first.spin.id);
  assert.equal(await prisma.casinoSpin.count({ where: { playerId: cara.id } }), before + 1);
});

test("the home page's Continue playing: a round still in play first, then the game played last", async () => {
  const last = await casino.lastGame(cara);
  assert.equal(last.game, "slot");
  assert.equal(last.name, GAME_NAME);
  await prisma.casinoGamble.deleteMany({ where: { playerId: cara.id } });
  assert.equal((await casino.lastGame(cara)).waiting, null, "the last game is done");
  await prisma.minesRound.create({ data: { playerId: cara.id, staked: 2, state: {} } });
  assert.deepEqual(await casino.lastGame(cara).then(({ game, waiting, amount }) => ({ game, waiting, amount })), { game: "mines", waiting: "round", amount: 2 });
  await prisma.minesRound.delete({ where: { playerId: cara.id } });
  await prisma.casinoGamble.create({ data: { playerId: cara.id, game: "book", amount: 6 } });
  assert.deepEqual(await casino.lastGame(cara).then(({ game, waiting, amount }) => ({ game, waiting, amount })), { game: "book", waiting: "gamble", amount: 6 });
  await prisma.casinoGamble.delete({ where: { playerId: cara.id } });
  assert.equal(await casino.lastGame(manager), null, "nothing played yet");
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

// Keeps LINES in use: a line bet is a fifth of the bet.
assert.equal(LINES, 5);
