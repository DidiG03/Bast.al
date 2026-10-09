// Book of Ra, end to end against a real Postgres: paid spins moving Bast.al
// credit, a round of free spins kept between requests and paid as it plays,
// retriggers, the 5,000x cap, double or nothing on the round, limits, and
// the round blocking a team move. Like the other integration tests it
// empties tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { firstValueFrom, from } = require("rxjs");
const { BookService } = require("../dist/casino/book.service.js");
const { CasinoService } = require("../dist/casino/casino.service.js");
const { LINES, MAX_WIN, PAYING, spin } = require("../dist/casino/book.js");
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
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const limits = new BettingLimitsService(prisma, hierarchy);
const commissions = new CommissionsService(prisma, hierarchy);
const casino = new CasinoService(prisma, limits, commissions, realtime, users, audit);
const book = new BookService(prisma, limits, realtime, users, audit);

/** A seeded draw (mulberry32), to find reel stops for the spin a test needs. */
function seeded(seed) {
  let state = seed >>> 0;
  return (below) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
  };
}
/** Reel stops for the first seeded spin `wanted` accepts (as a free spin with `special`, if given). */
function stopsWhere(wanted, special = null) {
  for (let seed = 1; seed < 500_000; seed++) {
    const result = spin(special, seeded(seed));
    if (wanted(result)) return result.stops;
  }
  throw new Error("no such spin");
}
/** Makes the next spins land on these stops, then draws these numbers (the special symbol). */
const script = (...values) => {
  const queue = values.flat();
  book.draw = (below) => {
    if (queue.length === 0) throw new Error("the test ran out of draws");
    const value = queue.shift();
    assert.ok(value < below);
    return value;
  };
};
const EXPLORER = PAYING.indexOf("EXPLORER");
const losing = stopsWhere((s) => s.win === 0);
const losingFree = stopsWhere((s) => s.win === 0, "EXPLORER");
const trigger = stopsWhere((s) => s.scatter?.count === 3 && s.lines.length === 0);
const expanding = stopsWhere((s) => s.expansion?.reels.length === 3 && s.lines.length === 0 && !s.scatter, "EXPLORER");
const retrigger = stopsWhere((s) => s.scatter?.count === 3, "EXPLORER");

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_bk${n}`, username: `bk${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hbk${n}`, role, parentId, ...extra } });
}
const balanceOf = async (account) => Number((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).balance);
async function ledgerTotal(account) {
  const rows = await prisma.balanceTransaction.findMany({ where: { OR: [{ toUserId: account.id }, { fromUserId: account.id }], status: "APPROVED" } });
  return Math.round(rows.reduce((sum, row) => sum + (row.toUserId === account.id ? Number(row.amount) : -Number(row.amount)), 0) * 100) / 100;
}
const todaysLine = (account) => prisma.balanceTransaction.findUnique({ where: { id: `book_${account.id}_${dayKey(new Date())}` } });

let sa, owner, manager, other, cara;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_spins", "casino_free_spins", "casino_gambles", "casino_book_features", "blackjack_hands", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 5000 });
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 900 });
  other = await user("MANAGER", owner.id, { commissionRate: 20 });
  cara = await user("PLAYER", manager.id, { balance: 100 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: cara.id, actorId: manager.id, type: "DELEGATION", amount: 100, reason: "Top-up" } });
});

test("closed with the Casino's switches, like the other games", async () => {
  script(losing);
  await assert.rejects(book.spin(cara, 1), /The Casino is closed right now/);
  await casino.setOpen(sa, true);
  await casino.setOpen(owner, true);
  assert.equal((await book.state(cara)).closed, null);
  await assert.rejects(book.spin(cara, 3), /Choose a bet of/);
  assert.equal(await balanceOf(cara), 100);
});

test("a losing spin takes the stake, on its own ledger line and in the journal with the team", async () => {
  script(losing);
  const result = await book.spin(cara, 1);
  assert.deepEqual([result.win, result.spin.stake, result.free, result.feature, result.balance], [0, 1, false, null, 99]);
  const line = await todaysLine(cara);
  assert.deepEqual([line.type, Number(line.amount), line.reason], ["CASINO", -1, "Book of Ra: 1 spin"]);
  const entry = await prisma.settlementEntry.findFirstOrThrow({ where: { casinoSpinId: (await prisma.casinoSpin.findFirstOrThrow({ where: { playerId: cara.id, kind: "BOOK" } })).id } });
  assert.deepEqual([entry.ownerId, entry.managerId, Number(entry.stake), Number(entry.payout)], [owner.id, manager.id, 1, 0]);
});

test("3 books start 10 free spins with a special symbol; each costs nothing and pays as it plays, whatever bet is sent", async () => {
  script(trigger, EXPLORER);
  const started = await book.spin(cara, 1);
  assert.equal(started.win, 2, "3 books: twice the bet");
  assert.deepEqual(started.feature, { bet: 1, special: "EXPLORER", remaining: 10, played: 0, won: 2 });
  assert.equal(started.gamble, null, "no double or nothing until the free spins are over");
  assert.equal(await balanceOf(cara), 100, "99, less the $1 bet, plus $2");

  // A free spin: explorers on 3 reels fill them and pay 100 line bets on each of the 10 lines: $100 on a $1 bet.
  script(expanding);
  const free = await book.spin(cara, 10);
  assert.deepEqual([free.free, free.spin.bet, free.spin.stake, free.expansion.reels.length, free.win], [true, 1, 0, 3, 100]);
  assert.deepEqual([free.feature.remaining, free.feature.played, free.feature.won], [9, 1, 102]);
  assert.equal(await balanceOf(cara), 200);

  // The round is kept between requests: the state shows it.
  assert.deepEqual((await book.state(cara)).feature, { bet: 1, special: "EXPLORER", remaining: 9, played: 1, won: 102 });
});

test("3 books in a free spin give 10 more, with the same symbol", async () => {
  script(retrigger);
  const result = await book.spin(cara, 1);
  assert.equal(result.freeSpinsWon, 10);
  assert.deepEqual([result.feature.remaining, result.feature.special], [18, "EXPLORER"]);
});

test("the round ends when the free spins run out, and its total can go to double or nothing", async () => {
  const before = await prisma.casinoBookFeature.findUniqueOrThrow({ where: { playerId: cara.id } });
  let last;
  for (let i = 0; i < before.remaining; i++) {
    script(losingFree);
    last = await book.spin(cara, 1);
  }
  assert.equal(last.feature, null);
  assert.equal(last.featureEnded, Number(before.won));
  assert.deepEqual(last.gamble, { amount: Number(before.won), steps: 0, stepsLeft: 5 });
  assert.equal(await prisma.casinoBookFeature.count(), 0);
  // It's Book of Ra's win: the other slot doesn't offer it.
  assert.equal((await casino.state(cara)).gamble, null);
  assert.deepEqual((await book.state(cara)).gamble, last.gamble);
  const balance = await balanceOf(cara);
  casino.drawSuit = () => 0;
  const guess = await casino.gamble(cara, "BLACK");
  assert.equal(guess.won, false, "hearts: red");
  assert.equal(await balanceOf(cara), balance - Number(before.won));
  const row = await prisma.casinoSpin.findFirstOrThrow({ where: { playerId: cara.id, kind: "GAMBLE" } });
  assert.equal(row.gamble.game, "book");
  const line = await todaysLine(cara);
  assert.equal(line.reason, `Book of Ra: 2 spins, ${await prisma.casinoSpin.count({ where: { playerId: cara.id, kind: "BOOK", free: true } })} free spins`);
  assert.equal(await ledgerTotal(cara), await balanceOf(cara), "the ledger adds up to the balance");
});

test("a round never pays more than 5,000 times the bet", async () => {
  // A round already at $4,999.50 of a $1 bet's $5,000: the next win pays 50 cents and ends it.
  await prisma.casinoBookFeature.create({ data: { playerId: cara.id, bet: 1, special: "EXPLORER", remaining: 5, won: MAX_WIN - 0.5 } });
  script(expanding);
  const result = await book.spin(cara, 1);
  assert.deepEqual([result.win, result.capped, result.feature, result.featureEnded], [0.5, true, null, MAX_WIN]);
});

test("free spins can't be bought: the max stake, daily loss limit and a low balance only stop paid spins", async () => {
  await prisma.bettingLimit.create({ data: { playerId: cara.id, ownerMaxStake: 1 } });
  script(losing);
  await assert.rejects(book.spin(cara, 2), /The most this Player can stake on one bet is 1\.00 ALL/);
  await prisma.bettingLimit.update({ where: { playerId: cara.id }, data: { ownerMaxStake: null, ownerDailyLossLimit: 0.01 } });
  script(losing);
  await assert.rejects(book.spin(cara, 0.5), /daily loss limit/);
  const balance = await balanceOf(cara);
  await prisma.user.update({ where: { id: cara.id }, data: { balance: 0 } });
  // A round of free spins still plays.
  await prisma.casinoBookFeature.create({ data: { playerId: cara.id, bet: 1, special: "EXPLORER", remaining: 2, won: 0 } });
  script(losingFree);
  assert.equal((await book.spin(cara, 1)).free, true);
  await prisma.bettingLimit.delete({ where: { playerId: cara.id } });
  await prisma.user.update({ where: { id: cara.id }, data: { balance } });
});

test("a Player in the middle of free spins waits to be moved", async () => {
  await assert.rejects(users.reassignPlayer(owner, cara.id, other.id), /in the middle of Book of Ra free spins/);
  script(losingFree);
  await book.spin(cara, 1);
  assert.equal(await prisma.casinoBookFeature.count(), 0);
});

test("the same spin request sent twice spins once", async () => {
  script(losing, losing);
  const interceptor = new IdempotencyInterceptor(prisma);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ actor: { id: cara.id }, headers: { "idempotency-key": "book-key-0123456789" }, originalUrl: "/casino/book/spin", path: "/casino/book/spin", method: "POST", body: { bet: 0.5 } }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  };
  const send = () => firstValueFrom(interceptor.intercept(context, { handle: () => from(book.spin(cara, 0.5)) }));
  const before = await prisma.casinoSpin.count({ where: { playerId: cara.id } });
  const first = await send();
  const again = await send();
  assert.equal(again.spin.id, first.spin.id);
  assert.equal(await prisma.casinoSpin.count({ where: { playerId: cara.id } }), before + 1);
});

test("Book of Ra counts in commissions, and the Casino page shows it as its own game", async () => {
  const from = startOfDay(new Date()).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const spins = await prisma.casinoSpin.findMany({ where: { playerId: cara.id } });
  const net = Math.round(spins.reduce((sum, s) => sum + Number(s.stake) - Number(s.win), 0) * 100) / 100;
  const team = await commissions.team(owner, undefined, from, to);
  assert.equal(team.managers.find((row) => row.id === manager.id).net, net);
  const page = await casino.admin(owner, from, to);
  const books = spins.filter((s) => s.kind === "BOOK");
  assert.deepEqual([page.games.book.spins, page.games.book.freeSpins], [books.filter((s) => !s.free).length, books.filter((s) => s.free).length]);
  assert.equal(page.games.book.staked, Math.round(spins.reduce((sum, s) => sum + Number(s.stake), 0) * 100) / 100, "its spins and its double or nothing");
  assert.equal(page.games.slot.staked, 0);
});

test("the data reset clears a round in progress", async () => {
  await prisma.casinoBookFeature.create({ data: { playerId: cara.id, bet: 1, special: "KING", remaining: 3, won: 0 } });
  const clerk = { api: { users: { verifyPassword: async () => ({ verified: true }) } }, deleteUserStrict: async () => undefined };
  await new DataResetService(prisma, clerk, audit, { get: () => undefined }).reset(sa, { username: sa.username, password: "right" });
  assert.equal(await prisma.casinoBookFeature.count(), 0);
});

test("teardown", async () => {
  await prisma.$disconnect();
});

// A line bet is a tenth of the bet.
assert.equal(LINES, 10);
