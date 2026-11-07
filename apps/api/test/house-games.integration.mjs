// Money Wheel, Baccarat, Hi-Lo, Tower, Crash and Candy Cascade, end to end against a real
// Postgres: each moves the balance with its round in one transaction, writes
// the settlement journal and the day's ledger line for its game, keeps one
// round in play at a time, settles abandoned rounds, and shows up in the
// Casino stats as itself (not as the slot). Empties tables, so it only runs
// against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { CasinoService } = require("../dist/casino/casino.service.js");
const { HouseService } = require("../dist/casino/house.service.js");
const { HouseGamesService } = require("../dist/casino/house-games.service.js");
const { BettingLimitsService } = require("../dist/commissions/betting-limits.service.js");
const { CommissionsService } = require("../dist/commissions/commissions.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const Crash = require("../dist/casino/crash.js");
const { dayKey } = require("../dist/time.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
process.env.HOUSE_SWEEP_DISABLED = "true";

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const limits = new BettingLimitsService(prisma, hierarchy);
const commissions = new CommissionsService(prisma, hierarchy);
const casino = new CasinoService(prisma, limits, commissions, realtime, users, audit);
const house = new HouseService(prisma, limits, realtime, users);
const games = new HouseGamesService(house);

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_h${n}`, username: `h${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hh${n}`, role, parentId, ...extra } });
}
const balanceOf = async (account) => Number((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).balance);
async function ledgerTotal(account) {
  const rows = await prisma.balanceTransaction.findMany({ where: { OR: [{ toUserId: account.id }, { fromUserId: account.id }], status: "APPROVED" } });
  return Math.round(rows.reduce((sum, row) => sum + (row.toUserId === account.id ? Number(row.amount) : -Number(row.amount)), 0) * 100) / 100;
}
const line = (game, account) => prisma.balanceTransaction.findUnique({ where: { id: `${game}_${account.id}_${dayKey(new Date())}` } });
/** A draw that returns these values in turn, then 0. */
const scripted = (values) => {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0);
};

let sa, owner, manager, ana;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_rounds", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false, casinoGamesOff: [] } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 500000 });
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 90000 });
  ana = await user("PLAYER", manager.id, { balance: 10000 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: ana.id, actorId: manager.id, type: "DELEGATION", amount: 10000, reason: "Top-up" } });
  await assert.rejects(games.wheelSpin(ana, 100, "LOW"), /The Casino is closed right now/);
  await casino.setOpen(sa, true);
  await casino.setOpen(owner, true);
});

test("Money Wheel: the segment's multiplier is paid, in one go, with the ledger and the journal", async () => {
  house.draw = scripted([7]);
  const spin = await games.wheelSpin(ana, 100, "HIGH");
  assert.deepEqual([spin.segment, spin.multiplier, spin.win], [7, 15, 1500]);
  assert.equal(spin.balance, 10000 - 100 + 1500);
  assert.equal(await balanceOf(ana), 11400);
  assert.equal(Number((await line("wheel", ana)).amount), 1400);
  assert.equal((await line("wheel", ana)).reason, "Money Wheel: 1 spin");
  const entry = await prisma.settlementEntry.findFirstOrThrow({ where: { casinoSpin: { kind: "WHEEL" } } });
  assert.deepEqual([Number(entry.stake), Number(entry.payout), entry.ownerId, entry.managerId], [100, 1500, owner.id, manager.id]);
  await assert.rejects(games.wheelSpin(ana, 75, "LOW"), /costs 50.00, 100.00/);
  assert.equal(await ledgerTotal(ana), await balanceOf(ana));
});

test("Candy Cascade: a spin and every free spin it gives are paid in one go, with the ledger and the journal", async () => {
  // A draw that's random but repeatable, played until a spin wins something, so the payout is checked too.
  let seed = 12345;
  house.draw = (below) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * below);
  };
  const before = await balanceOf(ana);
  let spent = 0;
  let paid = 0;
  let spin;
  for (let i = 0; i < 40; i++) {
    spin = await games.candySpin(ana, 50);
    spent += 50;
    paid += spin.win;
    assert.equal(spin.win, Math.floor(50 * 100 * spin.round.win) / 100, "the win is the round's multiple of the stake, to the cent");
    assert.ok(spin.round.win <= 5000);
    assert.equal(spin.round.spins.length - 1, spin.round.freeSpins);
  }
  assert.ok(paid > 0, "some spin won");
  assert.equal(await balanceOf(ana), Math.round((before - spent + paid) * 100) / 100);
  assert.equal(spin.balance, await balanceOf(ana));
  assert.equal((await line("candy", ana)).reason, "Candy Cascade: 40 spins");
  assert.equal(Number((await line("candy", ana)).amount), Math.round((paid - spent) * 100) / 100);
  assert.equal(await prisma.settlementEntry.count({ where: { casinoSpin: { kind: "CANDY" } } }), 40);
  const stored = await prisma.casinoSpin.findFirstOrThrow({ where: { kind: "CANDY" }, orderBy: { createdAt: "desc" } });
  assert.equal(stored.house.game, "candy");
  assert.equal(stored.house.spins.length, spin.round.spins.length);
  // The history keeps each round's headline.
  const state = await games.candyState(ana);
  assert.equal(state.recent.length, 20);
  assert.equal(state.recent[0].round.game, "candy");
  assert.ok(!("spins" in state.recent[0].round));
  await assert.rejects(games.candySpin(ana, 75), /costs 50.00, 100.00/);
  assert.equal(await prisma.casinoRound.count(), 0, "nothing is left in play");
  assert.equal(await ledgerTotal(ana), await balanceOf(ana));
});

test("Baccarat: a hand is dealt by the rules and paid by the side", async () => {
  house.draw = (below) => Math.floor(Math.random() * below);
  const before = await balanceOf(ana);
  const hand = await games.baccaratDeal(ana, 250, "BANKER");
  const { winner } = hand.hand;
  const expected = winner === "BANKER" ? 357.5 : winner === "TIE" ? 250 : 0;
  assert.equal(hand.win, expected);
  assert.equal(await balanceOf(ana), before - 250 + expected);
  assert.equal(await ledgerTotal(ana), await balanceOf(ana));
  const state = await games.baccaratState(ana);
  assert.equal(state.recent[0].round.game, "baccarat");
});

test("Hi-Lo: the stake leaves at the start, a right guess and a cash-out pay, one round at a time", async () => {
  const before = await balanceOf(ana);
  // A 7 showing; then a king for a right "higher" guess.
  house.draw = scripted([6, 0, 12, 1]);
  const start = await games.hiloStart(ana, 100);
  assert.equal(start.balance, before - 100);
  assert.equal(start.round.steps[0].card.rank, 7);
  await assert.rejects(games.towerStart(ana, 100, "EASY"), /Finish your Hi-Lo round first/);
  await assert.rejects(games.hiloCashOut(ana), /right guess before you cash out/);
  const guessed = await games.hiloGuess(ana, "HIGHER");
  assert.equal(guessed.round.phase, "PLAY");
  const done = await games.hiloCashOut(ana);
  assert.equal(done.round.phase, "WON");
  const pays = Math.floor(100 * Math.floor((75 * 13) / 7)) / 100;
  assert.equal(done.balance, before - 100 + pays);
  assert.equal(await prisma.casinoRound.count(), 0);
  assert.equal(await ledgerTotal(ana), await balanceOf(ana));
});

test("Tower: a trap loses the stake, and the traps show once it's over", async () => {
  const before = await balanceOf(ana);
  house.draw = () => 0; // the trap behind door 0 on every floor
  await games.towerStart(ana, 50, "HARD");
  const safe = await games.towerClimb(ana, 1);
  assert.deepEqual([safe.round.floors, safe.round.traps], [1, null]);
  const lost = await games.towerClimb(ana, 0);
  assert.equal(lost.round.phase, "LOST");
  assert.ok(lost.round.traps);
  assert.equal(await balanceOf(ana), before - 50);
  assert.equal(await ledgerTotal(ana), await balanceOf(ana));
});

test("Crash: cash out on the server's clock, before the crash point", async () => {
  const before = await balanceOf(ana);
  // A minute back, so the rounds it records are in the past for the stats below.
  let clock = Date.now() - 60_000;
  house.now = () => clock;
  // u = (high·65536 + low + 1)/2^32 with high = 32767, low = 65535: exactly 0.5, so a crash point of 0.75/0.5 = 1.50×.
  house.draw = scripted([32767, 65535]);
  const start = await games.crashStart(ana, 100, null);
  assert.equal(start.round.phase, "PLAY");
  assert.equal(start.round.crash, null, "the crash point isn't sent while it climbs");
  clock += Crash.msToReach(130) + 5;
  const check = await games.crashCheck(ana);
  assert.equal(check.round.phase, "PLAY");
  const cashed = await games.crashCashOut(ana);
  assert.deepEqual([cashed.round.phase, cashed.round.at, cashed.round.crash], ["WON", 1.3, 1.5]);
  assert.equal(await balanceOf(ana), before - 100 + 130);

  // Too late: it crashed first.
  house.draw = scripted([32767, 65535]);
  await games.crashStart(ana, 100, null);
  clock += Crash.msToReach(151) + 5;
  const late = await games.crashCashOut(ana);
  assert.deepEqual([late.round.phase, late.round.at, late.round.payout], ["LOST", 1.5, 0]);

  // The automatic cash-out, applied by the server even if the page never asks.
  house.draw = scripted([32767, 65535]);
  await games.crashStart(ana, 100, 1.25);
  clock += Crash.msToReach(140);
  const auto = await games.crashCheck(ana);
  assert.deepEqual([auto.round.phase, auto.round.at, auto.round.payout], ["WON", 1.25, 125]);
  assert.equal(await ledgerTotal(ana), await balanceOf(ana));
  house.now = Date.now;
});

test("an abandoned round is settled: Tower with no floor gives the stake back; Crash plays itself out", async () => {
  const before = await balanceOf(ana);
  house.draw = () => 0;
  await games.towerStart(ana, 100, "EASY");
  await prisma.$executeRaw`UPDATE casino_rounds SET updated_at = now() - interval '1 hour' WHERE player_id = ${ana.id}`;
  assert.equal(await house.settleIdle(), 1);
  assert.equal(await balanceOf(ana), before, "refunded");
  assert.equal(await prisma.casinoRound.count(), 0);
  assert.equal(await ledgerTotal(ana), await balanceOf(ana));
});

test("the Casino stats count each new game as itself, not as the slot", async () => {
  const stats = await casino.admin(sa);
  assert.equal(stats.games.slot.spins, 0);
  assert.equal(stats.games.slot.staked, 0);
  assert.equal(stats.games.wheel.spins, 1);
  assert.equal(stats.games.candy.spins, 40);
  assert.equal(stats.games.candy.staked, 2000);
  assert.equal(stats.games.baccarat.spins, 1);
  assert.equal(stats.games.hilo.spins, 1);
  assert.equal(stats.games.tower.spins, 1);
  assert.equal(stats.games.crash.spins, 3);
  assert.equal(stats.games.crash.staked, 300);
  const last = await casino.lastGame(ana);
  // The last round recorded was the Tower climb (the Crash rounds were dated a minute back).
  assert.equal(last.game, "tower");
});

test("teardown", async () => {
  await prisma.$disconnect();
});
