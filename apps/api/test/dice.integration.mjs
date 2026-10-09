// Dice, end to end against a real Postgres: rolls moving Bast.al credit,
// the day's "Dice" ledger line, the settlement journal, the seed pair and
// its nonce, revealing a server seed, the stake limits, the switches and a
// repeated request. Like the other integration tests it empties tables, so
// it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { firstValueFrom, from } = require("rxjs");
const { CasinoService } = require("../dist/casino/casino.service.js");
const { DiceService } = require("../dist/casino/dice.service.js");
const { hashSeed, rollFor, winCents } = require("../dist/casino/dice.js");
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
const dice = new DiceService(prisma, limits, realtime, users, audit);

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_d${n}`, username: `d${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hd${n}`, role, parentId, ...extra } });
}
const balanceOf = async (account) => Number((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).balance);
async function ledgerTotal(account) {
  const rows = await prisma.balanceTransaction.findMany({ where: { OR: [{ toUserId: account.id }, { fromUserId: account.id }], status: "APPROVED" } });
  return Math.round(rows.reduce((sum, row) => sum + (row.toUserId === account.id ? Number(row.amount) : -Number(row.amount)), 0) * 100) / 100;
}
const todaysLine = (account) => prisma.balanceTransaction.findUnique({ where: { id: `dice_${account.id}_${dayKey(new Date())}` } });
/** The Player's active seed pair, straight from the database (secret included). */
const activeSeed = (account) => prisma.diceSeed.findFirstOrThrow({ where: { playerId: account.id, active: true } });
/** The Player's next roll, worked out from their seed pair the way anyone can once it's shown. */
async function nextRoll(account) {
  const seed = await activeSeed(account);
  return rollFor(seed.serverSeed, seed.clientSeed, seed.nonce);
}
/** A legal target and side that `roll` beats (both in hundredths). */
const winningBet = (roll) => (roll < 9500 ? { target: Math.max(roll + 1, 100), direction: "UNDER" } : { target: Math.min(roll - 1, 9899), direction: "OVER" });
/** A legal target and side that `roll` loses to. */
const losingBet = (roll) => (roll < 100 ? { target: 499, direction: "OVER" } : { target: Math.min(roll, 9500), direction: "UNDER" });

let sa, owner, manager, dan;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 500000 });
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 90000 });
  dan = await user("PLAYER", manager.id, { balance: 10000 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: dan.id, actorId: manager.id, type: "DELEGATION", amount: 10000, reason: "Top-up" } });
});

test("closed with the Casino's switches; the state gives a seed pair, its server seed hidden", async () => {
  await assert.rejects(dice.roll(dan, 100, 50, "UNDER"), /The Casino is closed right now/);
  await casino.setOpen(sa, true);
  await assert.rejects(dice.roll(dan, 100, 50, "UNDER"), /isn't open for your team/);
  await casino.setOpen(owner, true);
  const state = await dice.state(dan);
  assert.equal(state.closed, null);
  assert.equal(state.tableMax, 2500);
  assert.equal(state.game.maxMultiplier, 97);
  assert.equal(state.seed.nonce, 0);
  assert.equal(state.seed.serverSeed, null);
  assert.equal(state.previousSeed, null);
  const secret = await activeSeed(dan);
  assert.equal(state.seed.serverSeedHash, hashSeed(secret.serverSeed));
  assert.equal(JSON.stringify(state).includes(secret.serverSeed), false, "the secret never leaves the server");
  assert.equal((await dice.state(dan)).seed.serverSeedHash, state.seed.serverSeedHash, "the same pair until it's changed");
});

test("a winning roll pays the multiplier, a losing one takes the stake; both show in the ledger and the journal", async () => {
  const roll = await nextRoll(dan);
  const good = winningBet(roll);
  const win = await dice.roll(dan, 250, good.target / 100, good.direction);
  assert.equal(win.round.roll, roll / 100);
  assert.equal(win.round.won, true);
  assert.equal(win.round.nonce, 0);
  assert.equal(win.seed.nonce, 1);
  assert.equal(win.round.win, winCents(25000, Math.round(win.round.chance * 100)) / 100);
  const afterWin = Math.round((10000 - 250 + win.round.win) * 100) / 100;
  assert.equal(win.balance, afterWin);

  const bad = losingBet(await nextRoll(dan));
  const loss = await dice.roll(dan, 100, bad.target / 100, bad.direction);
  assert.deepEqual([loss.round.won, loss.round.win, loss.round.nonce], [false, 0, 1]);
  const expected = Math.round((afterWin - 100) * 100) / 100;
  assert.equal(await balanceOf(dan), expected);

  const line = await todaysLine(dan);
  assert.deepEqual([line.type, line.reason], ["CASINO", "Dice: 2 rolls"]);
  assert.equal(Number(line.amount), Math.round((expected - 10000) * 100) / 100);
  const journal = await prisma.settlementEntry.findFirstOrThrow({ where: { casinoSpinId: win.round.id } });
  assert.deepEqual([journal.bets, Number(journal.stake), Number(journal.payout), journal.ownerId, journal.managerId], [0, 250, win.round.win, owner.id, manager.id]);
  assert.equal(await ledgerTotal(dan), expected, "the ledger adds up to the balance");
});

test("changing seeds reveals the old server seed, and every roll made with it checks out", async () => {
  const before = await activeSeed(dan);
  const changed = await dice.changeSeed(dan, "dans-own-seed");
  assert.equal(changed.previousSeed.serverSeed, before.serverSeed);
  assert.equal(changed.previousSeed.nonce, 2);
  assert.equal(changed.seed.clientSeed, "dans-own-seed");
  assert.equal(changed.seed.nonce, 0);
  assert.equal(changed.seed.serverSeed, null);
  assert.notEqual(changed.seed.serverSeedHash, before.serverSeedHash);

  const state = await dice.state(dan);
  assert.equal(state.previousSeed.serverSeed, before.serverSeed);
  for (const round of state.recent) {
    assert.equal(round.serverSeed, before.serverSeed);
    assert.equal(hashSeed(round.serverSeed), round.serverSeedHash);
    assert.equal(rollFor(round.serverSeed, round.clientSeed, round.nonce) / 100, round.roll);
  }
  const fresh = await dice.roll(dan, 100, 50, "UNDER");
  assert.deepEqual([fresh.round.clientSeed, fresh.round.nonce, fresh.round.serverSeed], ["dans-own-seed", 0, null]);
  await assert.rejects(dice.changeSeed(dan, "has spaces"), /client seed/);
});

test("bad stakes and targets, the max stake, the daily loss limit and a low balance stop a roll, and nothing moves", async () => {
  const balance = await balanceOf(dan);
  const nonce = (await activeSeed(dan)).nonce;
  await assert.rejects(dice.roll(dan, 30, 50, "UNDER"), /A roll costs 50\.00, 100\.00/);
  await assert.rejects(dice.roll(dan, 100.5, 50, "UNDER"), /A roll costs/);
  await assert.rejects(dice.roll(dan, 5000, 50, "UNDER"), /A roll costs/);
  await assert.rejects(dice.roll(dan, 100, 0.5, "UNDER"), /1% to 95%/);
  await assert.rejects(dice.roll(dan, 100, 99.5, "OVER"), /1% to 95%/);
  await assert.rejects(dice.roll(dan, 100, 50.123, "OVER"), /0\.00 to 99\.99/);
  await assert.rejects(dice.roll(dan, 100, 50, "SIDEWAYS"), /over or under/);

  await prisma.bettingLimit.create({ data: { playerId: dan.id, ownerMaxStake: 300 } });
  assert.equal((await dice.state(dan)).tableMax, 300);
  await assert.rejects(dice.roll(dan, 500, 50, "UNDER"), /most a roll can cost you is 300\.00 ALL/);
  const used = await limits.usedToday(dan.id);
  await prisma.bettingLimit.update({ where: { playerId: dan.id }, data: { ownerMaxStake: null, ownerDailyLossLimit: used + 50 } });
  await assert.rejects(dice.roll(dan, 100, 50, "UNDER"), /daily loss limit/);
  await prisma.bettingLimit.delete({ where: { playerId: dan.id } });

  await prisma.user.update({ where: { id: dan.id }, data: { balance: 50 } });
  await assert.rejects(dice.roll(dan, 100, 50, "UNDER"), /balance is too low/);
  await prisma.user.update({ where: { id: dan.id }, data: { balance } });
  assert.equal(await balanceOf(dan), balance);
  assert.equal((await activeSeed(dan)).nonce, nonce, "a refused roll doesn't use up a nonce");
  assert.equal(await prisma.casinoSpin.count({ where: { kind: "DICE" } }), 3);
});

test("dice profit counts in commissions, and the Casino page shows it as its own game", async () => {
  const fromDay = startOfDay(new Date()).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const rolls = await prisma.casinoSpin.findMany({ where: { playerId: dan.id } });
  const staked = rolls.reduce((sum, roll) => sum + Number(roll.stake), 0);
  const won = rolls.reduce((sum, roll) => sum + Number(roll.win), 0);
  const net = Math.round((staked - won) * 100) / 100;
  const team = await commissions.team(owner, undefined, fromDay, to);
  assert.equal(team.managers.find((row) => row.id === manager.id).net, net);
  const page = await casino.admin(owner, fromDay, to);
  assert.deepEqual(page.players.map((row) => [row.username, row.spins, row.dice.rolls, row.net]), [[dan.username, 0, 3, net]]);
  assert.equal(page.games.dice.spins, 3);
  assert.deepEqual(page.games.slot, { spins: 0, staked: 0, won: 0, payoutRate: null });
});

test("a big win goes in the audit log", async () => {
  // Under (roll + 1) with the roll low enough for 1%: 97 times.
  let roll = await nextRoll(dan);
  while (roll >= 100) {
    await dice.changeSeed(dan);
    roll = await nextRoll(dan);
  }
  const result = await dice.roll(dan, 50, 1, "UNDER");
  assert.deepEqual([result.round.won, result.round.multiplier, result.round.win], [true, 97, 4850]);
  const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "casino.big_win" } });
  assert.equal(log.metadata.game, "dice");
});

test("the same roll sent twice plays once", async () => {
  const interceptor = new IdempotencyInterceptor(prisma);
  const body = { bet: 100, target: 50, direction: "UNDER" };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ actor: { id: dan.id }, headers: { "idempotency-key": "dice-key-0123456789" }, originalUrl: "/casino/dice/roll", path: "/casino/dice/roll", method: "POST", body }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  };
  const send = () => firstValueFrom(interceptor.intercept(context, { handle: () => from(dice.roll(dan, body.bet, body.target, body.direction)) }));
  const before = await balanceOf(dan);
  const nonce = (await activeSeed(dan)).nonce;
  const first = await send();
  const again = await send();
  assert.equal(again.round.id, first.round.id);
  assert.equal((await activeSeed(dan)).nonce, nonce + 1, "one nonce used");
  assert.equal(await balanceOf(dan), Math.round((before - 100 + first.round.win) * 100) / 100);
  assert.equal(await ledgerTotal(dan), await balanceOf(dan));
});

test("teardown", async () => {
  await prisma.$disconnect();
});
