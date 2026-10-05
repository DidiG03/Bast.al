// NFL end to end against a real Postgres: a game and its bet365 prices saved
// from API-Sports, listed under NFL only, a Player's bets, and the final score
// settling them: a tie voids the winner bet, then Super Admin's corrected
// score settles them again. Like the other integration tests it empties
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
const { NflSyncService } = require("../dist/odds/nfl-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { parseApiSportsOdds } = require("../dist/odds/basketball.js");
const { parseNflGame } = require("../dist/odds/nfl.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
for (const name of ["API_FOOTBALL_KEY", "ODDS_FEED_MOCK", "GREYHOUND_API_KEY", "MMA_API_KEY", "BASKETBALL_API_KEY", "ODDS_API_KEY", "NFL_API_KEY"]) delete process.env[name];

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const sync = new OddsSyncService(prisma);
const nfl = new NflSyncService(prisma, sync);
const odds = new OddsService(prisma, audit, sync);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, new RiskService(prisma, audit), sync);

const read = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const games = (await read("nfl-games.json")).response;
const feedOdds = (await read("nfl-odds.json")).response;

const HOUR = 3_600_000;
const panthers = (hours, extra = {}) => ({ ...parseNflGame(games.find((g) => g.game.id === 21575)), status: "upcoming", score: null, startsAt: new Date(Date.now() + hours * HOUR), ...extra });

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_nfl${n}`, username: `nfl${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hnfl${n}`, role, parentId, ...extra } });
}
const balance = async (id) => Number((await prisma.user.findUniqueOrThrow({ where: { id } })).balance);
const pick = (market, key) => prisma.selection.findFirstOrThrow({ where: { key, market: { key: market, event: { externalId: "21575" } } } });

let sa, dita, ditaActor, eventId;

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

test("a game and its prices are saved and listed under NFL only", async () => {
  const game = panthers(5);
  eventId = await nfl.saveGame(game);
  await sync.upsertMarkets(eventId, parseApiSportsOdds(feedOdds[0], game.home, game.away, 4));
  const list = await odds.events(ditaActor, "upcoming", undefined, "list", "nfl");
  assert.deepEqual(list.map((g) => [g.name, g.league, g.sport]), [["Carolina Panthers v Detroit Lions", "NFL", "nfl"]]);
  assert.equal((await odds.event(ditaActor, eventId)).markets.length, 11, "the winner, 5 spreads and 5 totals");
  assert.deepEqual(await odds.events(ditaActor, "upcoming", undefined, "list", "basketball"), [], "not on the basketball list");
  assert.deepEqual(await odds.events(ditaActor, "upcoming", undefined, "list"), [], "nor on the football list");
});

test("a tie voids the winner bet; Super Admin's corrected score settles the bets again", async () => {
  const winner = await pick("bb_winner", "home");
  const spread = await pick("bb_handicap_3_5", "away");
  const under = await pick("bb_total_51_5", "under");
  const quote = async (s) => (await odds.selections(ditaActor, [s.id]))[0].price;
  await bets.place(ditaActor, { bets: await Promise.all([winner, spread, under].map(async (s) => ({ selectionId: s.id, stake: 10, odds: await quote(s) }))) });
  assert.equal(await balance(dita.id), 70);

  // 20–20 after overtime: the winner bet is void, Lions −3.5 lose, 40 points is under 51.5.
  await nfl.saveGame(panthers(-4, { status: "finished", score: { home: 20, away: 20 } }), false);
  await settlement.settleDue();
  const status = async (s) => {
    const bet = await prisma.bet.findFirstOrThrow({ where: { playerId: dita.id, selectionId: s.id } });
    return [bet.status, Number(bet.payout)];
  };
  assert.deepEqual(await status(winner), ["VOID", 10]);
  assert.equal((await status(spread))[0], "LOST");
  assert.equal((await status(under))[0], "WON");

  // Corrected to 32–26 (the real score): Panthers win, Lions −3.5 still lose, 58 points is over.
  const done = await settlement.correctResult({ id: sa.id, role: "SUPER_ADMIN" }, eventId, 32, 26, { home: 16, away: 16 });
  assert.deepEqual(done.result, { home: 32, away: 26 });
  assert.equal((await status(winner))[0], "WON");
  assert.equal((await status(under))[0], "LOST");
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).resultHalfHome, null, "no half-time score for the NFL");
});

test("a game moved days later refunds the bets placed for the old date, like a football match", async () => {
  const game = { ...parseNflGame(games.find((g) => g.game.id === 21576)), status: "upcoming", score: null, startsAt: new Date(Date.now() + 2 * HOUR) };
  const id = await nfl.saveGame(game);
  await sync.upsertMarkets(id, parseApiSportsOdds(feedOdds[0], game.home, game.away, 4));
  const pickHome = await prisma.selection.findFirstOrThrow({ where: { key: "home", market: { key: "bb_winner", eventId: id } } });
  await bets.place(ditaActor, { bets: [{ selectionId: pickHome.id, stake: 5, odds: (await odds.selections(ditaActor, [pickHome.id]))[0].price }] });
  const before = await balance(dita.id);

  await nfl.saveGame({ ...game, startsAt: new Date(Date.now() + 74 * HOUR) });
  await settlement.settleDue();
  const bet = await prisma.bet.findFirstOrThrow({ where: { playerId: dita.id, selectionId: pickHome.id } });
  assert.deepEqual([bet.status, Number(bet.payout)], ["VOID", 5]);
  assert.equal(await balance(dita.id), before + 5);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
