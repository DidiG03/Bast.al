// Volleyball and handball through the whole hierarchy, against a real
// Postgres, from samples of the real feeds: games and prices saved by the
// sync services, two teams on different margins and an Owner's own price
// that only their team sees, singles and an accumulator mixing the two
// sports with football, the Owner's Risk page, results from the feed
// settling everything (each bet's journal row carrying its team), a result
// the feed corrects later, and Super Admin entering a result by hand. Like
// the other integration tests it empties tables, so it only runs against a
// database whose name ends in "_test".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { VolleyballSyncService, HandballSyncService } = require("../dist/odds/team-sports-sync.service.js");
const { parseVolleyballGame, parseVolleyballOdds } = require("../dist/odds/volleyball.js");
const { parseHandballGame, parseHandballOdds } = require("../dist/odds/handball.js");
const { parseMarkets } = require("../dist/odds/api-football.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
for (const name of ["API_FOOTBALL_KEY", "ODDS_FEED_MOCK", "GREYHOUND_API_KEY", "MMA_API_KEY", "TENNIS_API_KEY", "ODDS_API_KEY", "VOLLEYBALL_API_KEY", "HANDBALL_API_KEY"]) delete process.env[name];

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
const volleyball = new VolleyballSyncService(prisma, sync);
const handball = new HandballSyncService(prisma, sync);

const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).response;
const vbGames = read("volleyball-games.json");
const vbOdds = read("volleyball-odds.json");
const hbGames = read("handball-games.json");
const hbOdds = read("handball-odds.json");

