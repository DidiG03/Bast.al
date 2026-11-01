// Alerts for matches with open bets, end to end against a real Postgres: a
// goal or a red card tells each Player with open bets on the match once (a
// single or an accumulator leg), with the score, the minute and how many of
// their bets; settled bets and other matches don't; Players who turned off
// money alerts don't get it; and it's never emailed. Like the other
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
delete process.env.RESEND_API_KEY;

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient, Prisma } = require("@prisma/client");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { NotificationsService } = require("../dist/notifications/notifications.service.js");
const { SettlementService } = require("../dist/bets/settlement.service.js");
const { BetsService } = require("../dist/bets/bets.service.js");
const { RiskService } = require("../dist/bets/risk.service.js");
const { BettingLimitsService } = require("../dist/commissions/betting-limits.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");

const prisma = new PrismaClient();
const published = [];
const realtime = { publish: async (userId, event) => void published.push({ userId, event }), publishBalances: async () => undefined, publishTopic: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const notifications = new NotificationsService(prisma, {}, realtime);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const sync = new OddsSyncService(prisma);
const odds = new OddsService(prisma, audit, sync);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, new RiskService(prisma, audit), sync);
const as = (row) => ({ id: row.id, role: row.role, parentId: row.parentId, username: row.username });

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_ma${n}`, username: `ma${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hma${n}`, role, parentId, ...extra } });
}

let owner, alice, bob, carol, match, other, home, away, elsewhere;

test("setup", async () => {
  for (const table of ["live_pauses", "goals_seen", "settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "notification_preferences", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  owner = await user("OWNER", null);
  alice = await user("PLAYER", owner.id);
  bob = await user("PLAYER", owner.id);
  carol = await user("PLAYER", owner.id);
  const event = (name, homeTeam, awayTeam) => prisma.event.create({ data: { name, homeTeam, awayTeam, league: "Super League", startsAt: new Date(Date.now() - 30 * 60_000), status: "LIVE", homeScore: 0, awayScore: 0, elapsed: 30 } });
  match = await event("Iraklis v PAOK", "Iraklis", "PAOK");
  other = await event("Levante v Atletico Madrid", "Levante", "Atletico Madrid");
  const pick = async (eventId, key) => {
    const market = await prisma.market.create({ data: { eventId, key: "match_winner", name: "Match winner" } });
    return prisma.selection.create({ data: { marketId: market.id, key, name: key, feedOdds: new Prisma.Decimal(2) } });
  };
  home = await pick(match.id, "home");
  away = await prisma.selection.create({ data: { marketId: home.marketId, key: "away", name: "away", feedOdds: new Prisma.Decimal(3) } });
  elsewhere = await pick(other.id, "home");
  const stake = new Prisma.Decimal(10);
  // Alice: two singles on the match. Bob: an accumulator with a leg on it. Carol: only a settled bet on it, and one elsewhere.
  await prisma.bet.create({ data: { playerId: alice.id, stake, selectionId: home.id, status: "OPEN" } });
  await prisma.bet.create({ data: { playerId: alice.id, stake, selectionId: away.id, status: "OPEN" } });
  await prisma.bet.create({ data: { playerId: bob.id, stake, kind: "ACCUMULATOR", status: "OPEN", legs: { create: [{ selectionId: elsewhere.id, odds: new Prisma.Decimal(2), description: "Levante" }, { selectionId: away.id, odds: new Prisma.Decimal(3), description: "PAOK" }] } } });
  await prisma.bet.create({ data: { playerId: carol.id, stake, selectionId: home.id, status: "LOST", settledAt: new Date() } });
  await prisma.bet.create({ data: { playerId: carol.id, stake, selectionId: elsewhere.id, status: "OPEN" } });
});

test("a goal tells each Player with open bets on the match, once, with the score and minute", async () => {
  published.length = 0;
  const told = await settlement.alertOpenBets(match.id, { kind: "goal", home: 0, away: 1, minute: 34, side: "away" });
  assert.equal(told, 2);
  const rows = await prisma.notification.findMany({ where: { type: "MATCH_ALERT" }, orderBy: { userId: "asc" } });
  assert.equal(rows.length, 2);
  const forAlice = rows.find((row) => row.userId === alice.id);
  const forBob = rows.find((row) => row.userId === bob.id);
  assert.equal(forAlice.title, "Goal in Iraklis v PAOK");
  assert.equal(forAlice.message, "It's 0–1 (34'). You have 2 open bets on this match.");
  assert.equal(forBob.message, "It's 0–1 (34'). You have an open bet on this match.", "an accumulator leg counts");
  assert.equal(forAlice.metadata.deepLink, "/dashboard/bet?tab=open");
  assert.ok(!rows.some((row) => row.userId === carol.id), "a settled bet, or a bet on another match, doesn't");
  assert.equal(published.filter((item) => item.event.type === "notification.created").length, 2, "each gets it as a pop-up too");
});

test("a red card names the team; Players who turned money alerts off don't get it", async () => {
  await prisma.notification.deleteMany({});
  await prisma.notificationPreference.create({ data: { userId: bob.id, financeEnabled: false } });
  await settlement.alertOpenBets(match.id, { kind: "red", home: 0, away: 1, minute: 52, side: "home" });
  const rows = await prisma.notification.findMany({ where: { type: "MATCH_ALERT" } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, alice.id);
  assert.equal(rows[0].title, "Red card in Iraklis v PAOK");
  assert.equal(rows[0].message, "A red card for Iraklis (52'). You have 2 open bets on this match.");
  assert.equal(await settlement.alertOpenBets(match.id, { kind: "red", home: 0, away: 1, minute: 60, side: null }), 0, "a red card for a side we can't tell isn't sent");
});

test("bet again: a settled bet's picks at today's prices, and which can still be bet on", async () => {
  const later = await prisma.event.create({ data: { name: "Tirana v Partizani", homeTeam: "Tirana", awayTeam: "Partizani", league: "Superliga", startsAt: new Date(Date.now() + 86_400_000), status: "UPCOMING" } });
  const market = await prisma.market.create({ data: { eventId: later.id, key: "match_winner", name: "Match winner" } });
  const tirana = await prisma.selection.create({ data: { marketId: market.id, key: "home", name: "Tirana", feedOdds: new Prisma.Decimal("2.50") } });
  const settled = await prisma.bet.create({
    data: {
      playerId: carol.id,
      stake: new Prisma.Decimal(20),
      kind: "ACCUMULATOR",
      status: "LOST",
      settledAt: new Date(),
      legs: { create: [{ selectionId: tirana.id, odds: new Prisma.Decimal("2.40"), description: "Tirana", sortOrder: 0 }, { selectionId: home.id, odds: new Prisma.Decimal(2), description: "Iraklis", sortOrder: 1 }] },
    },
  });
  const again = await bets.again(as(carol), settled.id);
  assert.equal(again.kind, "ACCUMULATOR");
  assert.equal(again.stake, 20);
  assert.deepEqual(again.picks.map((pick) => [pick.name, pick.eventName, pick.market, pick.open]), [
    ["Tirana", "Tirana v Partizani", "Match winner", true],
    ["home", "Iraklis v PAOK", "Match winner", false],
  ], "in slip order; the match being played has no live price, so it can't be bet on now");
  assert.ok(again.picks[0].odds > 1, "today's price, not the one the bet was placed at");
  await assert.rejects(() => bets.again(as(alice), settled.id), /Bet not found/, "only the Player's own bets");
});

test.after(() => prisma.$disconnect());
