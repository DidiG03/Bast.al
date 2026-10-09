// Coin Flip, end to end against a real Postgres: flips moving Bast.al
// credit, the day's "Coin Flip" ledger line, the settlement journal, the seed
// pair it shares with Dice and Keno, the stake limits, the switches, the
// Casino page and a repeated request. Like the other integration tests it
// empties tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { firstValueFrom, from } = require("rxjs");
const { CasinoService } = require("../dist/casino/casino.service.js");
const { DiceService } = require("../dist/casino/dice.service.js");
const { CoinFlipService } = require("../dist/casino/coin-flip.service.js");
const { PlayerActivityService } = require("../dist/commissions/player-activity.service.js");
const { hashSeed } = require("../dist/casino/dice.js");
const { flipFor } = require("../dist/casino/coin-flip.js");
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
const coin = new CoinFlipService(prisma, limits, realtime, users);
const activity = new PlayerActivityService(prisma, hierarchy);

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_c${n}`, username: `c${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hc${n}`, role, parentId, ...extra } });
}
const balanceOf = async (account) => Number((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).balance);
async function ledgerTotal(account) {
  const rows = await prisma.balanceTransaction.findMany({ where: { OR: [{ toUserId: account.id }, { fromUserId: account.id }], status: "APPROVED" } });
  return Math.round(rows.reduce((sum, row) => sum + (row.toUserId === account.id ? Number(row.amount) : -Number(row.amount)), 0) * 100) / 100;
}
const todaysLine = (account) => prisma.balanceTransaction.findUnique({ where: { id: `coinflip_${account.id}_${dayKey(new Date())}` } });
const activeSeed = (account) => prisma.diceSeed.findFirstOrThrow({ where: { playerId: account.id, active: true } });
/** The side the Player's next flip will show, worked out from their seed pair the way anyone can once it's shown. */
async function nextSide(account) {
  const seed = await activeSeed(account);
  return flipFor(seed.serverSeed, seed.clientSeed, seed.nonce);
}
const other = (side) => (side === "HEADS" ? "TAILS" : "HEADS");

let sa, owner, manager, cleo;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 500000 });
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 90000 });
  cleo = await user("PLAYER", manager.id, { balance: 10000 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: cleo.id, actorId: manager.id, type: "DELEGATION", amount: 10000, reason: "Top-up" } });
});

test("closed with the Casino's switches; the state gives the rules and a seed pair, its server seed hidden", async () => {
  await assert.rejects(coin.flip(cleo, 100, "HEADS"), /The Casino is closed right now/);
  await casino.setOpen(sa, true);
  await assert.rejects(coin.flip(cleo, 100, "HEADS"), /isn't open for your team/);
  await casino.setOpen(owner, true);
  const state = await coin.state(cleo);
  assert.equal(state.closed, null);
  assert.equal(state.tableMax, 2500);
  assert.deepEqual([state.game.multiplier, state.game.payoutRate, [...state.game.bets]], [1.8, 90, [50, 100, 250, 500, 1000, 2500]]);
  const secret = await activeSeed(cleo);
  assert.equal(state.seed.serverSeedHash, hashSeed(secret.serverSeed));
  assert.equal(JSON.stringify(state).includes(secret.serverSeed), false, "the secret never leaves the server");
});

test("a right call pays 1.8x and a wrong one loses the stake; both show in the ledger and the journal", async () => {
  const side = await nextSide(cleo);
  const win = await coin.flip(cleo, 250, side);
  assert.deepEqual([win.round.call, win.round.side, win.round.won, win.round.multiplier, win.round.win, win.round.nonce, win.seed.nonce], [side, side, true, 1.8, 450, 0, 1]);
  assert.equal(win.balance, 10200);

  const next = await nextSide(cleo);
  const loss = await coin.flip(cleo, 1000, other(next));
  assert.deepEqual([loss.round.side, loss.round.won, loss.round.win, loss.round.nonce], [next, false, 0, 1]);
  assert.equal(await balanceOf(cleo), 9200);

  const line = await todaysLine(cleo);
  assert.deepEqual([line.type, line.reason, Number(line.amount)], ["CASINO", "Coin Flip: 2 flips", -800]);
  const journal = await prisma.settlementEntry.findFirstOrThrow({ where: { casinoSpinId: win.round.id } });
  assert.deepEqual([journal.bets, Number(journal.stake), Number(journal.payout), journal.ownerId, journal.managerId], [0, 250, 450, owner.id, manager.id]);
  assert.equal(await ledgerTotal(cleo), 9200, "the ledger adds up to the balance");
});

test("Coin Flip and Dice share the seed pair: changing it reveals the server seed, and every flip checks out", async () => {
  const before = await activeSeed(cleo);
  const roll = await dice.roll(cleo, 100, 50, "UNDER");
  assert.equal(roll.round.nonce, 2, "Dice takes the next nonce after the flips");
  const changed = await dice.changeSeed(cleo, "cleos-seed");
  assert.equal(changed.previousSeed.serverSeed, before.serverSeed);
  const state = await coin.state(cleo);
  assert.equal(state.seed.clientSeed, "cleos-seed");
  for (const round of state.recent) {
    assert.equal(round.serverSeed, before.serverSeed);
    assert.equal(flipFor(round.serverSeed, round.clientSeed, round.nonce), round.side);
  }
  const fresh = await coin.flip(cleo, 100, "TAILS");
  assert.deepEqual([fresh.round.clientSeed, fresh.round.nonce, fresh.round.serverSeed], ["cleos-seed", 0, null]);
});

test("a bad call or bet, the max stake, the Player's Casino switch, the daily loss limit and a low balance stop a flip, and nothing moves", async () => {
  const balance = await balanceOf(cleo);
  const nonce = (await activeSeed(cleo)).nonce;
  await assert.rejects(coin.flip(cleo, 100, "EDGE"), /Call heads or tails/);
  await assert.rejects(coin.flip(cleo, 300, "HEADS"), /A flip costs/);
  await assert.rejects(coin.flip(cleo, 5000, "HEADS"), /A flip costs/);

  await prisma.bettingLimit.create({ data: { playerId: cleo.id, ownerMaxStake: 300 } });
  assert.equal((await coin.state(cleo)).tableMax, 300);
  await assert.rejects(coin.flip(cleo, 500, "HEADS"), /most a flip can cost you is 300\.00 ALL/);
  await prisma.bettingLimit.update({ where: { playerId: cleo.id }, data: { ownerMaxStake: null, managerCasinoOff: true } });
  await assert.rejects(coin.flip(cleo, 100, "HEADS"), /turned off for your account/);
  const used = await limits.usedToday(cleo.id);
  await prisma.bettingLimit.update({ where: { playerId: cleo.id }, data: { managerCasinoOff: false, ownerDailyLossLimit: used + 50 } });
  await assert.rejects(coin.flip(cleo, 100, "HEADS"), /daily loss limit/);
  await prisma.bettingLimit.delete({ where: { playerId: cleo.id } });

  await prisma.user.update({ where: { id: cleo.id }, data: { balance: 40 } });
  await assert.rejects(coin.flip(cleo, 50, "HEADS"), /balance is too low/);
  await prisma.user.update({ where: { id: cleo.id }, data: { balance } });
  assert.equal(await balanceOf(cleo), balance);
  assert.equal((await activeSeed(cleo)).nonce, nonce, "a refused flip doesn't use up a nonce");
  assert.equal(await prisma.casinoSpin.count({ where: { kind: "COIN_FLIP" } }), 3);
});

test("Coin Flip profit counts in commissions; the Casino page, Continue playing and the Player's activity show it as its own game", async () => {
  const fromDay = startOfDay(new Date()).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const rounds = await prisma.casinoSpin.findMany({ where: { playerId: cleo.id } });
  const staked = rounds.reduce((sum, round) => sum + Number(round.stake), 0);
  const won = rounds.reduce((sum, round) => sum + Number(round.win), 0);
  const net = Math.round((staked - won) * 100) / 100;
  const team = await commissions.team(owner, undefined, fromDay, to);
  assert.equal(team.managers.find((row) => row.id === manager.id).net, net);
  const page = await casino.admin(owner, fromDay, to);
  assert.deepEqual(page.players.map((row) => [row.username, row.coinFlip.flips, row.dice.rolls, row.net]), [[cleo.username, 3, 1, net]]);
  assert.equal(page.games.coinflip.spins, 3);
  assert.deepEqual(page.games.slot, { spins: 0, staked: 0, won: 0, payoutRate: null });
  const last = await casino.lastGame(cleo);
  assert.deepEqual([last.game, last.waiting, last.amount], ["coinflip", null, 100]);
  const view = await activity.activity(manager, cleo.id);
  const flips = rounds.filter((round) => round.kind === "COIN_FLIP");
  assert.deepEqual(
    view.casino.filter((row) => row.game === "coinflip").map((row) => [row.rounds, row.staked]),
    [[flips.length, flips.reduce((sum, round) => sum + Number(round.stake), 0)]],
  );
});

test("the same flip sent twice plays once", async () => {
  const interceptor = new IdempotencyInterceptor(prisma);
  const body = { bet: 100, call: "HEADS" };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ actor: { id: cleo.id }, headers: { "idempotency-key": "coin-key-0123456789" }, originalUrl: "/casino/coin-flip/flip", path: "/casino/coin-flip/flip", method: "POST", body }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  };
  const send = () => firstValueFrom(interceptor.intercept(context, { handle: () => from(coin.flip(cleo, body.bet, body.call)) }));
  const before = await balanceOf(cleo);
  const nonce = (await activeSeed(cleo)).nonce;
  const first = await send();
  const again = await send();
  assert.equal(again.round.id, first.round.id);
  assert.equal((await activeSeed(cleo)).nonce, nonce + 1, "one nonce used");
  assert.equal(await balanceOf(cleo), Math.round((before - 100 + first.round.win) * 100) / 100);
  assert.equal(await ledgerTotal(cleo), await balanceOf(cleo));
});

test("teardown", async () => {
  await prisma.$disconnect();
});
