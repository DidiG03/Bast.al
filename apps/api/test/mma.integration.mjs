// MMA end to end against a real Postgres: a card's fights and odds saved
// from the feed (UFC 332), every fight closing when the card's first one
// starts, a Player's bets at fixed prices (in an accumulator too), and the
// results settling them, a draw voiding the winner bet. Like the other
// integration tests it empties tables, so it only runs against a database
// whose name ends in "_test".
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
const { MmaSyncService } = require("../dist/odds/mma-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { parseFight, parseFightOdds } = require("../dist/odds/mma.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
for (const name of ["API_FOOTBALL_KEY", "ODDS_FEED_MOCK", "GREYHOUND_API_KEY", "MMA_API_KEY"]) delete process.env[name];

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const sync = new OddsSyncService(prisma);
const mma = new MmaSyncService(prisma, sync);
const odds = new OddsService(prisma, audit, sync);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, new RiskService(prisma, audit), sync);

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).response;
const fights = await load("mma-fights.json");
const results = await load("mma-results.json");
const oddsFeed = await load("mma-odds.json");

const HOUR = 3_600_000;
/** UFC 332 moved to start an hour from now, its fights as far apart as on the night. */
const firstAt = Date.parse(fights[0].date);
const moved = (raw, extra = {}) => ({ ...parseFight(raw), startsAt: new Date(Date.parse(raw.date) - firstAt + Date.now() + HOUR), ...extra });
const upcoming = (raw) => moved(raw, { status: "upcoming", winner: null });

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_mma${n}`, username: `mma${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hmma${n}`, role, parentId, ...extra } });
}
const balance = async (id) => Number((await prisma.user.findUniqueOrThrow({ where: { id } })).balance);
const pick = (fightId, market, key) => prisma.selection.findFirstOrThrow({ where: { key, market: { key: market, event: { externalId: String(fightId) } } } });

let dita, ditaActor;

test("setup", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "platform_settings", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.create({ data: { id: "default", baseOddsMargin: 5 } });
  const sa = await user("SUPER_ADMIN", null);
  const owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  const manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 1000 });
  dita = await user("PLAYER", manager.id, { balance: 100 });
  ditaActor = { id: dita.id, role: "PLAYER", parentId: manager.id };
});

test("a card's fights and odds are saved, listed under MMA, and all close when its first fight starts", async () => {
  for (const raw of fights) {
    const id = await mma.saveFight(upcoming(raw), undefined);
    const feed = oddsFeed.find((o) => o.fight.id === raw.id);
    await sync.upsertMarkets(id, parseFightOdds(feed, raw.fighters.first.name, raw.fighters.second.name, 5));
  }
  const list = await odds.events(ditaActor, "upcoming", undefined, "list", "mma");
  assert.equal(list.length, 4);
  const silva = list.find((f) => f.awayTeam === "Natalia Silva");
  assert.deepEqual([silva.name, silva.league, silva.country, silva.markets[0].key], ["Wang Cong v Natalia Silva", "UFC 332: Silva vs. Wang", "Women's Flyweight", "fight_winner"]);
  assert.equal(silva.markets[0].selections[1].price, 1.4, "1.48 less the 5% margin");
  assert.deepEqual(await odds.events(ditaActor, "upcoming", undefined, "list"), [], "not on the football list");

  const events = await prisma.event.findMany({ where: { sport: "mma" } });
  const first = Math.min(...events.map((e) => e.startsAt.getTime()));
  assert.ok(events.every((e) => e.closesAt.getTime() === first), "every fight closes at the card's start");
});

test("bets at fixed prices, in an accumulator too; a started card closes every fight", async () => {
  const silva = await pick(2909, "fight_winner", "away");
  const talbott = await pick(2910, "fight_winner", "home");
  const under = await pick(2907, "rounds_1_5", "under");
  const draw = await pick(2909, "fight_result", "draw");
  const price = async (selection) => (await odds.selections(ditaActor, [selection.id]))[0].price;
  await bets.place(ditaActor, { bets: [{ selectionId: silva.id, stake: 10, odds: 1.4 }, { selectionId: under.id, stake: 5, odds: await price(under) }, { selectionId: draw.id, stake: 2, odds: await price(draw) }] });
  await bets.place(ditaActor, { accumulator: { stake: 4, legs: [{ selectionId: silva.id, odds: 1.4 }, { selectionId: talbott.id, odds: await price(talbott) }] } });
  assert.equal(await balance(dita.id), 79);

  // The first fight goes on: the rest of the card closes at once.
  await mma.saveFight(moved(fights[0], { status: "live", winner: null, startsAt: new Date(Date.now() - 60_000) }), undefined);
  await assert.rejects(bets.place(ditaActor, { bets: [{ selectionId: silva.id, stake: 5, odds: 1.4 }] }), /Bets are closed/);
});

test("results settle the card: KO under the rounds line, a decision, and a draw voiding the winner bet", async () => {
  const done = (raw, extra = {}) => moved(raw, { startsAt: new Date(Date.now() - HOUR), ...extra });
  // Silva v Wang is called a draw here, to show both rules.
  await mma.saveFight(done(fights.find((f) => f.id === 2909), { winner: null }), { ...results.find((r) => r.fight.id === 2909) }, false);
  for (const id of [2907, 2910]) await mma.saveFight(done(fights.find((f) => f.id === id)), results.find((r) => r.fight.id === id), false);
  await settlement.settleDue();

  const mine = await prisma.bet.findMany({ where: { playerId: dita.id }, orderBy: { placedAt: "asc" } });
  const by = (text) => mine.find((b) => b.description.includes(text));
  assert.deepEqual([by("Fight winner: Natalia Silva").status, Number(by("Fight winner: Natalia Silva").payout)], ["VOID", 10], "a draw: the stake back");
  const drawBet = by("Fight result: Draw");
  assert.deepEqual([drawBet.status, Number(drawBet.payout)], ["WON", Math.floor(2 * Number(drawBet.odds) * 100 + 1e-6) / 100]);
  const underBet = by("Under 1.5 rounds");
  assert.deepEqual([underBet.status, Number(underBet.payout)], ["WON", Math.floor(5 * Number(underBet.odds) * 100 + 1e-6) / 100], "KO at 3:12 of round 1");
  const acca = mine.find((b) => b.kind === "ACCUMULATOR");
  const talbott = await prisma.betLeg.findFirstOrThrow({ where: { betId: acca.id, description: { contains: "Payton Talbott" } } });
  assert.deepEqual([acca.status, Number(acca.payout)], ["WON", Math.floor(4 * Number(talbott.odds) * 100 + 1e-6) / 100], "the void pick drops out: 4 at Talbott's price");
  const paid = [10, drawBet, underBet, acca].reduce((sum, b) => sum + (typeof b === "number" ? b : Number(b.payout)), 0);
  assert.equal(Math.round((await balance(dita.id)) * 100), Math.round((79 + paid) * 100));
});

test("teardown", async () => {
  await prisma.$disconnect();
});
