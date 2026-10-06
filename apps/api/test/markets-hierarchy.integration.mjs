// The markets added across the sports, through the whole hierarchy, against
// a real Postgres: two teams on different margins, an Owner's own price on a
// new market that only their team sees, Managers seeing their Owner's prices,
// bets from both teams on football handicaps, basketball quarters and team
// totals, and a tennis line, then settling, with every bet's journal row
// carrying its team (so Commissions count it) and the Owner's Risk page
// counting the open ones. Like the other integration tests it empties
// tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const { BasketballSyncService } = require("../dist/odds/basketball-sync.service.js");
const { TennisSyncService } = require("../dist/odds/tennis-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { parseApiSportsOdds, parseGame } = require("../dist/odds/basketball.js");
const { parseMarkets } = require("../dist/odds/api-football.js");
const { parseTennisMatch, parseTennisOdds } = require("../dist/odds/tennis.js");

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
const basketball = new BasketballSyncService(prisma, sync);
const tennis = new TennisSyncService(prisma, sync);
const odds = new OddsService(prisma, audit, sync);
const risk = new RiskService(prisma, audit);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, risk, sync);

const read = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const games = (await read("basketball-games.json")).response;
const euroOdds = (await read("basketball-odds.json")).response;
const tennisMatches = (await read("tennis-fixtures.json")).result;
const tennisOdds = (await read("tennis-odds.json")).result;

