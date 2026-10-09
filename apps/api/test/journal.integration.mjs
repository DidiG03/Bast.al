// Commission journal, carry-over and negative balances, end to end against a
// real Postgres. It empties the tables it uses, so it only runs against a
// database whose name ends in "_test":
//   createdb bastal_test
//   DATABASE_URL=postgresql://…/bastal_test npx prisma db push --skip-generate
//   DATABASE_URL=postgresql://…/bastal_test npm run test:integration --workspace apps/api
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient, Prisma } = require("@prisma/client");
const { CommissionsService } = require("../dist/commissions/commissions.service.js");
const { CommissionPayoutsService } = require("../dist/commissions/commission-payouts.service.js");
const { PlayerActivityService } = require("../dist/commissions/player-activity.service.js");
const { SettlementService } = require("../dist/bets/settlement.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { teamOf } = require("../dist/bets/team.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const prisma = new PrismaClient();
const D = (v) => new Prisma.Decimal(v);
const sent = [];
const notifications = { create: async (n) => (sent.push(n), n) };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const commissions = new CommissionsService(prisma, hierarchy);
const payouts = new CommissionPayoutsService(prisma, commissions, users);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const activity = new PlayerActivityService(prisma, hierarchy);

// Mondays at midnight in Tirana (summer time, UTC+2), where weeks start.
const W0 = new Date("2026-08-24T00:00:00+02:00");
const W1 = new Date("2026-08-31T00:00:00+02:00");
const W2 = new Date("2026-09-07T00:00:00+02:00");
const W3 = new Date("2026-09-14T00:00:00+02:00");
const W4 = new Date("2026-09-21T00:00:00+02:00");
const iso = (d) => d.toISOString();

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_${n}`, username: `u${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `h${n}`, role, parentId, ...extra } });
}

let sa, owner, managerA, managerB, ardi, bora, selection;

test("setup", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  managerA = await user("MANAGER", owner.id, { commissionRate: 20, balance: 1000 });
  managerB = await user("MANAGER", owner.id, { commissionRate: 30 });
  ardi = await user("PLAYER", managerA.id);
  bora = await user("PLAYER", owner.id);
  const event = await prisma.event.create({ data: { name: "Tirana v Partizani", league: "Superiore", startsAt: W1, status: "COMPLETED", resultHome: 1, resultAway: 0 } });
  const market = await prisma.market.create({ data: { eventId: event.id, key: "match_winner", name: "Match winner" } });
  selection = await prisma.selection.create({ data: { marketId: market.id, key: "home", name: "Tirana", feedOdds: 2 } });
});

/** A bet as bet placement records it, with the team snapshot. */
async function bet(player, { stake, odds = 2, status = "OPEN", payout = 0, settledAt = null, snapshot = true }) {
  const team = snapshot ? await teamOf(prisma, player.id) : {};
  return prisma.bet.create({ data: { playerId: player.id, selectionId: selection.id, stake, odds, status, payout, settledAt, description: "Tirana v Partizani · Match winner: Tirana", ...team } });
}

const movable = { id: true, playerId: true, stake: true, payout: true, status: true, description: true, settledAt: true, ownerId: true, managerId: true, ownerRate: true, managerRate: true };
const reload = (id) => prisma.bet.findUniqueOrThrow({ where: { id }, select: movable });
const entries = (betId) => prisma.settlementEntry.findMany({ where: { betId }, orderBy: { createdAt: "asc" } });

test("bets placed before the journal are filled in once on start", async () => {
  const legacy = await bet(ardi, { stake: 100, status: "LOST", settledAt: new Date("2026-09-02T12:00:00Z"), snapshot: false });
  await settlement.backfillJournal();
  await settlement.backfillJournal();
  const b = await reload(legacy.id);
  assert.equal(b.ownerId, owner.id);
  assert.equal(b.managerId, managerA.id);
  assert.equal(Number(b.ownerRate), 10);
  assert.equal(Number(b.managerRate), 20);
  const rows = await entries(legacy.id);
  assert.equal(rows.length, 1, "run twice, written once");
  assert.deepEqual([rows[0].bets, Number(rows[0].stake), Number(rows[0].payout)], [1, 100, 0]);
  assert.equal(iso(rows[0].createdAt), "2026-09-02T12:00:00.000Z", "dated when it settled");
  await prisma.settlementEntry.deleteMany({ where: { betId: legacy.id } });
  await prisma.balanceTransaction.deleteMany({ where: { betId: legacy.id } });
  await prisma.bet.delete({ where: { id: legacy.id } });
});

