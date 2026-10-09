// Keno, end to end against a real Postgres: draws moving Bast.al credit, the
// day's "Keno" ledger line, the settlement journal, the seed pair it shares
// with Dice, the stake limits, the switches, the Casino page and a repeated
// request. Like the other integration tests it empties tables, so it only
// runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { firstValueFrom, from } = require("rxjs");
const { CasinoService } = require("../dist/casino/casino.service.js");
const { DiceService } = require("../dist/casino/dice.service.js");
const { KenoService } = require("../dist/casino/keno.service.js");
const { PlayerActivityService } = require("../dist/commissions/player-activity.service.js");
const { hashSeed } = require("../dist/casino/dice.js");
const { PAYS, drawFor, winCents } = require("../dist/casino/keno.js");
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
const keno = new KenoService(prisma, limits, realtime, users, audit);
const activity = new PlayerActivityService(prisma, hierarchy);

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_k${n}`, username: `k${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hk${n}`, role, parentId, ...extra } });
}
const balanceOf = async (account) => Number((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).balance);
async function ledgerTotal(account) {
  const rows = await prisma.balanceTransaction.findMany({ where: { OR: [{ toUserId: account.id }, { fromUserId: account.id }], status: "APPROVED" } });
  return Math.round(rows.reduce((sum, row) => sum + (row.toUserId === account.id ? Number(row.amount) : -Number(row.amount)), 0) * 100) / 100;
}
const todaysLine = (account) => prisma.balanceTransaction.findUnique({ where: { id: `keno_${account.id}_${dayKey(new Date())}` } });
const activeSeed = (account) => prisma.diceSeed.findFirstOrThrow({ where: { playerId: account.id, active: true } });
/** The Player's next draw, worked out from their seed pair the way anyone can once it's shown. */
async function nextDraw(account) {
  const seed = await activeSeed(account);
  return drawFor(seed.serverSeed, seed.clientSeed, seed.nonce);
}
/** Numbers the next draw won't have. */
const missing = (drawn, count) => Array.from({ length: 80 }, (_, i) => i + 1).filter((number) => !drawn.includes(number)).slice(0, count);

let sa, owner, manager, kim;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 500000 });
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 90000 });
  kim = await user("PLAYER", manager.id, { balance: 10000 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: kim.id, actorId: manager.id, type: "DELEGATION", amount: 10000, reason: "Top-up" } });
});

test("closed with the Casino's switches; the state gives the pay table and a seed pair, its server seed hidden", async () => {
  await assert.rejects(keno.play(kim, 100, [1, 2, 3]), /The Casino is closed right now/);
  await casino.setOpen(sa, true);
  await assert.rejects(keno.play(kim, 100, [1, 2, 3]), /isn't open for your team/);
  await casino.setOpen(owner, true);
  const state = await keno.state(kim);
  assert.equal(state.closed, null);
  assert.equal(state.tableMax, 2500);
  assert.deepEqual([state.game.numbers, state.game.drawn, state.game.maxPicks, state.game.maxMultiplier], [80, 20, 10, 2000]);
  assert.deepEqual(state.game.pays, PAYS);
  assert.ok(Object.values(state.game.payoutRates).every((rate) => rate >= 89 && rate <= 91));
  const secret = await activeSeed(kim);
  assert.equal(state.seed.serverSeedHash, hashSeed(secret.serverSeed));
  assert.equal(JSON.stringify(state).includes(secret.serverSeed), false, "the secret never leaves the server");
});

test("a draw pays what the pay table says for the hits; it shows in the ledger and the journal", async () => {
  const drawn = await nextDraw(kim);
  // Two of the next draw's numbers and two it won't have: 2 hits of 4 pay 1x.
  const picks = [drawn[3], drawn[11], ...missing(drawn, 2)];
  const win = await keno.play(kim, 250, picks);
  assert.deepEqual(win.round.drawn, drawn);
  assert.deepEqual(win.round.picks, [...picks].sort((a, b) => a - b));
  assert.deepEqual(win.round.hits.sort((a, b) => a - b), [drawn[3], drawn[11]].sort((a, b) => a - b));
  assert.deepEqual([win.round.multiplier, win.round.win, win.round.nonce, win.seed.nonce], [PAYS[4][2], winCents(25000, 4, 2) / 100, 0, 1]);
  assert.equal(win.balance, 10000);

  // 3 picks the draw misses: the stake is lost.
  const loss = await keno.play(kim, 50, missing(await nextDraw(kim), 3));
  assert.deepEqual([loss.round.hits, loss.round.win, loss.round.nonce], [[], 0, 1]);
  assert.equal(await balanceOf(kim), 9950);

  // 1 pick that's drawn: 3.6x.
  const one = await keno.play(kim, 100, [(await nextDraw(kim))[0]]);
  assert.deepEqual([one.round.multiplier, one.round.win], [3.6, 360]);
  assert.equal(await balanceOf(kim), 10210);

  const line = await todaysLine(kim);
  assert.deepEqual([line.type, line.reason, Number(line.amount)], ["CASINO", "Keno: 3 rounds", 210]);
  const journal = await prisma.settlementEntry.findFirstOrThrow({ where: { casinoSpinId: win.round.id } });
  assert.deepEqual([journal.bets, Number(journal.stake), Number(journal.payout), journal.ownerId, journal.managerId], [0, 250, 250, owner.id, manager.id]);
  assert.equal(await ledgerTotal(kim), 10210, "the ledger adds up to the balance");
});

test("Keno and Dice share the seed pair: changing it reveals the server seed, and every draw checks out", async () => {
  const before = await activeSeed(kim);
  const roll = await dice.roll(kim, 100, 50, "UNDER");
  assert.equal(roll.round.nonce, 3, "Dice takes the next nonce after Keno's draws");
  const changed = await dice.changeSeed(kim, "kims-seed");
  assert.equal(changed.previousSeed.serverSeed, before.serverSeed);
  const state = await keno.state(kim);
  assert.equal(state.seed.clientSeed, "kims-seed");
  assert.equal(state.previousSeed.serverSeed, before.serverSeed);
  for (const round of state.recent) {
    assert.equal(round.serverSeed, before.serverSeed);
    assert.deepEqual(drawFor(round.serverSeed, round.clientSeed, round.nonce), round.drawn);
  }
  const fresh = await keno.play(kim, 100, [1, 2]);
  assert.deepEqual([fresh.round.clientSeed, fresh.round.nonce, fresh.round.serverSeed], ["kims-seed", 0, null]);
});

test("bad picks and bets, the max stake, the daily loss limit and a low balance stop a draw, and nothing moves", async () => {
  const balance = await balanceOf(kim);
  const nonce = (await activeSeed(kim)).nonce;
  await assert.rejects(keno.play(kim, 100, []), /Pick 1 to 10 numbers/);
  await assert.rejects(keno.play(kim, 100, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), /Pick 1 to 10 numbers/);
  await assert.rejects(keno.play(kim, 100, [0, 5]), /from 1 to 80/);
  await assert.rejects(keno.play(kim, 100, [5, 5]), /once/);
  await assert.rejects(keno.play(kim, 300, [5]), /A round costs/);
  await assert.rejects(keno.play(kim, 5000, [5]), /A round costs/);

  await prisma.bettingLimit.create({ data: { playerId: kim.id, ownerMaxStake: 300 } });
  assert.equal((await keno.state(kim)).tableMax, 300);
  await assert.rejects(keno.play(kim, 500, [5]), /most a round can cost you is 300\.00 ALL/);
  const used = await limits.usedToday(kim.id);
  await prisma.bettingLimit.update({ where: { playerId: kim.id }, data: { ownerMaxStake: null, ownerDailyLossLimit: used + 50 } });
  await assert.rejects(keno.play(kim, 100, [5]), /daily loss limit/);
  await prisma.bettingLimit.delete({ where: { playerId: kim.id } });

  await prisma.user.update({ where: { id: kim.id }, data: { balance: 40 } });
  await assert.rejects(keno.play(kim, 50, [5]), /balance is too low/);
  await prisma.user.update({ where: { id: kim.id }, data: { balance } });
  assert.equal(await balanceOf(kim), balance);
  assert.equal((await activeSeed(kim)).nonce, nonce, "a refused draw doesn't use up a nonce");
  assert.equal(await prisma.casinoSpin.count({ where: { kind: "KENO" } }), 4);
});

test("Keno profit counts in commissions; the Casino page and Continue playing show it as its own game", async () => {
  const fromDay = startOfDay(new Date()).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const rounds = await prisma.casinoSpin.findMany({ where: { playerId: kim.id } });
  const staked = rounds.reduce((sum, round) => sum + Number(round.stake), 0);
  const won = rounds.reduce((sum, round) => sum + Number(round.win), 0);
  const net = Math.round((staked - won) * 100) / 100;
  const team = await commissions.team(owner, undefined, fromDay, to);
  assert.equal(team.managers.find((row) => row.id === manager.id).net, net);
  const page = await casino.admin(owner, fromDay, to);
  assert.deepEqual(page.players.map((row) => [row.username, row.keno.rounds, row.dice.rolls, row.net]), [[kim.username, 4, 1, net]]);
  assert.equal(page.games.keno.spins, 4);
  assert.deepEqual(page.games.slot, { spins: 0, staked: 0, won: 0, payoutRate: null });
  const last = await casino.lastGame(kim);
  assert.deepEqual([last.game, last.waiting, last.amount], ["keno", null, 100]);
});

test("staff see the Player's casino play: each game over 30 days, rounds still in play, and casino rounds in the totals", async () => {
  await prisma.blackjackHand.create({ data: { playerId: kim.id, staked: 100, state: {} } });
  const view = await activity.activity(manager, kim.id);
  const kenoRow = view.casino.find((row) => row.game === "keno");
  const rounds = await prisma.casinoSpin.findMany({ where: { playerId: kim.id, kind: "KENO" } });
  assert.equal(kenoRow.rounds, rounds.length);
  assert.equal(kenoRow.staked, rounds.reduce((sum, round) => sum + Number(round.stake), 0));
  assert.equal(view.casino.find((row) => row.game === "dice").rounds, 1);
  assert.deepEqual(view.open.casino.map((round) => [round.game, round.staked]), [["blackjack", 100]]);
  assert.equal(view.summary.allTime.bets, 0, "no sports bets");
  assert.equal(view.summary.allTime.casinoRounds, rounds.length + 1, "Keno rounds and the dice roll");
  await prisma.blackjackHand.delete({ where: { playerId: kim.id } });
  await assert.rejects(activity.activity(kim, kim.id), /outside your team/);
});

test("a big win goes in the audit log", async () => {
  // 3 picks, all drawn: 45 times isn't big; 5 of 5 (400x) is.
  const drawn = await nextDraw(kim);
  const result = await keno.play(kim, 50, drawn.slice(0, 5));
  assert.deepEqual([result.round.hits.length, result.round.multiplier, result.round.win], [5, 400, 20000]);
  const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "casino.big_win" } });
  assert.deepEqual([log.metadata.game, log.metadata.hits], ["keno", 5]);
});

test("the same draw sent twice plays once", async () => {
  const interceptor = new IdempotencyInterceptor(prisma);
  const body = { bet: 100, picks: [7, 14, 21] };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ actor: { id: kim.id }, headers: { "idempotency-key": "keno-key-0123456789" }, originalUrl: "/casino/keno/play", path: "/casino/keno/play", method: "POST", body }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  };
  const send = () => firstValueFrom(interceptor.intercept(context, { handle: () => from(keno.play(kim, body.bet, body.picks)) }));
  const before = await balanceOf(kim);
  const nonce = (await activeSeed(kim)).nonce;
  const first = await send();
  const again = await send();
  assert.equal(again.round.id, first.round.id);
  assert.equal((await activeSeed(kim)).nonce, nonce + 1, "one nonce used");
  assert.equal(await balanceOf(kim), Math.round((before - 100 + first.round.win) * 100) / 100);
  assert.equal(await ledgerTotal(kim), await balanceOf(kim));
});

test("teardown", async () => {
  await prisma.$disconnect();
});
