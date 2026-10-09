// System bets through the whole hierarchy, against a real Postgres: a
// Yankee on four matches costs 11 lines, counts on each pick in the Owner's
// Risk page, settles line by line as the matches finish (a lost pick only
// losing its lines), pays what working every line out by hand gives, and
// carries its team in the journal; a correction re-settles it; and picks
// from one match or a set that isn't a system are refused. Like the other
// integration tests it empties tables, so it only runs against a database
// whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { SettlementService } = require("../dist/bets/settlement.service.js");
const { BetsService } = require("../dist/bets/bets.service.js");
const { RiskService } = require("../dist/bets/risk.service.js");
const { BettingLimitsService } = require("../dist/commissions/betting-limits.service.js");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { parseMarkets } = require("../dist/odds/api-football.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
for (const name of ["API_FOOTBALL_KEY", "ODDS_FEED_MOCK", "GREYHOUND_API_KEY", "MMA_API_KEY", "TENNIS_API_KEY", "ODDS_API_KEY"]) delete process.env[name];

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const sync = new OddsSyncService(prisma);
const odds = new OddsService(prisma, audit, sync);
const risk = new RiskService(prisma, audit);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, risk, sync);

const HOUR = 3_600_000;
let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_sy${n}`, username: `sy${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hsy${n}`, role, parentId, ...extra } });
}
const actor = (u) => ({ id: u.id, role: u.role, parentId: u.parentId });
const pick = (externalId, market, key) => prisma.selection.findFirstOrThrow({ where: { key, market: { key: market, event: { externalId } } } });
const priceFor = async (who, selection) => (await odds.selections(actor(who), [selection.id]))[0].price;
const paid = (stake, price) => Math.floor(stake * Number(price) * 100 + 1e-6) / 100;

let sa, owner, player;
const matches = [["M1", "Tirana v Partizani", 2.0], ["M2", "Vllaznia v Egnatia", 3.0], ["M3", "Teuta v Dinamo", 1.5], ["M4", "Laçi v Bylis", 4.0]];

test("setup: one team, four matches", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "platform_settings", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  // No margin, so the prices are the feed's and the sums below are easy to check.
  await prisma.platformSettings.create({ data: { id: "default", baseOddsMargin: 0 } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  const manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 1000 });
  player = await user("PLAYER", manager.id, { balance: 200 });
  for (const [externalId, name, home] of matches) {
    const [h, a] = name.split(" v ");
    const event = await prisma.event.create({ data: { sport: "football", provider: "api-football", externalId, name, league: "Abissnet Superiore", homeTeam: h, awayTeam: a, startsAt: new Date(Date.now() + 4 * HOUR) } });
    await sync.upsertMarkets(event.id, parseMarkets({ fixture: { id: 1 }, bookmakers: [{ id: 8, name: "Bet365", bets: [{ id: 1, name: "Match Winner", values: [{ value: "Home", odd: String(home) }, { value: "Draw", odd: "3.3" }, { value: "Away", odd: "3.6" }] }] }] }, h, a, 8));
  }
});

const homes = () => Promise.all(matches.map(([id]) => pick(id, "match_winner", "home")));
const legsOf = async (selections) => Promise.all(selections.map(async (s) => ({ selectionId: s.id, odds: await priceFor(player, s) })));

test("a Yankee costs 11 lines and counts on every pick at the most it can return", async () => {
  const selections = await homes();
  const placed = await bets.place(actor(player), { system: { legs: await legsOf(selections), sizes: [4, 3, 2], lineStake: 1 } });
  const bet = placed.bets[0];
  assert.equal(bet.kind, "SYSTEM");
  assert.equal(bet.stake, 11);
  assert.deepEqual(bet.system, { name: "Yankee", sizes: [2, 3, 4], lineStake: 1, lines: 11, maxReturn: 138.5 });
  assert.equal(bet.potentialPayout, 138.5);
  assert.equal(bet.description, "Yankee · 4 picks · 11 bets");
  assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: player.id } })).balance), 189);
  const exposure = await risk.exposure(prisma, owner.id, selections.map((s) => s.id));
  for (const s of selections) assert.equal(exposure.get(s.id).accumulators.payout >= 138.5, true);
});

test("picks from one match, or a set that isn't a system, are refused", async () => {
  const selections = await homes();
  const draw = await pick("M1", "match_winner", "draw");
  await assert.rejects(bets.place(actor(player), { system: { legs: await legsOf([...selections.slice(0, 3), draw]), sizes: [2], lineStake: 1 } }), /one pick from each match/);
  await assert.rejects(bets.place(actor(player), { system: { legs: await legsOf(selections), sizes: [4], lineStake: 1 } }), /Choose a system/);
  await assert.rejects(bets.place(actor(player), { system: { legs: await legsOf(selections.slice(0, 3)), sizes: [2, 3], lineStake: 0.1 } }), /at least 1 ALL/);
});

test("it settles line by line: a lost pick only loses its lines", async () => {
  const settle = async (externalId, home, away) => {
    const event = await prisma.event.findFirstOrThrow({ where: { externalId } });
    await prisma.event.update({ where: { id: event.id }, data: { startsAt: new Date(Date.now() - 3 * HOUR) } });
    await settlement.correctResult({ id: sa.id, role: "SUPER_ADMIN" }, event.id, home, away);
  };
  const bet = () => prisma.bet.findFirstOrThrow({ where: { playerId: player.id, kind: "SYSTEM" } });
  await settle("M1", 2, 0);
  await settle("M2", 1, 0);
  await settle("M3", 3, 1);
  assert.equal((await bet()).status, "OPEN", "one match still to play");
  await settle("M4", 0, 1); // the 4.00 pick lost
  // By hand: doubles 6 + 3 + 4.5, treble 9 = 22.50 from the 4 lines without the 4.00 pick.
  const settled = await bet();
  assert.deepEqual([settled.status, Number(settled.payout)], ["WON", 22.5]);
  assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: player.id } })).balance), 189 + 22.5);
  const journal = await prisma.settlementEntry.findFirstOrThrow({ where: { betId: settled.id } });
  assert.deepEqual([journal.ownerId, Number(journal.stake), Number(journal.payout)], [owner.id, 11, 22.5]);

  // Corrected: the 4.00 pick won after all, so every line pays.
  await settle("M4", 2, 1);
  const corrected = await bet();
  assert.deepEqual([corrected.status, Number(corrected.payout)], ["WON", 138.5]);
  assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: player.id } })).balance), 189 + 138.5);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
