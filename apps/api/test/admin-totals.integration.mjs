// What the Super Admin pages count, end to end against a real Postgres: an
// "Approval needed" alert goes once its transfer is approved or rejected;
// Overview, Finance and a Player's page count sports and casino the same way
// (casino rounds without free spins or double or nothing); Finance counts
// credit once, where it leaves the viewer; a rejected transfer shows in a
// history but moves nothing, and the history adds up to the balance; a late
// void is logged once; and the Live list has only matches in play, with
// postponed ones out of Upcoming. Like the other integration tests it empties
// tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
delete process.env.API_FOOTBALL_KEY;
delete process.env.ODDS_FEED_MOCK;

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { NotificationsService } = require("../dist/notifications/notifications.service.js");
const { CommissionsService } = require("../dist/commissions/commissions.service.js");
const { PlayerActivityService } = require("../dist/commissions/player-activity.service.js");
const { SettlementService } = require("../dist/bets/settlement.service.js");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { periodResults } = require("../dist/commissions/results.js");

const prisma = new PrismaClient();
const realtime = { publish: async () => undefined, publishBalances: async () => undefined, publishTopic: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const notifications = new NotificationsService(prisma, {}, realtime);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const commissions = new CommissionsService(prisma, hierarchy);
const activity = new PlayerActivityService(prisma, hierarchy);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const odds = new OddsService(prisma, audit, new OddsSyncService(prisma));

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_at${n}`, username: `at${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hat${n}`, role, parentId, ...extra } });
}
const as = (row) => ({ id: row.id, role: row.role, parentId: row.parentId, username: row.username });

let sa, owner, manager, player;

test("setup", async () => {
  for (const table of ["live_pauses", "goals_seen", "settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "notification_preferences", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10 });
  manager = await user("MANAGER", owner.id, { commissionRate: 20 });
  player = await user("PLAYER", manager.id);
});

test("an Approval needed alert goes once its transfer is approved or rejected, and an old one when the bell is opened", async () => {
  await users.delegateCredit(as(sa), owner.id, { amount: 500_000, reason: "Float" });
  const first = await users.delegateCredit(as(owner), manager.id, { amount: 100_000, reason: "Big one" });
  const second = await users.delegateCredit(as(owner), manager.id, { amount: 100_000, reason: "Another" });
  assert.equal(first.requiresApproval, true);
  const open = async () => (await notifications.list(as(sa))).items.filter((item) => item.type === "APPROVAL_REQUESTED");
  assert.equal((await open()).length, 2);
  await users.approveBalance(as(sa), first.id, true);
  assert.equal((await open()).length, 1, "approved: its alert is gone");
  // Settled some other way (the transfer rejected directly), without the alert being touched: opening the bell clears it.
  await prisma.balanceTransaction.update({ where: { id: second.id }, data: { status: "REJECTED" } });
  assert.equal((await open()).length, 0);
  assert.equal((await notifications.list(as(sa))).unreadCount, 0, "and it no longer counts as unread");
});

test("Finance counts credit once, where it leaves the viewer; transfers further down are shown apart", async () => {
  // SA → Owner 500,000 (above); Owner → Manager 100,000 (approved); Manager → Player 60,000.
  await users.delegateCredit(as(manager), player.id, { amount: 60_000, reason: "Play" });
  const view = await users.moneyMovements(as(sa), { kind: "transfers" });
  assert.equal(view.summary.given, 500_000, "only what left Super Admin");
  assert.equal(view.summary.withinTeam, 160_000);
  assert.equal(view.summary.net, 500_000);
  const ownerView = await users.moneyMovements(as(owner), { kind: "transfers" });
  assert.equal(ownerView.summary.given, 100_000);
  assert.equal(ownerView.summary.withinTeam, 60_000);
});

test("a rejected transfer shows in the history but moves nothing, and the history adds up to the balance", async () => {
  const ledger = await users.balanceLedger(as(sa), manager.id);
  const rejected = ledger.find((entry) => entry.status === "REJECTED");
  assert.equal(rejected.amount, 100_000);
  assert.equal(rejected.effect, 0);
  const balance = Number((await prisma.user.findUniqueOrThrow({ where: { id: manager.id } })).balance);
  assert.equal(ledger[0].balanceAfter, balance);
  assert.equal(ledger.reduce((sum, entry) => sum + entry.effect, 0), balance, "every move it made adds up to the balance");
  // Read a page at a time, the balance after each entry is the same.
  const page = await users.balanceLedger(as(sa), manager.id, { limit: 1, before: ledger[0].createdAt.toISOString() });
  assert.equal(page[0].balanceAfter, ledger[1].balanceAfter);
});

test("every page counts sports and casino the same way: rounds without free spins or double or nothing", async () => {
  const team = { ownerId: owner.id, managerId: manager.id, ownerRate: 10, managerRate: 20 };
  const event = await prisma.event.create({ data: { name: "A v B", league: "League", startsAt: new Date(Date.now() - 3_600_000), status: "COMPLETED" } });
  const market = await prisma.market.create({ data: { eventId: event.id, key: "match_winner", name: "Match winner" } });
  const selection = await prisma.selection.create({ data: { marketId: market.id, key: "home", name: "A", feedOdds: 2 } });
  const bet = await prisma.bet.create({ data: { playerId: player.id, selectionId: selection.id, stake: 100, odds: 2, status: "LOST", ...team } });
  await prisma.settlementEntry.create({ data: { betId: bet.id, playerId: player.id, ...team, bets: 1, stake: 100, payout: 0 } });
  const spin = (kind, stake, win, free = false) =>
    prisma.casinoSpin.create({ data: { kind, playerId: player.id, ...team, bet: stake || 10, stake, win, free, grid: [], stops: [], lines: {} } });
  for (const [kind, stake, win, free] of [["SPIN", 10, 0, false], ["SPIN", 10, 25, false], ["SPIN", 0, 5, true], ["GAMBLE", 25, 50, false], ["KENO", 50, 0, false]]) {
    const row = await spin(kind, stake, win, free);
    await prisma.settlementEntry.create({ data: { casinoSpinId: row.id, playerId: player.id, ...team, bets: 0, stake, payout: win } });
  }
  const results = await periodResults(prisma, null, { from: null, to: null });
  assert.deepEqual(results.sports, { bets: 1, staked: 100, paidOut: 0, net: 100 });
  assert.deepEqual(results.casino, { rounds: 3, staked: 95, paidOut: 80, net: 15 });
  assert.deepEqual(results.total, { staked: 195, paidOut: 80, net: 115 });
  const overview = await commissions.owners(as(sa));
  assert.deepEqual(overview.results, results, "Overview");
  assert.equal(overview.totals.staked, results.total.staked);
  assert.deepEqual((await users.moneyMovements(as(sa), { kind: "transfers" })).summary.results, results, "Finance");
  const page = await activity.activity(as(manager), player.id);
  assert.equal(page.summary.thisWeek.casinoRounds, 3, "the Player's page");
  assert.equal(page.summary.thisWeek.staked, results.total.staked);
});

test("a late void is logged once, however often the check runs again", async () => {
  const event = await prisma.event.findFirstOrThrow({ where: { name: "A v B" } });
  const bet = await prisma.bet.findFirstOrThrow({ where: { playerId: player.id } });
  const decision = { late: true, reason: "placed after a goal that hadn't shown yet", detail: "test" };
  const target = { kind: "bet", id: bet.id, betId: bet.id, playerId: player.id, live: null, eventId: event.id, eventName: event.name, stake: 100 };
  await settlement.noteLate(target, decision, "settlement", null);
  const live = (await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).live;
  await settlement.noteLate({ ...target, live }, decision, "recheck", null);
  const logged = await prisma.auditLog.findMany({ where: { action: "bet.void_late" } });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].metadata.amount, 100);
});

test("Live lists only matches in play; postponed ones are with the finished, not upcoming", async () => {
  const now = Date.now();
  const make = (name, status, startsAt) => prisma.event.create({ data: { name, league: "League", sport: "football", status, startsAt: new Date(startsAt) } });
  const playing = await make("Playing", "LIVE", now - 30 * 60_000);
  const future = await make("Not started", "LIVE", now + 3 * 3_600_000);
  const postponed = await make("Postponed", "POSTPONED", now + 3_600_000);
  const viewer = as(sa);
  const ids = async (filter) => (await odds.events(viewer, filter)).map((event) => event.id);
  const live = await ids("live");
  assert.ok(live.includes(playing.id));
  assert.ok(!live.includes(future.id), "a kick-off still to come isn't live");
  assert.ok(!(await ids("upcoming")).includes(postponed.id));
  assert.ok((await ids("finished")).includes(postponed.id));
});

test("teardown", async () => {
  await prisma.$disconnect();
});