const HOUR = 3_600_000;
let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_ts${n}`, username: `ts${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hts${n}`, role, parentId, ...extra } });
}
const actor = (u) => ({ id: u.id, role: u.role, parentId: u.parentId });
const SA = () => ({ id: sa.id, role: "SUPER_ADMIN" });
const pick = (externalId, market, key) => prisma.selection.findFirstOrThrow({ where: { key, market: { key: market, event: { externalId } } } });
const priceFor = async (who, selection) => (await odds.selections(actor(who), [selection.id]))[0].price;
const paid = (stake, price) => Math.floor(stake * Number(price) * 100 + 1e-6) / 100;
const reload = (id) => prisma.bet.findUniqueOrThrow({ where: { id } });
const balance = async (u) => Number((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).balance);

let sa, ownerA, playerA, ownerB, playerB;
// Altekma v Gaziantep Genclik (volleyball) and CSM Bucuresti v Minaur Baia Mare (handball), moved a few hours ahead.
const VB = 213932;
const HB = 203079;
const ahead = (raw) => ({ ...raw, date: new Date(Date.now() + 4 * HOUR).toISOString() });

test("setup: two teams, A on a higher margin; a volleyball, a handball and a football game with prices", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "platform_settings", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.create({ data: { id: "default", baseOddsMargin: 5 } });
  sa = await user("SUPER_ADMIN", null);
  ownerA = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  const managerA = await user("MANAGER", ownerA.id, { commissionRate: 20, balance: 1000 });
  playerA = await user("PLAYER", managerA.id, { balance: 300 });
  ownerB = await user("OWNER", sa.id, { commissionRate: 12, balance: 10000 });
  playerB = await user("PLAYER", ownerB.id, { balance: 300 });
  await odds.setTeamMargin(actor(ownerA), 3);

  const vb = parseVolleyballGame(ahead(vbGames.find((g) => g.id === VB)));
  const vbId = await volleyball.saveGame(vb);
  await sync.upsertMarkets(vbId, parseVolleyballOdds(vbOdds.find((o) => o.game.id === VB), vb.home, vb.away, 4));
  const hb = parseHandballGame(ahead(hbGames.find((g) => g.id === HB)));
  const hbId = await handball.saveGame(hb);
  await sync.upsertMarkets(hbId, parseHandballOdds(hbOdds.find((o) => o.game.id === HB), hb.home, hb.away, 4));
  const football = await prisma.event.create({ data: { sport: "football", provider: "api-football", externalId: "F1", name: "Tirana v Partizani", league: "Abissnet Superiore", homeTeam: "Tirana", awayTeam: "Partizani", startsAt: new Date(Date.now() + 4 * HOUR) } });
  await sync.upsertMarkets(football.id, parseMarkets({ fixture: { id: 1 }, bookmakers: [{ id: 8, name: "Bet365", bets: [{ id: 1, name: "Match Winner", values: [{ value: "Home", odd: "2" }, { value: "Draw", odd: "3.4" }, { value: "Away", odd: "3.6" }] }] }] }, "Tirana", "Partizani", 8));

  const saved = await prisma.event.findMany({ where: { sport: { in: ["volleyball", "handball"] } }, include: { _count: { select: { markets: true } } } });
  assert.deepEqual(saved.map((e) => [e.sport, e.provider, e.status, e.league]).sort(), [["handball", "api-sports-handball", "UPCOMING", "Liga Nationala"], ["volleyball", "api-sports-volleyball", "UPCOMING", "Turkish Cup"]]);
  assert.ok(saved.every((e) => e._count.markets > 20));
});

test("each sport's list, and every price per team: margins and an Owner's own price", async () => {
  const vbList = await odds.events(actor(playerA), "upcoming", undefined, undefined, "volleyball");
  const hbList = await odds.events(actor(playerA), "upcoming", undefined, undefined, "handball");
  assert.deepEqual([vbList.map((e) => e.name), hbList.map((e) => e.name)], [["Altekma v Gaziantep Genclik"], ["CSM Bucuresti v Minaur Baia Mare"]]);

  const altekma = await pick(String(VB), "vb_winner", "home"); // feed 1.44
  assert.equal(await priceFor(playerB, altekma), 1.36, "team B: 5% off 1.44");
  assert.equal(await priceFor(playerA, altekma), 1.32, "team A: 8% off 1.44");
  const csm = await pick(String(HB), "match_winner", "home"); // feed 1.95
  assert.equal(await priceFor(playerB, csm), 1.85);
  assert.equal(await priceFor(playerA, csm), 1.79);
  // Owner A prices the handball draw no bet themselves: only their team gets it.
  const dnb = await pick(String(HB), "draw_no_bet", "home"); // feed 1.75
  await odds.setOverride(actor(ownerA), dnb.id, 1.8);
  assert.equal(await priceFor(playerA, dnb), 1.8);
  assert.equal(await priceFor(playerB, dnb), 1.66, "team B keeps the feed price less its margin");
});

let single, acca, handballSingle, bSingle;

test("singles and an accumulator mixing volleyball, handball and football, counted on each Owner's Risk page", async () => {
  const altekma = await pick(String(VB), "vb_winner", "home");
  const setsLine = await pick(String(VB), "vb_sets_total_3_5", "over");
  const dnb = await pick(String(HB), "draw_no_bet", "home");
  const tirana = await pick("F1", "match_winner", "home");
  const placed = await bets.place(actor(playerA), {
    bets: [
      { selectionId: altekma.id, stake: 20, odds: await priceFor(playerA, altekma) },
      { selectionId: dnb.id, stake: 10, odds: 1.8 },
    ],
    accumulator: { stake: 5, legs: [{ selectionId: setsLine.id, odds: await priceFor(playerA, setsLine) }, { selectionId: dnb.id, odds: 1.8 }, { selectionId: tirana.id, odds: await priceFor(playerA, tirana) }] },
  });
  [single, handballSingle, acca] = placed.bets;
  assert.deepEqual(placed.bets.map((b) => b.kind), ["SINGLE", "SINGLE", "ACCUMULATOR"]);
  assert.equal(handballSingle.odds, 1.8, "at Owner A's own price");
  assert.equal(await balance(playerA), 265);
  const htft = await pick(String(HB), "ht_ft", "home_home");
  bSingle = (await bets.place(actor(playerB), { bets: [{ selectionId: htft.id, stake: 10, odds: await priceFor(playerB, htft) }] })).bets[0];

  const exposureA = await risk.exposure(prisma, ownerA.id, [altekma.id, dnb.id]);
  assert.equal(exposureA.get(altekma.id).singles.payout, paid(20, single.odds));
  assert.deepEqual([exposureA.get(dnb.id).singles.payout, exposureA.get(dnb.id).accumulators.bets], [18, 1]);
  assert.equal((await risk.exposure(prisma, ownerB.id, [altekma.id])).size, 0, "not on team B");
  assert.equal((await risk.exposure(prisma, ownerB.id, [htft.id])).get(htft.id).singles.bets, 1);
  // A volleyball pick can't go in a bet builder: that's football only.
  await assert.rejects(bets.quoteBuilder(actor(playerA), [altekma.id, setsLine.id]), /football/);
});

test("bets close when the game starts: there are no live prices", async () => {
  const live = parseVolleyballGame({ ...vbGames.find((g) => g.id === VB), date: new Date(Date.now() - HOUR).toISOString(), status: { short: "S1" }, scores: { home: 0, away: 0 } });
  await volleyball.saveGame(live);
  const altekma = await pick(String(VB), "vb_winner", "home");
  await assert.rejects(bets.place(actor(playerA), { bets: [{ selectionId: altekma.id, stake: 5, odds: await priceFor(playerA, altekma) }] }), /paused|closed/);
});

test("results from the feed settle every bet, and each journal row carries its team", async () => {
  // Altekma win 3–1 (4 sets, over 3.5); CSM Bucuresti win 30–28 (15–14 at half time); Tirana win 2–0.
  const vbRaw = vbGames.find((g) => g.id === VB);
  const vbDone = parseVolleyballGame({
    ...vbRaw,
    date: new Date(Date.now() - 3 * HOUR).toISOString(),
    status: { short: "FT" },
    scores: { home: 3, away: 1 },
    periods: { first: { home: 25, away: 20 }, second: { home: 22, away: 25 }, third: { home: 25, away: 23 }, fourth: { home: 25, away: 18 }, fifth: { home: null, away: null } },
  });
  await volleyball.saveGame(vbDone, false);
  const hbRaw = hbGames.find((g) => g.id === HB);
  await handball.saveGame(parseHandballGame({ ...hbRaw, date: new Date(Date.now() - 3 * HOUR).toISOString(), status: { short: "FT" }, scores: { home: 30, away: 28 }, periods: { first: { home: 15, away: 14 }, second: { home: 15, away: 14 } } }), false);
  const football = await prisma.event.findFirstOrThrow({ where: { externalId: "F1" } });
  await prisma.event.update({ where: { id: football.id }, data: { startsAt: new Date(Date.now() - 3 * HOUR) } });
  await settlement.correctResult(SA(), football.id, 2, 0);
  await settlement.settleDue();

  const vbEvent = await prisma.event.findFirstOrThrow({ where: { externalId: String(VB) } });
  assert.deepEqual([vbEvent.status, vbEvent.resultHome, vbEvent.resultAway, vbEvent.fightResult.sets.length], ["COMPLETED", 3, 1, 4]);
  const hbEvent = await prisma.event.findFirstOrThrow({ where: { externalId: String(HB) } });
  assert.deepEqual([hbEvent.resultHome, hbEvent.resultAway, hbEvent.resultHalfHome, hbEvent.resultHalfAway], [30, 28, 15, 14]);

  assert.deepEqual([(await reload(single.id)).status, Number((await reload(single.id)).payout)], ["WON", paid(20, single.odds)]);
  assert.deepEqual([(await reload(handballSingle.id)).status, Number((await reload(handballSingle.id)).payout)], ["WON", 18]);
  const accumulator = await reload(acca.id);
  assert.deepEqual([accumulator.status, Number(accumulator.payout)], ["WON", paid(5, acca.odds)]);
  assert.equal((await reload(bSingle.id)).status, "WON", "home at half time and at full time");

  const journal = await prisma.settlementEntry.findMany({ where: { betId: { not: null } } });
  assert.equal(journal.length, 4);
  for (const row of journal) assert.equal(row.ownerId, row.playerId === playerA.id ? ownerA.id : ownerB.id);
  assert.equal(await balance(playerA), Math.round((265 + paid(20, single.odds) + 18 + paid(5, acca.odds)) * 100) / 100);
});

test("a result the feed corrects later settles the bets again", async () => {
  // The feed now says Gaziantep Genclik won 3–2.
  const vbRaw = vbGames.find((g) => g.id === VB);
  await volleyball.saveGame(
    parseVolleyballGame({
      ...vbRaw,
      date: new Date(Date.now() - 3 * HOUR).toISOString(),
      status: { short: "FT" },
      scores: { home: 2, away: 3 },
      periods: { first: { home: 25, away: 20 }, second: { home: 22, away: 25 }, third: { home: 25, away: 23 }, fourth: { home: 18, away: 25 }, fifth: { home: 10, away: 15 } },
    }),
    false,
  );
  const event = await prisma.event.findFirstOrThrow({ where: { externalId: String(VB) } });
  assert.ok(event.resultChangedAt, "marked for settling again");
  await settlement.settleEvent(event.id, true);
  assert.deepEqual([(await reload(single.id)).status, Number((await reload(single.id)).payout)], ["LOST", 0]);
  assert.equal((await reload(acca.id)).status, "WON", "the accumulator's leg was over 3.5 sets: still won with 5");
});

test("Super Admin enters results by hand: sets for volleyball, goals and the half for handball", async () => {
  const vbEvent = await prisma.event.findFirstOrThrow({ where: { externalId: String(VB) } });
  await assert.rejects(settlement.correctResult(SA(), vbEvent.id, 3, 3), /sets won/);
  await assert.rejects(settlement.correctResult(SA(), vbEvent.id, 2, 1), /sets won/);
  // Back to Altekma 3–1: the stored set points (Gaziantep's 3–2) no longer fit, so they go and the points markets would wait.
  await settlement.correctResult(SA(), vbEvent.id, 3, 1);
  const corrected = await prisma.event.findUniqueOrThrow({ where: { id: vbEvent.id } });
  assert.deepEqual([corrected.resultHome, corrected.resultAway, corrected.fightResult, corrected.resultSource], [3, 1, null, "manual"]);
  assert.equal((await reload(single.id)).status, "WON");

  // Handball 27–28 by hand, 14–14 at half time: the draw no bet single loses, the half-time/full-time bet loses.
  const hbEvent = await prisma.event.findFirstOrThrow({ where: { externalId: String(HB) } });
  await settlement.correctResult(SA(), hbEvent.id, 27, 28, { home: 14, away: 14 });
  assert.equal((await reload(handballSingle.id)).status, "LOST");
  assert.equal((await reload(bSingle.id)).status, "LOST");
  await settlement.correctResult(SA(), hbEvent.id, 28, 28, { home: 14, away: 14 });
  assert.deepEqual([(await reload(handballSingle.id)).status, Number((await reload(handballSingle.id)).payout)], ["VOID", 10], "a draw gives draw no bet's stake back");
});

test("teardown", async () => {
  await prisma.$disconnect();
});