test("a correction keeps the bet's settled date and journals only the difference, today", async () => {
  const b = await bet(ardi, { stake: 50 });
  await settlement.move(await reload(b.id), "LOST", D(0), null);
  const settledAt = (await reload(b.id)).settledAt;
  await settlement.move(await reload(b.id), "WON", D(100), null, sa.id);
  const after = await reload(b.id);
  assert.equal(iso(after.settledAt), iso(settledAt), "settled date unchanged by the correction");
  const rows = await entries(b.id);
  assert.deepEqual(rows.map((r) => [r.bets, Number(r.stake), Number(r.payout)]), [[1, 50, 0], [0, 0, 100]]);
  // Voiding takes it back out entirely.
  await settlement.move(await reload(b.id), "VOID", D(50), "Placed at a wrong price", sa.id);
  const all = await entries(b.id);
  const sum = all.reduce((s, r) => [s[0] + r.bets, s[1] + Number(r.stake), s[2] + Number(r.payout)], [0, 0, 0]);
  assert.deepEqual(sum, [0, 0, 0], "a void bet counts for nothing");
});

test("a bet settled before the journal, corrected before the backfill ran, still adds up", async () => {
  const b = await bet(ardi, { stake: 40, status: "LOST", settledAt: new Date("2026-09-03T10:00:00Z"), snapshot: false });
  await settlement.move(await reload(b.id), "WON", D(80), null, sa.id);
  const rows = await entries(b.id);
  assert.deepEqual(rows.map((r) => [r.id.startsWith("bf_"), r.bets, Number(r.stake), Number(r.payout)]), [[true, 1, 40, 0], [false, 0, 0, 80]]);
  assert.equal(iso(rows[0].createdAt), "2026-09-03T10:00:00.000Z");
  await settlement.backfillJournal();
  assert.equal((await entries(b.id)).length, 2, "the backfill doesn't add it again");
});

test("a correction that takes the balance below zero warns the Manager and Owner", async () => {
  const b = await bet(bora, { stake: 100 });
  await settlement.move(await reload(b.id), "WON", D(200), null);
  await prisma.user.update({ where: { id: bora.id }, data: { balance: 0 } }); // the winnings were taken back already
  sent.length = 0;
  await settlement.correctResult(sa, (await prisma.event.findFirstOrThrow()).id, 0, 1);
  const player = await prisma.user.findUniqueOrThrow({ where: { id: bora.id } });
  assert.equal(Number(player.balance), -200);
  const warnings = sent.filter((s) => s.title === "Balance below zero");
  assert.deepEqual(warnings.map((w) => w.userId), [owner.id], "Bora sits under the Owner, so only the Owner is told");
  assert.equal(warnings[0].message, `${bora.username}'s balance is -200.00 ALL after a result was corrected. Their next top-up pays it off first.`);
  // A Super Admin adjustment can bring it back up in part, even while it stays below zero.
  await users.adjustBalance(sa, bora.id, { amount: 50, reason: "Partial settlement of debt" });
  assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: bora.id } })).balance), -150);
  // Clean up so the commission tests start from nothing.
  await prisma.settlementEntry.deleteMany({});
  await prisma.balanceTransaction.deleteMany({});
  await prisma.bet.deleteMany({});
  await prisma.event.update({ where: { id: (await prisma.event.findFirstOrThrow()).id }, data: { resultHome: 1, resultAway: 0 } });
});

/** One journal row, as settling a bet writes it, on a chosen day. */
async function settled(player, { stake, payout, at }) {
  const b = await bet(player, { stake });
  await settlement.move(await reload(b.id), payout > 0 ? "WON" : "LOST", D(payout), null);
  await prisma.settlementEntry.updateMany({ where: { betId: b.id }, data: { createdAt: at } });
  return b;
}

test("reports come from the team and rates when the bet was placed", async () => {
  await settled(ardi, { stake: 1000, payout: 0, at: new Date("2026-09-15T10:00:00Z") }); // week 3: Ardi loses 1000
  await settled(bora, { stake: 300, payout: 0, at: new Date("2026-09-16T10:00:00Z") }); // week 3: Bora loses 300
  // Afterwards Manager A's rate goes up and Ardi moves to Manager B.
  await prisma.user.update({ where: { id: managerA.id }, data: { commissionRate: 50 } });
  await prisma.user.update({ where: { id: ardi.id }, data: { parentId: managerB.id } });

  const team = await commissions.team(owner, undefined, iso(W3), iso(W4));
  const a = team.managers.find((m) => m.id === managerA.id);
  const b = team.managers.find((m) => m.id === managerB.id);
  assert.equal(a.commission, 200, "20% of 1000, the rate when Ardi bet");
  assert.equal(a.net, 1000);
  assert.deepEqual(a.players.map((p) => [p.username, p.net, p.commission]), [[ardi.username, 1000, 200]], "Ardi's week-3 result stays with A");
  assert.equal(b.commission, 0);
  assert.deepEqual(b.players.map((p) => [p.username, p.net]), [[ardi.username, 0]], "B lists Ardi now, with nothing from before he moved");
  assert.deepEqual(team.directPlayers.map((p) => [p.username, p.net]), [[bora.username, 300]]);
  assert.equal(team.totals.net, 1300);
  assert.equal(team.totals.superAdminCut, 130);
  assert.equal(team.totals.managerCommission, 200);
  assert.equal(team.totals.ownerKeeps, 970);

  const all = await commissions.owners(sa, iso(W3), iso(W4));
  const o = all.owners.find((x) => x.id === owner.id);
  assert.deepEqual([o.net, o.superAdminCut, o.managerCommission, o.ownerKeeps], [1300, 130, 200, 970]);

  const mine = await commissions.mine({ ...managerA, commissionRate: D(50) }, iso(W3), iso(W4));
  assert.equal(mine.totals.commission, 200);

  const daily = await commissions.daily(owner, 31);
  assert.equal(daily.days.reduce((s, d) => s + d.net, 0), 1300);

  const ardiActivity = await activity.activity(sa, ardi.id);
  assert.equal(ardiActivity.summary.allTime.net, 1000);

  // Put things back for the carry-over test.
  await prisma.user.update({ where: { id: managerA.id }, data: { commissionRate: 20 } });
  await prisma.user.update({ where: { id: ardi.id }, data: { parentId: managerA.id } });
  await prisma.settlementEntry.deleteMany({});
  await prisma.balanceTransaction.deleteMany({});
  await prisma.bet.deleteMany({});
});

