// The bet builder through the whole hierarchy, against a real Postgres: two
// teams on different margins and an Owner's own price feeding each team's
// builder price, picks the builder refuses, a builder placed (and refused at
// a stale price), counted on its picks in the Owner's Risk page, settled from
// the score with its journal row carrying the team, and a void pick refunding
// one. Like the other integration tests it empties tables, so it only runs
// against a database whose name ends in "_test".
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
const { priceBuilder } = require("../dist/bets/builder.js");

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
  return prisma.user.create({ data: { clerkId: `clerk_bb${n}`, username: `bb${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hbb${n}`, role, parentId, ...extra } });
}
const actor = (u) => ({ id: u.id, role: u.role, parentId: u.parentId });
const pick = (externalId, market, key) => prisma.selection.findFirstOrThrow({ where: { key, market: { key: market, event: { externalId } } } });
const priceFor = async (who, selection) => (await odds.selections(actor(who), [selection.id]))[0].price;
const paid = (stake, price) => Math.floor(stake * Number(price) * 100 + 1e-6) / 100;
const anchor = { home: 1.8, draw: 3.8, away: 4.3, over: 1.7, under: 2.15 };

let sa, ownerA, playerA, ownerB, playerB, otherPlayerA;

async function footballMatch(externalId, name, hoursAhead) {
  const [home, away] = name.split(" v ");
  const event = await prisma.event.create({ data: { sport: "football", provider: "api-football", externalId, name, league: "Premier League", homeTeam: home, awayTeam: away, startsAt: new Date(Date.now() + hoursAhead * HOUR) } });
  const bet = (betName, values) => ({ id: 0, name: betName, values: Object.entries(values).map(([value, odd]) => ({ value, odd: String(odd) })) });
  await sync.upsertMarkets(
    event.id,
    parseMarkets(
      {
        fixture: { id: 1 },
        bookmakers: [
          {
            id: 8,
            name: "Bet365",
            bets: [
              bet("Match Winner", { Home: anchor.home, Draw: anchor.draw, Away: anchor.away }),
              bet("Goals Over/Under", { "Over 2.5": anchor.over, "Under 2.5": anchor.under, "Over 1.5": 1.25, "Under 1.5": 3.9 }),
              bet("Both Teams Score", { Yes: 1.75, No: 2.05 }),
              bet("Home/Away", { Home: 1.3, Away: 3.4 }),
              bet("First Half Winner", { Home: 2.4, Draw: 2.3, Away: 5 }),
            ],
          },
        ],
      },
      home,
      away,
      8,
    ),
  );
  return event;
}

test("setup: two teams, A on a higher margin with its own price on both teams to score", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "platform_settings", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.create({ data: { id: "default", baseOddsMargin: 5 } });
  sa = await user("SUPER_ADMIN", null);
  ownerA = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  const managerA = await user("MANAGER", ownerA.id, { commissionRate: 20, balance: 1000 });
  playerA = await user("PLAYER", managerA.id, { balance: 200 });
  otherPlayerA = await user("PLAYER", managerA.id, { balance: 200 });
  ownerB = await user("OWNER", sa.id, { commissionRate: 12, balance: 10000 });
  playerB = await user("PLAYER", ownerB.id, { balance: 200 });
  await odds.setTeamMargin(actor(ownerA), 3);
  await footballMatch("CITY", "Man City v Arsenal", 4);
  await footballMatch("SPURS", "Spurs v Chelsea", 5);
  await odds.setOverride(actor(ownerA), (await pick("CITY", "btts", "yes")).id, 1.8);
});

test("each team's builder price comes from its own prices: margins and the Owner's own price", async () => {
  const legs = [await pick("CITY", "match_winner", "home"), await pick("CITY", "goals_2_5", "over"), await pick("CITY", "btts", "yes")];
  const ids = legs.map((s) => s.id);
  const quoteA = await bets.quoteBuilder(actor(playerA), ids);
  const quoteB = await bets.quoteBuilder(actor(playerB), ids);
  assert.deepEqual(quoteA.legs.map((l) => l.odds), [await priceFor(playerA, legs[0]), await priceFor(playerA, legs[1]), 1.8], "team A: margin 8%, and its own 1.80 on both teams to score");
  assert.equal(quoteB.legs[2].odds, await priceFor(playerB, legs[2]));
  const expected = (quote) => priceBuilder(quote.legs.map((l, i) => ({ marketKey: ["match_winner", "goals_2_5", "btts"][i], selectionKey: legs[i].key, price: l.odds })), anchor).odds;
  assert.equal(quoteA.odds, expected(quoteA));
  assert.equal(quoteB.odds, expected(quoteB));
  assert.notEqual(quoteA.odds, quoteB.odds);
  const multiplied = quoteA.legs.reduce((t, l) => t * l.odds, 1);
  assert.ok(quoteA.odds < multiplied, "linked picks pay less than multiplied");
});

