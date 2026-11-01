// A Player's money history searched and filtered, end to end against a real
// Postgres: by days (Albanian time), by kind, by money in or out, by words
// (a match, a game, a reference, who sent it) or an amount; "show more" stays
// inside the filter; and the summary adds up what's shown. Like the other
// integration tests it empties tables, so it only runs against a database
// whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient, Prisma } = require("@prisma/client");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { NotificationsService } = require("../dist/notifications/notifications.service.js");

const prisma = new PrismaClient();
const realtime = { publish: async () => undefined, publishBalances: async () => undefined, publishTopic: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const notifications = new NotificationsService(prisma, {}, realtime);
const users = new UsersService(prisma, {}, hierarchy, new AuditService(prisma), {}, notifications, realtime);

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_ls${n}`, username: `ls${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hls${n}`, role, parentId, ...extra } });
}
const as = (row) => ({ id: row.id, role: row.role, parentId: row.parentId, username: row.username });

let owner, player, other;
// Tirana is UTC+1 in winter: 23:30 UTC on 30 Oct is already 31 Oct there.
const at = (iso) => new Date(iso);

test("setup", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "notifications", "notification_preferences", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  owner = await user("OWNER", null, { balance: 10000 });
  player = await user("PLAYER", owner.id, { balance: 326.86 });
  other = await user("PLAYER", owner.id, { balance: 50 });
  for (const id of ["cbetiraklis56hfmkq5", "cbetlevantefzi1eyn5"]) await prisma.bet.create({ data: { id, playerId: player.id, stake: new Prisma.Decimal(10) } });
  const line = (data) => prisma.balanceTransaction.create({ data: { status: "APPROVED", actorId: owner.id, ...data, amount: new Prisma.Decimal(data.amount) } });
  await line({ type: "DELEGATION", fromUserId: owner.id, toUserId: player.id, amount: 500, reason: "Top-up", createdAt: at("2026-10-20T10:00:00Z") });
  await line({ type: "BET_STAKE", toUserId: player.id, amount: -10, reason: "Bet placed: Iraklis v PAOK · Winner: PAOK", betId: "cbetiraklis56hfmkq5", createdAt: at("2026-10-31T13:20:00Z") });
  await line({ type: "BET_SETTLEMENT", toUserId: player.id, amount: 13.8, reason: "Bet won: Iraklis v PAOK · Winner: PAOK", betId: "cbetiraklis56hfmkq5", createdAt: at("2026-10-31T17:36:00Z") });
  await line({ type: "BET_STAKE", toUserId: player.id, amount: -10, reason: "Bet placed: Levante v Atletico Madrid · Winner: Atletico Madrid", betId: "cbetlevantefzi1eyn5", createdAt: at("2026-10-30T23:30:00Z") });
  await line({ type: "CASINO", toUserId: player.id, amount: -100, reason: "Book of Ra: 4 spins, 1 double or nothing", id: `book_${player.id}_2026-10-31`, createdAt: at("2026-10-31T13:21:00Z") });
  await line({ type: "RECLAIM", fromUserId: player.id, toUserId: owner.id, amount: 20, reason: "Taken back", createdAt: at("2026-10-25T09:00:00Z") });
  // Someone else's line never shows.
  await line({ type: "BET_STAKE", toUserId: other.id, amount: -10, reason: "Bet placed: Iraklis v PAOK · Winner: PAOK", createdAt: at("2026-10-31T13:20:00Z") });
});

test("filters by days on Albanian time, kind, direction, words and amounts", async () => {
  const me = as(player);
  const reasons = (rows) => rows.map((row) => row.reason);
  assert.equal((await users.balanceLedger(me, player.id)).length, 6);
  assert.equal((await users.balanceLedger(me, player.id))[0].balanceAfter, 326.86, "unfiltered: the balance after each line, as before");

  // 31 October in Tirana starts at 23:00 UTC on the 30th: the Levante stake at 23:30 UTC is on the 31st.
  const day = await users.balanceLedger(me, player.id, { from: "2026-10-31", to: "2026-10-31" });
  assert.equal(day.length, 4);
  assert.ok(reasons(day).some((reason) => reason.includes("Levante")));
  assert.equal(day[0].balanceAfter, undefined, "a filtered list has no running balance");
  assert.equal((await users.balanceLedger(me, player.id, { from: "2026-10-21", to: "2026-10-30" })).length, 1, "only the take-back on the 25th");

  assert.equal((await users.balanceLedger(me, player.id, { kind: "bets" })).length, 3);
  assert.equal((await users.balanceLedger(me, player.id, { kind: "casino" })).length, 1);
  assert.deepEqual(reasons(await users.balanceLedger(me, player.id, { kind: "topups" })).sort(), ["Taken back", "Top-up"]);

  assert.deepEqual(reasons(await users.balanceLedger(me, player.id, { direction: "in" })).sort(), ["Bet won: Iraklis v PAOK · Winner: PAOK", "Top-up"]);
  assert.equal((await users.balanceLedger(me, player.id, { direction: "out" })).length, 4, "two stakes, the casino loss and the take-back");

  assert.equal((await users.balanceLedger(me, player.id, { q: "paok" })).length, 2, "a team, either case");
  assert.equal((await users.balanceLedger(me, player.id, { q: "book of ra" })).length, 1, "a game");
  assert.equal((await users.balanceLedger(me, player.id, { q: "fzi1eyn5" })).length, 1, "a reference");
  assert.equal((await users.balanceLedger(me, player.id, { q: owner.username })).length, 2, "who sent or took it");
  assert.equal((await users.balanceLedger(me, player.id, { q: "100" })).length, 1, "an amount, spent or received");
  assert.equal((await users.balanceLedger(me, player.id, { q: "13,80" })).length, 1, "with a comma");
  assert.equal((await users.balanceLedger(me, player.id, { q: "PAOK", kind: "bets", direction: "in" })).length, 1, "filters combine");

  await assert.rejects(() => users.balanceLedger(me, player.id, { from: "31/10/2026" }), /date like/);
  await assert.rejects(() => users.balanceLedger(me, player.id, { kind: "everything" }), /Kind must be/);
});

test("show more stays inside the filter, and the summary adds up what's shown", async () => {
  const me = as(player);
  const first = await users.balanceLedger(me, player.id, { kind: "bets", limit: 2 });
  assert.equal(first.length, 2);
  const rest = await users.balanceLedger(me, player.id, { kind: "bets", limit: 2, before: first[1].createdAt.toISOString() });
  assert.equal(rest.length, 1);
  assert.ok(rest.every((row) => row.type.startsWith("BET_")));

  assert.deepEqual(await users.balanceLedgerSummary(me, player.id, { from: "2026-10-31", to: "2026-10-31" }), { count: 4, in: 13.8, out: 120, net: -106.2 });
  assert.deepEqual(await users.balanceLedgerSummary(me, player.id), { count: 6, in: 513.8, out: 140, net: 373.8 });
  await assert.rejects(() => users.balanceLedgerSummary(as(other), player.id), /outside your hierarchy/);
});

test.after(() => prisma.$disconnect());
