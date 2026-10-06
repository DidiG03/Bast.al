// Tennis end to end against a real Postgres: matches and odds saved from the
// feed, listed under Tennis, a Player's bets at fixed prices (in an
// accumulator too), closing when a match goes on court, and the results
// settling them: a finished match, and a retirement voiding what was still
// undecided. Like the other integration tests it empties tables, so it only
// runs against a database whose name ends in "_test".
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
const { TennisSyncService } = require("../dist/odds/tennis-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { parseTennisMatch, parseTennisOdds } = require("../dist/odds/tennis.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
for (const name of ["API_FOOTBALL_KEY", "ODDS_FEED_MOCK", "GREYHOUND_API_KEY", "MMA_API_KEY", "TENNIS_API_KEY"]) delete process.env[name];

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const sync = new OddsSyncService(prisma);
const tennis = new TennisSyncService(prisma, sync);
const odds = new OddsService(prisma, audit, sync);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, new RiskService(prisma, audit), sync);

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).result;
const matches = await load("tennis-fixtures.json");
const oddsFeed = await load("tennis-odds.json");

const HOUR = 3_600_000;
const raw = (key) => matches.find((m) => m.event_key === key);
/** A fixture's match, due an hour from now and not started, under a key of our own. */
const upcoming = (key, as) => ({ ...parseTennisMatch(raw(key)), externalId: as, startsAt: new Date(Date.now() + HOUR), status: "upcoming", result: null });

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_tn${n}`, username: `tn${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `htn${n}`, role, parentId, ...extra } });
}
const balance = async (id) => Number((await prisma.user.findUniqueOrThrow({ where: { id } })).balance);
const pick = (matchId, market, key) => prisma.selection.findFirstOrThrow({ where: { key, market: { key: market, event: { externalId: matchId } } } });
const paid = (stake, odds) => Math.floor(stake * Number(odds) * 100 + 1e-6) / 100;

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

test("matches and odds are saved and listed under Tennis, not football", async () => {
  // Two matches priced like Sinner v Shelton: one to finish, one to end in a retirement.
  for (const [key, as] of [["12077002", "T1"], ["12077003", "T2"]]) {
    const match = upcoming(key, as);
    const id = await tennis.saveMatch(match);
    await sync.upsertMarkets(id, parseTennisOdds(oddsFeed["12077001"], match.home, match.away, "bet365"));
  }
  const list = await odds.events(ditaActor, "upcoming", undefined, "list", "tennis");
  assert.equal(list.length, 2);
  const swiatek = list.find((m) => m.homeTeam === "I. Swiatek");
  assert.deepEqual([swiatek.name, swiatek.league, swiatek.country, swiatek.markets[0].key], ["I. Swiatek v C. Gauff", "Wuhan", "WTA Singles · Wuhan - Quarter-finals", "tn_winner"]);
  assert.equal(swiatek.markets[0].selections[0].price, 1.36, "1.44 less the 5% margin");
  assert.deepEqual(await odds.events(ditaActor, "upcoming", undefined, "list"), [], "not on the football list");
});

test("bets at fixed prices, in an accumulator too; a match on court closes", async () => {
  const price = async (selection) => (await odds.selections(ditaActor, [selection.id]))[0].price;
  const swiatek = await pick("T1", "tn_winner", "home");
  const gauffSet1 = await pick("T1", "tn_set1", "away");
  const twoOne = await pick("T1", "tn_sets", "2_1");
  const fritz = await pick("T2", "tn_winner", "away");
  const zverevSet1 = await pick("T2", "tn_set1", "home");
  const slip = [swiatek, gauffSet1, twoOne, fritz, zverevSet1];
  const prices = await Promise.all(slip.map(price));
  await bets.place(ditaActor, { bets: slip.map((selection, i) => ({ selectionId: selection.id, stake: 5, odds: prices[i] })) });
  await bets.place(ditaActor, { accumulator: { stake: 4, legs: [{ selectionId: swiatek.id, odds: prices[0] }, { selectionId: fritz.id, odds: prices[3] }] } });
  assert.equal(await balance(dita.id), 71);

  await tennis.saveMatch({ ...upcoming("12077002", "T1"), status: "live", startsAt: new Date(Date.now() - 60_000) });
  await assert.rejects(bets.place(ditaActor, { bets: [{ selectionId: swiatek.id, stake: 5, odds: prices[0] }] }), /paused|closed/, "on court, with no live prices: no bets");
  return prices;
});

test("results settle the bets: a finished match, and a retirement voiding what was undecided", async () => {
  const done = (key, as) => ({ ...parseTennisMatch(raw(key)), externalId: as, startsAt: new Date(Date.now() - HOUR) });
  await tennis.saveMatch(done("12077002", "T1"), false);
  await tennis.saveMatch(done("12077003", "T2"), false);
  const t1 = await prisma.event.findFirstOrThrow({ where: { externalId: "T1" } });
  assert.deepEqual([t1.status, t1.homeScore, t1.awayScore], ["COMPLETED", 2, 1], "the score is the sets won");
  await settlement.settleDue();

  const mine = await prisma.bet.findMany({ where: { playerId: dita.id, kind: "SINGLE" } });
  const by = (match, text) => mine.find((b) => b.description.includes(match) && b.description.includes(text));
  const swiatek = by("Swiatek", "Match winner: I. Swiatek");
  assert.deepEqual([swiatek.status, Number(swiatek.payout)], ["WON", paid(5, swiatek.odds)]);
  const gauff = by("Swiatek", "1st set winner: C. Gauff");
  assert.deepEqual([gauff.status, Number(gauff.payout)], ["WON", paid(5, gauff.odds)], "Gauff took the 1st set 6-4");
  const sets = by("Swiatek", "Set betting: I. Swiatek 2-1");
  assert.deepEqual([sets.status, Number(sets.payout)], ["WON", paid(5, sets.odds)]);
  const fritz = by("Zverev", "Match winner: T. Fritz");
  assert.deepEqual([fritz.status, Number(fritz.payout)], ["VOID", 5], "Zverev retired: the match winner is void");
  const zverev = by("Zverev", "1st set winner: A. Zverev");
  assert.deepEqual([zverev.status, Number(zverev.payout)], ["WON", paid(5, zverev.odds)], "the 1st set was finished, so it stands");
  const acca = await prisma.bet.findFirstOrThrow({ where: { playerId: dita.id, kind: "ACCUMULATOR" } });
  const swiatekLeg = await prisma.betLeg.findFirstOrThrow({ where: { betId: acca.id, description: { contains: "Swiatek" } } });
  assert.deepEqual([acca.status, Number(acca.payout)], ["WON", paid(4, swiatekLeg.odds)], "the void pick drops out");
  const total = [swiatek, gauff, sets, fritz, zverev, acca].reduce((sum, b) => sum + Number(b.payout), 0);
  assert.equal(Math.round((await balance(dita.id)) * 100), Math.round((71 + total) * 100));
});

test("teardown", async () => {
  await prisma.$disconnect();
});
