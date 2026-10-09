// Scratch Cards, end to end against a real Postgres: cards moving Bast.al
// credit when bought, the day's "Scratch Cards" ledger line, the settlement
// journal, the seed pair it shares with Dice, the stake limits, the
// switches, the Casino page, the audit log and a repeated request. Like the
// other integration tests it empties tables, so it only runs against a
// database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { firstValueFrom, from } = require("rxjs");
const { CasinoService } = require("../dist/casino/casino.service.js");
const { DiceService } = require("../dist/casino/dice.service.js");
const { ScratchService } = require("../dist/casino/scratch.service.js");
const { PlayerActivityService } = require("../dist/commissions/player-activity.service.js");
const { hashSeed } = require("../dist/casino/dice.js");
const { cardFor } = require("../dist/casino/scratch.js");
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
const scratch = new ScratchService(prisma, limits, realtime, users, audit);
const activity = new PlayerActivityService(prisma, hierarchy);

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_s${n}`, username: `s${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hs${n}`, role, parentId, ...extra } });
}
const balanceOf = async (account) => Number((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).balance);
async function ledgerTotal(account) {
  const rows = await prisma.balanceTransaction.findMany({ where: { OR: [{ toUserId: account.id }, { fromUserId: account.id }], status: "APPROVED" } });
  return Math.round(rows.reduce((sum, row) => sum + (row.toUserId === account.id ? Number(row.amount) : -Number(row.amount)), 0) * 100) / 100;
}
const todaysLine = (account) => prisma.balanceTransaction.findUnique({ where: { id: `scratch_${account.id}_${dayKey(new Date())}` } });
const activeSeed = (account) => prisma.diceSeed.findFirstOrThrow({ where: { playerId: account.id, active: true } });
/** Moves the Player's seed pair on to the next nonce whose card passes `test`, worked out from the seeds the way anyone can once they're shown. */
async function skipTo(account, test) {
  const seed = await activeSeed(account);
  let nonce = seed.nonce;
  while (!test(cardFor(seed.serverSeed, seed.clientSeed, nonce))) nonce++;
  await prisma.diceSeed.update({ where: { id: seed.id }, data: { nonce } });
  return cardFor(seed.serverSeed, seed.clientSeed, nonce);
}

let sa, owner, manager, sami;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 500000 });
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 90000 });
  sami = await user("PLAYER", manager.id, { balance: 10000 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: sami.id, actorId: manager.id, type: "DELEGATION", amount: 10000, reason: "Top-up" } });
});

test("closed with the Casino's switches; the state gives the prizes and a seed pair, its server seed hidden", async () => {
  await assert.rejects(scratch.buy(sami, 100), /The Casino is closed right now/);
  await casino.setOpen(sa, true);
  await assert.rejects(scratch.buy(sami, 100), /isn't open for your team/);
  await casino.setOpen(owner, true);
  const state = await scratch.state(sami);
  assert.equal(state.closed, null);
  assert.equal(state.tableMax, 2500);
  assert.deepEqual([state.game.cells, state.game.maxMultiplier, state.game.payoutRate, state.game.winChance], [9, 1000, 90, 35.6]);
  assert.deepEqual(state.game.prizes[0], { symbol: "CHERRY", multiplier: 1, chance: 20 });
  const secret = await activeSeed(sami);
  assert.equal(state.seed.serverSeedHash, hashSeed(secret.serverSeed));
  assert.equal(JSON.stringify(state).includes(secret.serverSeed), false, "the secret never leaves the server");
});

test("a card is paid when it's bought: a win pays its prize, a blank loses the price; both show in the ledger and the journal", async () => {
  const bell = await skipTo(sami, (card) => card.symbol === "BELL");
  const win = await scratch.buy(sami, 250);
  assert.deepEqual([win.round.cells, win.round.symbol, win.round.multiplier, win.round.win], [bell.cells, "BELL", 5, 1250]);
  assert.equal(win.balance, 11000);

  await skipTo(sami, (card) => card.symbol === null);
  const blank = await scratch.buy(sami, 1000);
  assert.deepEqual([blank.round.symbol, blank.round.multiplier, blank.round.win], [null, 0, 0]);
  assert.equal(await balanceOf(sami), 10000);

  const line = await todaysLine(sami);
  assert.deepEqual([line.type, line.reason, Number(line.amount)], ["CASINO", "Scratch Cards: 2 cards", 0]);
  const journal = await prisma.settlementEntry.findFirstOrThrow({ where: { casinoSpinId: win.round.id } });
  assert.deepEqual([journal.bets, Number(journal.stake), Number(journal.payout), journal.ownerId, journal.managerId], [0, 250, 1250, owner.id, manager.id]);
  assert.equal(await ledgerTotal(sami), 10000, "the ledger adds up to the balance");
});

test("Scratch Cards and Dice share the seed pair: changing it reveals the server seed, and every card checks out", async () => {
  const before = await activeSeed(sami);
  const roll = await dice.roll(sami, 100, 50, "UNDER");
  assert.equal(roll.round.nonce, before.nonce, "Dice takes the next nonce after the cards");
  await dice.changeSeed(sami, "samis-seed");
  const state = await scratch.state(sami);
  assert.equal(state.seed.clientSeed, "samis-seed");
  for (const round of state.recent) {
    assert.equal(round.serverSeed, before.serverSeed);
    const card = cardFor(round.serverSeed, round.clientSeed, round.nonce);
    assert.deepEqual([card.cells, card.symbol, card.multiplier], [round.cells, round.symbol, round.multiplier]);
  }
  const fresh = await scratch.buy(sami, 100);
  assert.deepEqual([fresh.round.clientSeed, fresh.round.nonce, fresh.round.serverSeed], ["samis-seed", 0, null]);
});

test("a bad price, the max stake, the Player's Casino switch, the daily loss limit and a low balance stop a card, and nothing moves", async () => {
  const balance = await balanceOf(sami);
  const nonce = (await activeSeed(sami)).nonce;
  await assert.rejects(scratch.buy(sami, 300), /A card costs/);
  await assert.rejects(scratch.buy(sami, 5000), /A card costs/);

  await prisma.bettingLimit.create({ data: { playerId: sami.id, ownerMaxStake: 300 } });
  assert.equal((await scratch.state(sami)).tableMax, 300);
  await assert.rejects(scratch.buy(sami, 500), /most a card can cost you is 300\.00 ALL/);
  await prisma.bettingLimit.update({ where: { playerId: sami.id }, data: { ownerMaxStake: null, ownerCasinoOff: true } });
  await assert.rejects(scratch.buy(sami, 100), /turned off for your account/);
  const used = await limits.usedToday(sami.id);
  await prisma.bettingLimit.update({ where: { playerId: sami.id }, data: { ownerCasinoOff: false, ownerDailyLossLimit: used + 50 } });
  await assert.rejects(scratch.buy(sami, 100), /daily loss limit/);
  await prisma.bettingLimit.delete({ where: { playerId: sami.id } });

  await prisma.user.update({ where: { id: sami.id }, data: { balance: 40 } });
  await assert.rejects(scratch.buy(sami, 50), /balance is too low/);
  await prisma.user.update({ where: { id: sami.id }, data: { balance } });
  assert.equal(await balanceOf(sami), balance);
  assert.equal((await activeSeed(sami)).nonce, nonce, "a refused card doesn't use up a nonce");
  assert.equal(await prisma.casinoSpin.count({ where: { kind: "SCRATCH" } }), 3);
});

test("a big win goes in the audit log", async () => {
  // The diamond pays 100 times the price.
  await skipTo(sami, (card) => card.symbol === "DIAMOND");
  const result = await scratch.buy(sami, 50);
  assert.deepEqual([result.round.symbol, result.round.multiplier, result.round.win], ["DIAMOND", 100, 5000]);
  const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "casino.big_win" } });
  assert.deepEqual([log.metadata.game, log.metadata.symbol, log.metadata.multiplier], ["scratch", "DIAMOND", 100]);
});

test("Scratch Cards profit counts in commissions; the Casino page, Continue playing and the Player's activity show it as its own game", async () => {
  const fromDay = startOfDay(new Date()).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const rounds = await prisma.casinoSpin.findMany({ where: { playerId: sami.id } });
  const staked = rounds.reduce((sum, round) => sum + Number(round.stake), 0);
  const won = rounds.reduce((sum, round) => sum + Number(round.win), 0);
  const net = Math.round((staked - won) * 100) / 100;
  const team = await commissions.team(owner, undefined, fromDay, to);
  assert.equal(team.managers.find((row) => row.id === manager.id).net, net);
  const page = await casino.admin(owner, fromDay, to);
  assert.deepEqual(page.players.map((row) => [row.username, row.scratch.cards, row.dice.rolls, row.net]), [[sami.username, 4, 1, net]]);
  assert.equal(page.games.scratch.spins, 4);
  assert.deepEqual(page.games.slot, { spins: 0, staked: 0, won: 0, payoutRate: null });
  const last = await casino.lastGame(sami);
  assert.deepEqual([last.game, last.waiting, last.amount], ["scratch", null, 50]);
  const view = await activity.activity(manager, sami.id);
  const cards = rounds.filter((round) => round.kind === "SCRATCH");
  assert.deepEqual(
    view.casino.filter((row) => row.game === "scratch").map((row) => [row.rounds, row.staked]),
    [[cards.length, cards.reduce((sum, round) => sum + Number(round.stake), 0)]],
  );
});

test("the same card bought twice is bought once", async () => {
  const interceptor = new IdempotencyInterceptor(prisma);
  const body = { bet: 100 };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ actor: { id: sami.id }, headers: { "idempotency-key": "scratch-key-0123456789" }, originalUrl: "/casino/scratch/buy", path: "/casino/scratch/buy", method: "POST", body }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  };
  const send = () => firstValueFrom(interceptor.intercept(context, { handle: () => from(scratch.buy(sami, body.bet)) }));
  const before = await balanceOf(sami);
  const nonce = (await activeSeed(sami)).nonce;
  const first = await send();
  const again = await send();
  assert.equal(again.round.id, first.round.id);
  assert.equal((await activeSeed(sami)).nonce, nonce + 1, "one nonce used");
  assert.equal(await balanceOf(sami), Math.round((before - 100 + first.round.win) * 100) / 100);
  assert.equal(await ledgerTotal(sami), await balanceOf(sami));
});

test("teardown", async () => {
  await prisma.$disconnect();
});