const HOUR = 3_600_000;
let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_mh${n}`, username: `mh${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hmh${n}`, role, parentId, ...extra } });
}
const actor = (u) => ({ id: u.id, role: u.role, parentId: u.parentId });
const pick = (externalId, market, key) => prisma.selection.findFirstOrThrow({ where: { key, market: { key: market, event: { externalId } } } });
const priceFor = async (who, selection) => (await odds.selections(actor(who), [selection.id]))[0].price;
const paid = (stake, price) => Math.floor(stake * Number(price) * 100 + 1e-6) / 100;

let sa, ownerA, managerA, playerA, ownerB, managerB, playerB;
let bbEvent;

test("setup: two teams, A on a higher margin", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "platform_settings", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.create({ data: { id: "default", baseOddsMargin: 5 } });
  sa = await user("SUPER_ADMIN", null);
  ownerA = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  managerA = await user("MANAGER", ownerA.id, { commissionRate: 20, balance: 1000 });
  playerA = await user("PLAYER", managerA.id, { balance: 200 });
  ownerB = await user("OWNER", sa.id, { commissionRate: 12, balance: 10000 });
  managerB = await user("MANAGER", ownerB.id, { commissionRate: 25, balance: 1000 });
  playerB = await user("PLAYER", managerB.id, { balance: 200 });
  await odds.setTeamMargin(actor(ownerA), 3);
});

test("the new markets are priced per team: margins and an Owner's own price", async () => {
  // A basketball game with every market the sample has, a football match with handicaps, a tennis match with games lines.
  const game = { ...parseGame(games.find((g) => g.id === 509592)), startsAt: new Date(Date.now() + 5 * HOUR) };
  bbEvent = await basketball.saveGame(game);
  await sync.upsertMarkets(bbEvent, parseApiSportsOdds(euroOdds.find((o) => o.game.id === 509592), game.home, game.away, 4));
  const football = await prisma.event.create({ data: { sport: "football", provider: "api-football", externalId: "F1", name: "Tirana v Partizani", league: "Abissnet Superiore", homeTeam: "Tirana", awayTeam: "Partizani", startsAt: new Date(Date.now() + 4 * HOUR) } });
  const bet = (name, values) => ({ id: 0, name, values: Object.entries(values).map(([value, odd]) => ({ value, odd: String(odd) })) });
  await sync.upsertMarkets(
    football.id,
    parseMarkets({ fixture: { id: 1 }, bookmakers: [{ id: 8, name: "Bet365", bets: [bet("Match Winner", { Home: 2, Draw: 3.4, Away: 3.6 }), bet("Asian Handicap", { "Home -0.5": 2, "Away -0.5": 1.85 }), bet("Handicap Result", { "Home -1": 3.6, "Draw -1": 3.7, "Away -1": 1.9 })] }] }, "Tirana", "Partizani", 8),
  );
  const match = { ...parseTennisMatch(tennisMatches.find((m) => m.event_key === "12077001")), externalId: "T1", startsAt: new Date(Date.now() + 3 * HOUR) };
  await sync.upsertMarkets(await tennis.saveMatch(match), parseTennisOdds(tennisOdds["12077001"], match.home, match.away, "bet365"));

  const q1 = await pick("509592", "bb_q1_winner", "home");
  // Feed 2.55: team B at the 5% base margin, team A at 5% + 3%.
  assert.equal(await priceFor(playerB, q1), 2.42);
  assert.equal(await priceFor(playerA, q1), 2.34);
  assert.equal(await priceFor(managerA, q1), 2.34, "a Manager sees their Owner's price");

  // Owner A prices Verona's 1st quarter themselves: only their team gets it.
  await odds.setOverride(actor(ownerA), q1.id, 2.6);
  assert.equal(await priceFor(playerA, q1), 2.6);
  assert.equal(await priceFor(managerA, q1), 2.6);
  assert.equal(await priceFor(playerB, q1), 2.42, "team B keeps its own price");
  await assert.rejects(odds.setOverride(actor(managerA), q1.id, 2.7), "a Manager can't set prices");

  // The full game lists every new market for both teams.
  const forA = await odds.event(actor(playerA), bbEvent);
  assert.ok(forA.markets.length > 70);
  assert.ok(["bb_h1_total_84_5", "bb_q4_handicap_1_5", "bb_home_total_81_5", "bb_ht_ft"].every((key) => forA.markets.some((m) => m.key === key)));
});

test("bets from both teams count on their own Owner's Risk page", async () => {
  const q1 = await pick("509592", "bb_q1_winner", "home");
  const veronaPoints = await pick("509592", "bb_home_total_81_5", "under");
  const h1Total = await pick("509592", "bb_h1_total_84_5", "over");
  const ah = await pick("F1", "ah_m0_5", "home");
  const shelton = await pick("T1", "tn_handicap_m3_5", "away");
  await bets.place(actor(playerA), { bets: [{ selectionId: q1.id, stake: 10, odds: 2.6 }, { selectionId: veronaPoints.id, stake: 10, odds: await priceFor(playerA, veronaPoints) }] });
  await bets.place(actor(playerA), { accumulator: { stake: 5, legs: [{ selectionId: ah.id, odds: await priceFor(playerA, ah) }, { selectionId: shelton.id, odds: await priceFor(playerA, shelton) }] } });
  await bets.place(actor(playerB), { bets: [{ selectionId: q1.id, stake: 20, odds: await priceFor(playerB, q1) }, { selectionId: h1Total.id, stake: 10, odds: await priceFor(playerB, h1Total) }] });
  const placedA = await prisma.bet.findMany({ where: { playerId: playerA.id } });
  assert.equal(Number(placedA.find((b) => b.selectionId === q1.id).odds), 2.6, "placed at Owner A's own price");

  const exposureA = await risk.exposure(prisma, ownerA.id, [q1.id]);
  const exposureB = await risk.exposure(prisma, ownerB.id, [q1.id]);
  assert.equal(exposureA.get(q1.id).singles.payout, 26, "team A: 10 at 2.60");
  assert.equal(exposureB.get(q1.id).singles.payout, paid(20, 2.42), "team B: 20 at 2.42");
  const handicap = await pick("F1", "ah_m0_5", "home");
  assert.equal((await risk.exposure(prisma, ownerA.id, [handicap.id])).get(handicap.id).accumulators.bets, 1, "the accumulator counts on its handicap leg");
  assert.equal((await risk.exposure(prisma, ownerB.id, [handicap.id])).size, 0, "and not on team B");
});

test("results settle them, and every bet's journal row carries its team", async () => {
  // Verona 87-97 Milano; quarters 27-25, 17-36, 16-21, 27-15 (Verona took the 1st quarter, scored 87).
  const game = { ...parseGame(games.find((g) => g.id === 509592)), startsAt: new Date(Date.now() - 3 * HOUR), status: "finished", score: { home: 87, away: 97 }, periods: { quarters: [[27, 25], [17, 36], [16, 21], [27, 15]], overtime: null } };
  await basketball.saveGame(game, false);
  const saved = await prisma.event.findUniqueOrThrow({ where: { id: bbEvent } });
  assert.deepEqual([saved.resultHalfHome, saved.resultHalfAway], [44, 61], "the half-time score from the quarters");
  await settlement.settleDue();

  const a = await prisma.bet.findMany({ where: { playerId: playerA.id, kind: "SINGLE" } });
  const b = await prisma.bet.findMany({ where: { playerId: playerB.id } });
  const by = (list, text) => list.find((x) => x.description.includes(text));
  assert.deepEqual([by(a, "1st quarter winner").status, Number(by(a, "1st quarter winner").payout)], ["WON", 26]);
  assert.equal(by(a, "Verona points 81.5").status, "LOST", "87 points, over 81.5");
  assert.equal(by(b, "1st quarter winner").status, "WON");
  assert.equal(by(b, "1st half total points").status, "WON", "105 points");

  const journal = await prisma.settlementEntry.findMany({ where: { betId: { not: null } } });
  const settledBets = [...a, ...b].filter((x) => x.status !== "OPEN");
  assert.equal(journal.length, settledBets.length);
  for (const row of journal) {
    const team = row.playerId === playerA.id ? [ownerA.id, managerA.id, 10, 20] : [ownerB.id, managerB.id, 12, 25];
    assert.deepEqual([row.ownerId, row.managerId, Number(row.ownerRate), Number(row.managerRate)], team);
  }
  assert.equal((await prisma.bet.findFirstOrThrow({ where: { playerId: playerA.id, kind: "ACCUMULATOR" } })).status, "OPEN", "the football and tennis legs haven't played");
});

test("teardown", async () => {
  await prisma.$disconnect();
});