test("losses carry over: a losing week is made up before anything is paid", async () => {
  const standing = async () => (await commissions.team(owner, undefined, iso(W2), iso(W3))).managers.find((m) => m.id === managerA.id).payout;

  // Week 1: Ardi wins 1000 (A's commission -200). Nothing paid yet, so A's first payment starts where the page's period starts.
  await settled(ardi, { stake: 1000, payout: 2000, at: new Date("2026-09-01T10:00:00Z") });
  // Week 2: Ardi loses 1000 (A's commission +200).
  await settled(ardi, { stake: 1000, payout: 0, at: new Date("2026-09-08T10:00:00Z") });

  // Paying week 1 first isn't possible (below zero), but it records nothing either, so...
  await assert.rejects(payouts.pay(owner, managerA.id, iso(W1), iso(W2)), /nothing to pay yet: losses of 200\.00 ALL/);

  // ...the first payment Owner makes for A starts where they choose. Choose weeks 1-2 together: 200 - 200 = 0.
  const both = (await commissions.team(owner, undefined, iso(W1), iso(W3))).managers.find((m) => m.id === managerA.id).payout;
  assert.deepEqual([both.balance, both.due, both.start], [0, 0, iso(W1)]);

  // Once anything has been paid, every later payment starts where the last one ended.
  await settled(ardi, { stake: 250, payout: 0, at: new Date("2026-08-25T10:00:00Z") }); // the week before: +50 for A
  const first = await payouts.pay(owner, managerA.id, iso(W0), iso(W1));
  assert.equal(first.amount, 50);

  const week2 = await standing();
  assert.equal(week2.start, iso(W1), "covers week 1 too, since the last payment ended there");
  assert.equal(week2.balance, 0, "week 1's -200 cancels week 2's +200");
  assert.equal(week2.due, 0);
  await assert.rejects(payouts.pay(owner, managerA.id, iso(W2), iso(W3)), /no commission to pay/);

  // Week 3: Ardi loses 500 (+100). Now 100 is due, covering weeks 1-3.
  await settled(ardi, { stake: 500, payout: 0, at: new Date("2026-09-15T10:00:00Z") });
  const paid = await payouts.pay(owner, managerA.id, iso(W3), iso(W4));
  assert.equal(paid.amount, 100);
  assert.equal(iso(paid.periodFrom), iso(W1));
  assert.equal(iso(paid.periodTo), iso(W4));
  const ledger = await prisma.balanceTransaction.findFirstOrThrow({ where: { id: (await prisma.commissionPayout.findFirstOrThrow({ where: { id: paid.id } })).transactionId } });
  assert.equal(ledger.reason, "Commission for 31 Aug to 20 Sept");

  // Week 3 is now paid; asking again is refused and says up to when.
  const after = (await commissions.team(owner, undefined, iso(W3), iso(W4))).managers.find((m) => m.id === managerA.id).payout;
  assert.deepEqual([after.start, after.due, after.paidUpTo], [null, 0, iso(W4)]);
  await assert.rejects(payouts.pay(owner, managerA.id, iso(W3), iso(W4)), /already paid up to 20 Sept/);
});

test("Super Admin's cut from an Owner carries over the same way", async () => {
  // The Owner's team so far: -1000 (w1) +1000 (w2) +250 (before) +500 (w3). Collect everything up to week 2 first.
  const first = await payouts.pay(sa, owner.id, iso(W0), iso(W3));
  assert.equal(first.amount, 25, "10% of (250 - 1000 + 1000)");
  const w3 = (await commissions.owners(sa, iso(W3), iso(W4))).owners.find((o) => o.id === owner.id);
  assert.equal(w3.superAdminCut, 50);
  assert.deepEqual([w3.payout.start, w3.payout.due], [iso(W3), 50]);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
