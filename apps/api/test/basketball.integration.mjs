// Basketball end to end against a real Postgres: games saved from API-Sports
// with European prices, NBA prices from The Odds API matched to the right
// game, a Player's bets (in an accumulator too), and the final score settling
// winner, handicap and total points, then a corrected score settling them
// again. Like the other integration tests it empties tables, so it only runs
// against a database whose name ends in "_test".
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
const { OddsService } = require("../dist/odds/odds.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { parseApiSportsOdds, parseGame } = require("../dist/odds/basketball.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
for (const name of ["API_FOOTBALL_KEY", "ODDS_FEED_MOCK", "GREYHOUND_API_KEY", "MMA_API_KEY", "BASKETBALL_API_KEY", "ODDS_API_KEY"]) delete process.env[name];

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const sync = new OddsSyncService(prisma);
const basketball = new BasketballSyncService(prisma, sync);
const odds = new OddsService(prisma, audit, sync);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, new RiskService(prisma, audit), sync);

const read = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const games = (await read("basketball-games.json")).response;
const euroOdds = (await read("basketball-odds.json")).response;
const nbaOdds = await read("odds-api-nba.json");

const HOUR = 3_600_000;
const inFuture = (id, hours) => ({ ...parseGame(games.find((g) => g.id === id)), startsAt: new Date(Date.now() + hours * HOUR) });

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_bb${n}`, username: `bb${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hbb${n}`, role, parentId, ...extra } });
}
const balance = async (id) => Number((await prisma.user.findUniqueOrThrow({ where: { id } })).balance);
const pick = (gameId, market, key) => prisma.selection.findFirstOrThrow({ where: { key, market: { key: market, event: { externalId: String(gameId) } } } });
const quote = async (selection) => (await odds.selections(ditaActor, [selection.id]))[0].price;

let sa, dita, ditaActor;

test("setup", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "platform_settings", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.create({ data: { id: "default", baseOddsMargin: 5 } });
  sa = await user("SUPER_ADMIN", null);
  const owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  const manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 1000 });
  dita = await user("PLAYER", manager.id, { balance: 100 });
  ditaActor = { id: dita.id, role: "PLAYER", parentId: manager.id };
});

test("games and prices: European ones from API-Sports, the NBA's from The Odds API matched to the right game", async () => {
  for (const [id, hours] of [[509592, 5], [514828, 3]]) {
    const game = inFuture(id, hours);
    const eventId = await basketball.saveGame(game);
    await sync.upsertMarkets(eventId, parseApiSportsOdds(euroOdds.find((o) => o.game.id === id), game.home, game.away, 4));
  }
  const hawks = inFuture(506713, 10);
  await basketball.saveGame(hawks);
  await basketball.saveGame({ ...inFuture(506713, 30), externalId: "other-hawks-game" }, true);
  assert.equal(await basketball.syncNbaOdds([{ ...nbaOdds[0], commence_time: hawks.startsAt.toISOString() }]), 1, "only the game at that tip-off");

  const list = await odds.events(ditaActor, "upcoming", undefined, "list", "basketball");
  assert.deepEqual(list.map((g) => g.name), ["Bora v Rahoveci", "Verona v Olimpia Milano", "Atlanta Hawks v Memphis Grizzlies", "Atlanta Hawks v Memphis Grizzlies"]);
  const atl = await odds.event(ditaActor, list[2].id);
  assert.deepEqual(atl.markets.map((m) => m.key), ["bb_winner", "bb_handicap_m2_5", "bb_total_224_0"]);
  assert.equal(atl.markets[0].selections[0].price, 1.68, "DraftKings 1.77 less 5%");
  assert.equal((await odds.event(ditaActor, list[3].id)).markets.length, 0, "the other Hawks game got no prices");
  assert.deepEqual(await odds.events(ditaActor, "upcoming", undefined, "list"), [], "not on the football list");
});

test("bets settle on the final score with overtime; a corrected score settles them again", async () => {
  const milano = await pick(509592, "bb_winner", "away");
  const veronaPlus = await pick(509592, "bb_handicap_8_5", "home");
  const under = await pick(509592, "bb_total_170_5", "under");
  const hawks = await pick(506713, "bb_winner", "home");
  await bets.place(ditaActor, { bets: [{ selectionId: veronaPlus.id, stake: 10, odds: await quote(veronaPlus) }, { selectionId: under.id, stake: 10, odds: await quote(under) }] });
  await bets.place(ditaActor, { accumulator: { stake: 5, legs: [{ selectionId: milano.id, odds: await quote(milano) }, { selectionId: hawks.id, odds: await quote(hawks) }] } });
  assert.equal(await balance(dita.id), 75);

  // Milano win 87–80 after overtime.
  await basketball.saveGame({ ...inFuture(509592, -3), status: "finished", score: { home: 80, away: 87 } }, false);
  await settlement.settleDue();
  const mine = await prisma.bet.findMany({ where: { playerId: dita.id }, orderBy: { placedAt: "asc" } });
  const plus = mine.find((b) => b.selectionId === veronaPlus.id);
  const totalBet = mine.find((b) => b.selectionId === under.id);
  assert.deepEqual([plus.status, Number(plus.payout)], ["WON", Math.floor(10 * Number(plus.odds) * 100 + 1e-6) / 100], "Verona +8.5: 88.5 v 87");
  assert.deepEqual([totalBet.status, Number(totalBet.payout)], ["WON", Math.floor(10 * Number(totalBet.odds) * 100 + 1e-6) / 100], "167 points, under 170.5");
  assert.equal(mine.find((b) => b.kind === "ACCUMULATOR").status, "OPEN", "the Hawks haven't played");

  // Super Admin corrects it to 80–90: Verona +8.5 now loses, the total (170) is still under.
  await settlement.correctResult({ id: sa.id, role: "SUPER_ADMIN" }, (await prisma.event.findFirstOrThrow({ where: { externalId: "509592" } })).id, 80, 90);
  const again = await prisma.bet.findUniqueOrThrow({ where: { id: plus.id } });
  assert.equal(again.status, "LOST", "80 + 8.5 = 88.5, short of 90");
  assert.equal((await prisma.bet.findUniqueOrThrow({ where: { id: totalBet.id } })).status, "WON", "170 points, still under 170.5");
});

test("Super Admin can set a basketball score over 99, without football's half-time or stats", async () => {
  const game = await prisma.event.findFirstOrThrow({ where: { externalId: "509592" } });
  const done = await settlement.correctResult({ id: sa.id, role: "SUPER_ADMIN" }, game.id, 102, 110, { home: 50, away: 49 }, { cornersHome: 1, cornersAway: 2, cardsHome: 0, cardsAway: 0 });
  assert.deepEqual(done.result, { home: 102, away: 110 });
  const saved = await prisma.event.findUniqueOrThrow({ where: { id: game.id } });
  assert.deepEqual([saved.resultHalfHome, saved.resultCornersHome], [null, null]);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