test("the builder refuses picks it can't take", async () => {
  const city = await pick("CITY", "match_winner", "home");
  const q = (who, ...selections) => bets.quoteBuilder(actor(who), selections.map((s) => s.id));
  await assert.rejects(q(playerA, city, await pick("CITY", "match_winner", "draw")), /one pick from each market/);
  await assert.rejects(q(playerA, city, await pick("SPURS", "btts", "yes")), /same match/);
  await assert.rejects(q(playerA, city, await pick("CITY", "draw_no_bet", "home")), /can't go in a bet builder/);
  await assert.rejects(q(playerA, city, await pick("CITY", "goals_1_5", "under"), await pick("CITY", "btts", "yes")), /can't all happen together/);
  await assert.rejects(q(playerA, city, city), /twice/);
  await assert.rejects(bets.quoteBuilder({ id: ownerA.id, role: "OWNER" }, [city.id, (await pick("CITY", "btts", "yes")).id]), /Only Players/);
});

test("a builder is placed at its quoted price, refused at a stale one, and counts on every pick's open payout", async () => {
  const legs = [await pick("CITY", "match_winner", "home"), await pick("CITY", "goals_2_5", "over"), await pick("CITY", "btts", "yes")];
  const quote = await bets.quoteBuilder(actor(playerA), legs.map((s) => s.id));
  const builder = (price) => ({ builder: { stake: 10, odds: price, legs: quote.legs.map((l) => ({ selectionId: l.selectionId, odds: l.odds })) } });
  await assert.rejects(bets.place(actor(playerA), builder(quote.odds + 0.5)), /odds changed: the bet builder is now/);
  const placed = await bets.place(actor(playerA), builder(quote.odds));
  assert.equal(placed.bets[0].kind, "BUILDER");
  assert.equal(placed.bets[0].odds, quote.odds);
  assert.equal(placed.bets[0].legs.length, 3);
  assert.equal(placed.bets[0].description, "Bet builder · Man City v Arsenal · 3 picks");
  assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: playerA.id } })).balance), 190);
  const ledger = await prisma.balanceTransaction.findFirstOrThrow({ where: { toUserId: playerA.id, type: "BET_STAKE" } });
  assert.equal(Number(ledger.amount), -10);

  const exposure = await risk.exposure(prisma, ownerA.id, legs.map((s) => s.id));
  for (const s of legs) assert.deepEqual(exposure.get(s.id).accumulators, { bets: 1, staked: 10, payout: paid(10, quote.odds) });
  assert.equal((await risk.exposure(prisma, ownerB.id, [legs[0].id])).size, 0, "not on team B");

  // A builder and a single together on one slip.
  const spurs = await pick("SPURS", "match_winner", "home");
  const quoteB = await bets.quoteBuilder(actor(playerB), [legs[0].id, legs[2].id]);
  const both = await bets.place(actor(playerB), {
    bets: [{ selectionId: spurs.id, stake: 5, odds: await priceFor(playerB, spurs) }],
    builder: { stake: 10, odds: quoteB.odds, legs: quoteB.legs.map((l) => ({ selectionId: l.selectionId, odds: l.odds })) },
  });
  assert.deepEqual(both.bets.map((b) => b.kind), ["SINGLE", "BUILDER"]);
  assert.equal(both.total, 15);
});

test("the score settles a builder, and its journal row carries the team", async () => {
  const city = await prisma.event.findFirstOrThrow({ where: { externalId: "CITY" } });
  await prisma.event.update({ where: { id: city.id }, data: { startsAt: new Date(Date.now() - 3 * HOUR) } });
  // 2-1, 1-0 at half time: City won, 3 goals, both scored.
  await settlement.correctResult({ id: sa.id, role: "SUPER_ADMIN" }, city.id, 2, 1, { home: 1, away: 0 });
  const builderA = await prisma.bet.findFirstOrThrow({ where: { playerId: playerA.id, kind: "BUILDER" } });
  assert.deepEqual([builderA.status, Number(builderA.payout)], ["WON", paid(10, builderA.odds)]);
  const legs = await prisma.betLeg.findMany({ where: { betId: builderA.id } });
  assert.ok(legs.every((leg) => leg.result === "WON"));
  const journal = await prisma.settlementEntry.findFirstOrThrow({ where: { betId: builderA.id } });
  assert.deepEqual([journal.ownerId, Number(journal.stake), Number(journal.payout)], [ownerA.id, 10, paid(10, builderA.odds)]);
  assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: playerA.id } })).balance), 190 + paid(10, builderA.odds));

  // Corrected to 2-0: Arsenal didn't score, so it lost after all.
  await settlement.correctResult({ id: sa.id, role: "SUPER_ADMIN" }, city.id, 2, 0, { home: 1, away: 0 });
  const corrected = await prisma.bet.findUniqueOrThrow({ where: { id: builderA.id } });
  assert.deepEqual([corrected.status, Number(corrected.payout)], ["LOST", 0]);
  assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: playerA.id } })).balance), 190);
});

test("a void pick refunds the builder", async () => {
  const spurs = await prisma.event.findFirstOrThrow({ where: { externalId: "SPURS" } });
  const legs = [await pick("SPURS", "match_winner", "away"), await pick("SPURS", "btts", "yes")];
  const quote = await bets.quoteBuilder(actor(otherPlayerA), legs.map((s) => s.id));
  await bets.place(actor(otherPlayerA), { builder: { stake: 20, odds: quote.odds, legs: quote.legs.map((l) => ({ selectionId: l.selectionId, odds: l.odds })) } });
  await prisma.event.update({ where: { id: spurs.id }, data: { startsAt: new Date(Date.now() - 3 * HOUR) } });
  await settlement.correctResult({ id: sa.id, role: "SUPER_ADMIN" }, spurs.id, 1, 2, { home: 0, away: 1 });
  const won = await prisma.bet.findFirstOrThrow({ where: { playerId: otherPlayerA.id, kind: "BUILDER" } });
  assert.equal(won.status, "WON");
  await settlement.settleSelection({ id: sa.id, role: "SUPER_ADMIN" }, legs[1].id, "VOID");
  const refunded = await prisma.bet.findUniqueOrThrow({ where: { id: won.id } });
  assert.deepEqual([refunded.status, Number(refunded.payout)], ["VOID", 20]);
  assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: otherPlayerA.id } })).balance), 200);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
