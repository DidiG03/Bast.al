// Blackjack, end to end against a real Postgres: rounds kept between moves,
// money put down on the deal, a double, a split and insurance, the payout,
// the day's "Blackjack" ledger line, the settlement journal, limits, a
// repeated request, and a round left alone. Like the other integration tests
// it empties tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { firstValueFrom, from } = require("rxjs");
const { CasinoService } = require("../dist/casino/casino.service.js");
const { BlackjackService } = require("../dist/casino/blackjack.service.js");
const { TABLE_MAX } = require("../dist/casino/blackjack.js");
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
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, { create: async (n) => n }, realtime);
const limits = new BettingLimitsService(prisma, hierarchy);
const commissions = new CommissionsService(prisma, hierarchy);
const casino = new CasinoService(prisma, limits, commissions, realtime, users, audit);
const blackjack = new BlackjackService(prisma, limits, realtime, users);

/** The next round deals these cards first: player, dealer, player, dealer, then draws. */
const stack = (...cards) => {
  blackjack.shoe = () => [...Array(40).fill("2C"), ...[...cards].reverse()];
};

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_b${n}`, username: `b${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hb${n}`, role, parentId, ...extra } });
}
const balanceOf = async (account) => Number((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).balance);
async function ledgerTotal(account) {
  const rows = await prisma.balanceTransaction.findMany({ where: { OR: [{ toUserId: account.id }, { fromUserId: account.id }], status: "APPROVED" } });
  return Math.round(rows.reduce((sum, row) => sum + (row.toUserId === account.id ? Number(row.amount) : -Number(row.amount)), 0) * 100) / 100;
}
const todaysLine = (account) => prisma.balanceTransaction.findUnique({ where: { id: `blackjack_${account.id}_${dayKey(new Date())}` } });

let sa, owner, manager, bea;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "blackjack_hands", "casino_spins", "casino_free_spins", "casino_gambles", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 500000 });
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 90000 });
  bea = await user("PLAYER", manager.id, { balance: 20000 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: bea.id, actorId: manager.id, type: "DELEGATION", amount: 20000, reason: "Top-up" } });
});

test("closed with the Casino's switches, like the other games", async () => {
  await assert.rejects(blackjack.deal(bea, 1000), /The Casino is closed right now/);
  await casino.setOpen(sa, true);
  await casino.setOpen(owner, true);
  const state = await blackjack.state(bea);
  assert.deepEqual([state.closed, state.tableMax, state.round], [null, TABLE_MAX, null]);
});

test("a round is kept between moves, the bet leaves on the deal, and the win arrives when it ends", async () => {
  stack("TS", "9H", "7D", "8C", "3H"); // 17 against 17 showing 9: hit to 20
  const dealt = await blackjack.deal(bea, 1000);
  assert.deepEqual([dealt.round.phase, dealt.round.dealer, dealt.balance], ["PLAYER", ["9H", null], 19000]);
  assert.ok(!JSON.stringify(dealt).includes("8C"), "the face-down card isn't sent");
  assert.deepEqual((await blackjack.state(bea)).round.hands[0].cards, ["TS", "7D"], "it's there to carry on with");
  const line = await todaysLine(bea);
  assert.deepEqual([Number(line.amount), line.reason], [-1000, "Blackjack: 1 hand"]);
  assert.equal(await ledgerTotal(bea), 19000);

  const hit = await blackjack.act(bea, "hit");
  assert.deepEqual([hit.round.phase, hit.round.hands[0].total], ["PLAYER", 20]);
  const done = await blackjack.act(bea, "stand");
  assert.deepEqual([done.round.phase, done.round.hands[0].result, done.round.payout, done.balance], ["DONE", "WIN", 2000, 21000]);
  assert.equal(await prisma.blackjackHand.count(), 0);
  const spin = await prisma.casinoSpin.findFirstOrThrow({ where: { playerId: bea.id, kind: "BLACKJACK" } });
  assert.deepEqual([Number(spin.bet), Number(spin.stake), Number(spin.win)], [1000, 1000, 2000]);
  const journal = await prisma.settlementEntry.findFirstOrThrow({ where: { casinoSpinId: spin.id } });
  assert.deepEqual([Number(journal.stake), Number(journal.payout), journal.ownerId, journal.managerId], [1000, 2000, owner.id, manager.id]);
  assert.deepEqual([Number((await todaysLine(bea)).amount), (await todaysLine(bea)).reason], [1000, "Blackjack: 1 hand"]);
  assert.equal(await ledgerTotal(bea), 21000, "the ledger adds up to the balance");
  await assert.rejects(blackjack.act(bea, "hit"), /no hand in play/);
});

test("a blackjack pays 3 to 2 straight away", async () => {
  stack("AS", "9H", "KD", "8C");
  const result = await blackjack.deal(bea, 200);
  assert.deepEqual([result.round.phase, result.round.hands[0].result, result.round.payout, result.balance], ["DONE", "BLACKJACK", 500, 21300]);
  assert.equal(await prisma.blackjackHand.count(), 0);
});

test("a split and a double each put another bet down; the round pays both hands", async () => {
  stack("8S", "TH", "8D", "7C", "3H", "8H", "TD"); // split 8s: 11 doubles to 21, 16 stands; dealer 17
  await blackjack.deal(bea, 500);
  const split = await blackjack.act(bea, "split");
  assert.deepEqual([split.round.staked, split.balance], [1000, 20300]);
  const doubled = await blackjack.act(bea, "double");
  assert.deepEqual([doubled.round.staked, doubled.balance, doubled.round.active], [1500, 19800, 1]);
  await assert.rejects(blackjack.act(bea, "double"), /isn't open/, "one double a round");
  const done = await blackjack.act(bea, "stand");
  assert.deepEqual(done.round.hands.map((hand) => hand.result), ["WIN", "LOSE"]);
  assert.deepEqual([done.round.payout, done.balance], [2000, 21800]);
  assert.equal(await ledgerTotal(bea), 21800);
});

test("insurance costs half the bet and pays 2 to 1 against the dealer's blackjack", async () => {
  stack("TS", "AH", "9D", "KC");
  const dealt = await blackjack.deal(bea, 1000);
  assert.deepEqual([dealt.round.phase, dealt.round.allowed], ["INSURANCE", ["insure", "noInsurance"]]);
  const done = await blackjack.act(bea, "insure");
  assert.deepEqual(done.round.dealer, ["AH", "KC"], "the dealer looks and turns the blackjack over at once");
  assert.deepEqual([done.round.phase, done.round.insurance, done.round.insurancePayout, done.round.payout, done.balance], ["DONE", 500, 1500, 1500, 21800]);
});

test("a round's money counts against the daily loss limit while it's in play, and the balance must cover a double", async () => {
  stack("6S", "TH", "5D", "7C", "TD");
  const used = await limits.usedToday(bea.id);
  await blackjack.deal(bea, 1000);
  assert.equal(await limits.usedToday(bea.id), used + 1000, "the bet in play counts");
  await prisma.bettingLimit.create({ data: { playerId: bea.id, ownerDailyLossLimit: used + 1500 } });
  await assert.rejects(blackjack.act(bea, "double"), /daily loss limit/);
  await prisma.bettingLimit.delete({ where: { playerId: bea.id } });
  const balance = await balanceOf(bea);
  await prisma.user.update({ where: { id: bea.id }, data: { balance: 500 } });
  await assert.rejects(blackjack.act(bea, "double"), /balance is too low/);
  await prisma.user.update({ where: { id: bea.id }, data: { balance } });
  await assert.rejects(blackjack.deal(bea, 500), /Finish the hand/, "one round at a time");
  const done = await blackjack.act(bea, "double");
  assert.deepEqual([done.round.hands[0].result, done.round.payout], ["WIN", 4000]);
  assert.equal(await ledgerTotal(bea), await balanceOf(bea));
});

test("the max stake caps the first bet, bets are whole chips, and a low balance stops a deal", async () => {
  await assert.rejects(blackjack.deal(bea, 2550), /most you can bet on one hand is 2500\.00 ALL/);
  await assert.rejects(blackjack.deal(bea, 30), /chips/);
  await prisma.bettingLimit.create({ data: { playerId: bea.id, ownerMaxStake: 2000 } });
  await assert.rejects(blackjack.deal(bea, 2500), /2000\.00 ALL/);
  await prisma.bettingLimit.delete({ where: { playerId: bea.id } });
  const balance = await balanceOf(bea);
  await prisma.user.update({ where: { id: bea.id }, data: { balance: 100 } });
  await assert.rejects(blackjack.deal(bea, 200), /balance is too low/);
  await prisma.user.update({ where: { id: bea.id }, data: { balance } });
  assert.equal(await prisma.blackjackHand.count(), 0);
});

test("a round left alone for an hour is stood and settled", async () => {
  stack("TS", "9H", "9D", "7C");
  await blackjack.deal(bea, 1000);
  assert.equal(await blackjack.settleIdle(), 0, "not yet");
  const before = await balanceOf(bea);
  assert.equal(await blackjack.settleIdle(new Date(Date.now() + 61 * 60_000)), 1);
  assert.equal(await prisma.blackjackHand.count(), 0);
  assert.equal(await balanceOf(bea), before + 2000, "19 stands against 16, which draws a 2 to 18: 19 wins");
  assert.equal(await ledgerTotal(bea), await balanceOf(bea));
});

test("the same deal sent twice deals once", async () => {
  stack("TS", "9H", "8D", "7C");
  const interceptor = new IdempotencyInterceptor(prisma);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ actor: { id: bea.id }, headers: { "idempotency-key": "deal-key-0123456789" }, originalUrl: "/casino/blackjack/deal", path: "/casino/blackjack/deal", method: "POST", body: { bet: 100 } }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  };
  const send = () => firstValueFrom(interceptor.intercept(context, { handle: () => from(blackjack.deal(bea, 100)) }));
  const first = await send();
  const again = await send();
  assert.deepEqual(again, first);
  assert.equal(await prisma.blackjackHand.count(), 1);
  await blackjack.act(bea, "stand");
});

test("blackjack profit counts in commissions, and the Casino page shows it as its own game", async () => {
  const fromDay = startOfDay(new Date()).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const rounds = await prisma.casinoSpin.findMany({ where: { playerId: bea.id } });
  const staked = rounds.reduce((sum, round) => sum + Number(round.stake), 0);
  const won = rounds.reduce((sum, round) => sum + Number(round.win), 0);
  const net = Math.round((staked - won) * 100) / 100;
  const team = await commissions.team(owner, undefined, fromDay, to);
  assert.equal(team.managers.find((row) => row.id === manager.id).net, net);
  const page = await casino.admin(owner, fromDay, to);
  assert.equal(page.games.blackjack.spins, rounds.length);
  assert.equal(page.games.blackjack.staked, Math.round(staked * 100) / 100);
  assert.deepEqual(page.games.slot, { spins: 0, staked: 0, won: 0, payoutRate: null });
  const recent = (await blackjack.state(bea)).recent;
  assert.equal(recent.length, Math.min(10, rounds.length));
  assert.ok(recent[0].dealer.every((card) => card !== null), "finished rounds show the dealer's cards");
});

test("a round in play is cleared by the data reset", async () => {
  stack("TS", "9H", "8D", "7C");
  await blackjack.deal(bea, 100);
  const clerk = { api: { users: { verifyPassword: async () => ({ verified: true }) } }, deleteUserStrict: async () => undefined };
  const reset = new DataResetService(prisma, clerk, audit, { get: () => undefined });
  await reset.reset(sa, { username: sa.username, password: "right" });
  assert.equal(await prisma.blackjackHand.count(), 0);
  assert.equal(await prisma.casinoSpin.count(), 0);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
