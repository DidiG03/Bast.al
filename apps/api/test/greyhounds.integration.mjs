// Greyhound racing end to end against a real Postgres: a race card saved from
// the feed, a Player betting at the starting price (and not in an
// accumulator), the team's open payouts counting the bet at its ceiling, and
// the official result settling it: SP less the margin, a withdrawn dog void,
// a dead heat, a forecast dividend, and a won bet waiting for its SP. Like the
// other integration tests it empties tables, so it only runs against a
// database whose name ends in "_test".
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
const { GreyhoundSyncService } = require("../dist/odds/greyhound-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
delete process.env.API_FOOTBALL_KEY;
delete process.env.ODDS_FEED_MOCK;
delete process.env.GREYHOUND_API_KEY;

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const sync = new OddsSyncService(prisma);
const greyhounds = new GreyhoundSyncService(prisma);
const odds = new OddsService(prisma, audit, sync);
const risk = new RiskService(prisma, audit);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, risk, sync);

const MIN = 60_000;
let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_gh${n}`, username: `gh${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hgh${n}`, role, parentId, ...extra } });
}
const balance = async (id) => Number((await prisma.user.findUniqueOrThrow({ where: { id } })).balance);

const dogs = [
  [101, "Swift Airy"],
  [102, "Zoo Da Man"],
  [103, "Rathorpe Ogie"],
  [104, "Cheery Girl"],
];
/** A race as parseRace gives it. */
const race = (id, startsAt, extra = {}) => ({
  externalId: id,
  track: "Romford",
  region: "GB",
  raceNumber: 4,
  grade: "A3",
  distance: 400,
  startsAt,
  status: "scheduled",
  runners: dogs.map(([dogId, name], i) => ({ dogId, name, trap: i + 1, trainer: "P W Young", status: "runner" })),
  result: null,
  ...extra,
});
const finished = (positions, forecastDividend = 14.2) => ({ final: true, positions: positions.map(([dogId, position, sp]) => ({ dogId, position, sp })), forecastDividend });

let owner, dita, ditaActor, sa;

async function pick(eventExternalId, marketKey, key) {
  return prisma.selection.findFirstOrThrow({ where: { key, market: { key: marketKey, event: { externalId: eventExternalId } } } });
}

test("setup", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "platform_settings", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.create({ data: { id: "default", baseOddsMargin: 5 } });
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  const manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 1000 });
  dita = await user("PLAYER", manager.id, { balance: 200 });
  ditaActor = { id: dita.id, role: "PLAYER", parentId: manager.id };
});

test("a race card becomes a race with Winner, Forecast and Tricast markets, listed under greyhounds only", async () => {
  await greyhounds.saveRace(race("r1", new Date(Date.now() + 30 * MIN)));
  const list = await odds.events(ditaActor, "upcoming", undefined, "list", "greyhounds");
  assert.equal(list.length, 1);
  const [row] = list;
  assert.equal(row.sport, "greyhounds");
  assert.equal(row.name, "Romford · Race 4");
  assert.equal(row.marketCount, 3);
  assert.deepEqual(row.markets[0].selections.map((s) => [s.name, s.price, s.sp, s.info.trap]), [["Swift Airy", 0, true, 1], ["Zoo Da Man", 0, true, 2], ["Rathorpe Ogie", 0, true, 3], ["Cheery Girl", 0, true, 4]]);
  assert.deepEqual(await odds.events(ditaActor, "upcoming", undefined, "list"), [], "the football list doesn't show races");
  const full = await odds.event(ditaActor, row.id);
  assert.equal(full.markets[1].selections.length, 12);
  assert.equal(full.markets[2].selections.length, 24, "every 1st-2nd-3rd of four dogs");
});

test("a race bet is placed at SP, counts at its ceiling, and can't go in an accumulator", async () => {
  const swift = await pick("r1", "race_winner", "d101");
  const placed = await bets.place(ditaActor, { bets: [{ selectionId: swift.id, stake: 10, odds: 0 }] });
  const [bet] = placed.bets;
  assert.deepEqual([bet.odds, bet.sp, bet.spCap, bet.potentialPayout], [null, true, 51, null]);
  assert.match(bet.description, /Romford · Race 4 · Winner: Swift Airy \(SP\)/);
  assert.equal(await balance(dita.id), 190);
  const row = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
  assert.equal(Number(row.spMargin), 5, "the team's margin when it was placed");
  const exposure = await risk.exposure(prisma, owner.id, [swift.id]);
  assert.equal(exposure.get(swift.id).singles.payout, 510, "10 at the 51.00 ceiling");

  const football = await prisma.event.create({ data: { name: "Tirana v Partizani", league: "Superiore", startsAt: new Date(Date.now() + 60 * MIN) } });
  const market = await prisma.market.create({ data: { eventId: football.id, key: "match_winner", name: "Match winner" } });
  const home = await prisma.selection.create({ data: { marketId: market.id, key: "home", name: "Tirana", feedOdds: 2 } });
  const zoo = await pick("r1", "race_winner", "d102");
  await assert.rejects(
    bets.place(ditaActor, { accumulator: { stake: 5, legs: [{ selectionId: home.id, odds: 1.9 }, { selectionId: zoo.id, odds: 0 }] } }),
    /Greyhound picks can only be single bets/,
  );
  await assert.rejects(odds.setOverride({ id: owner.id, role: "OWNER" }, zoo.id, 5), /paid at the starting price/);
});

test("bets close a minute before the start", async () => {
  await greyhounds.saveRace(race("r2", new Date(Date.now() + 40_000)));
  const swift = await pick("r2", "race_winner", "d101");
  await assert.rejects(bets.place(ditaActor, { bets: [{ selectionId: swift.id, stake: 5, odds: 0 }] }), /Bets are closed/);
});

test("the result settles: the winner at its SP less the margin, a withdrawn dog void, a forecast at the dividend", async () => {
  const startsAt = new Date(Date.now() + 30 * MIN);
  const forecast = await pick("r1", "race_forecast", "d101-d103");
  const cheery = await pick("r1", "race_winner", "d104");
  const zoo = await pick("r1", "race_winner", "d102");
  await bets.place(ditaActor, { bets: [{ selectionId: forecast.id, stake: 2, odds: 0 }, { selectionId: cheery.id, stake: 5, odds: 0 }, { selectionId: zoo.id, stake: 4, odds: 0 }] });
  assert.equal(await balance(dita.id), 179);

  // Cheery Girl is withdrawn: no more bets on her.
  const withdrawn = race("r1", startsAt);
  withdrawn.runners[3].status = "withdrawn";
  await greyhounds.saveRace(withdrawn);
  await assert.rejects(bets.place(ditaActor, { bets: [{ selectionId: cheery.id, stake: 5, odds: 0 }] }), /closed/);

  // Swift Airy wins at 7/2 (4.50), Rathorpe Ogie 2nd; Zoo Da Man ran and lost.
  await greyhounds.saveRace({ ...withdrawn, status: "complete", result: finished([[101, 1, 4.5], [103, 2, 6], [102, 3, 3]]) });
  await settlement.settleDue();
  const placed = await prisma.bet.findMany({ where: { playerId: dita.id }, orderBy: { placedAt: "asc" } });
  const byDesc = (text) => placed.find((b) => b.description.includes(text));
  const swift = byDesc("Winner: Swift Airy");
  assert.deepEqual([swift.status, Number(swift.odds), Number(swift.payout)], ["WON", 4.27, 42.7], "4.50 less 5% is 4.27, on $10");
  assert.deepEqual([byDesc("Forecast").status, Number(byDesc("Forecast").odds), Number(byDesc("Forecast").payout)], ["WON", 13.49, 26.98], "14.20 less 5%, on $2");
  assert.deepEqual([byDesc("Cheery Girl").status, Number(byDesc("Cheery Girl").payout)], ["VOID", 5]);
  assert.deepEqual([byDesc("Zoo Da Man").status, Number(byDesc("Zoo Da Man").payout)], ["LOST", 0]);
  assert.equal(await balance(dita.id), 253.68, "179 + 42.70 + 26.98 + 5");
});

test("a dead heat pays half the stake at the SP; a won bet with no SP yet waits, and Super Admin can't call it won", async () => {
  await greyhounds.saveRace(race("r3", new Date(Date.now() + 30 * MIN)));
  const [swift, zoo, pair] = await Promise.all([pick("r3", "race_winner", "d101"), pick("r3", "race_winner", "d102"), pick("r3", "race_forecast", "d101-d102")]);
  await bets.place(ditaActor, { bets: [{ selectionId: swift.id, stake: 10, odds: 0 }, { selectionId: zoo.id, stake: 10, odds: 0 }, { selectionId: pair.id, stake: 1, odds: 0 }] });
  const before = await balance(dita.id);
  // A dead heat for 1st, and the sandbox sends no SP for Zoo Da Man.
  await greyhounds.saveRace({ ...race("r3", new Date(Date.now() + 30 * MIN)), status: "complete", result: finished([[101, 1, 6], [102, 1, null], [103, 3, 5]]) });
  await settlement.settleDue();
  const mine = await prisma.bet.findMany({ where: { selectionId: { in: [swift.id, zoo.id, pair.id] } } });
  const of = (id) => mine.find((b) => b.selectionId === id);
  assert.deepEqual([of(swift.id).status, Number(of(swift.id).odds), Number(of(swift.id).payout)], ["WON", 2.85, 28.5], "6.00 less 5% is 5.70, halved");
  assert.equal(of(zoo.id).status, "OPEN", "won, but waiting for the SP");
  assert.equal(of(pair.id).status, "OPEN", "a forecast in a dead heat waits for Super Admin");
  assert.equal(await balance(dita.id), before + 28.5);

  const sAdmin = { id: sa.id, role: "SUPER_ADMIN" };
  await assert.rejects(settlement.settleSelection(sAdmin, zoo.id, "WON"), /starting price isn't known yet/);
  const waiting = (await settlement.adminEvents()).find((e) => e.name === "Romford · Race 4" && e.waiting.length > 0 && e.waiting.some((w) => w.selectionId === zoo.id));
  assert.ok(waiting, "shown to Super Admin as waiting");
  await settlement.settleSelection(sAdmin, pair.id, "LOST");
  assert.equal((await prisma.bet.findFirstOrThrow({ where: { selectionId: pair.id } })).status, "LOST");

  // The SP arrives later: the bet settles then.
  await greyhounds.saveRace({ ...race("r3", new Date(Date.now() + 30 * MIN)), status: "complete", result: finished([[101, 1, 6], [102, 1, 3], [103, 3, 5]]) });
  await prisma.event.updateMany({ where: { externalId: "r3" }, data: { resultChangedAt: new Date(Date.now() - 11 * MIN) } });
  await settlement.settleDue();
  const zooBet = await prisma.bet.findFirstOrThrow({ where: { selectionId: zoo.id } });
  assert.deepEqual([zooBet.status, Number(zooBet.odds), Number(zooBet.payout)], ["WON", 1.42, 14.2], "3.00 less 5% is 2.85, halved");
});

test("a void race refunds everything", async () => {
  await greyhounds.saveRace(race("r4", new Date(Date.now() + 30 * MIN)));
  const swift = await pick("r4", "race_winner", "d101");
  await bets.place(ditaActor, { bets: [{ selectionId: swift.id, stake: 3, odds: 0 }] });
  const before = await balance(dita.id);
  await greyhounds.saveRace({ ...race("r4", new Date(Date.now() + 30 * MIN)), status: "abandoned" });
  await settlement.settleDue();
  assert.equal((await prisma.bet.findFirstOrThrow({ where: { selectionId: swift.id } })).status, "VOID");
  assert.equal(await balance(dita.id), before + 3);
});

test("the home page's next races, the last six hours' results, and a race with no result refunded after six hours", async () => {
  await greyhounds.saveRace(race("r5", new Date(Date.now() + 5 * MIN)));
  await greyhounds.saveRace(race("r6", new Date(Date.now() + 10 * MIN)));
  const next = await odds.topEvents(ditaActor, 2, "greyhounds");
  assert.deepEqual(next.map((r) => r.race.raceNumber), [4, 4]);
  assert.ok(next[0].startsAt <= next[1].startsAt, "soonest first");
  assert.ok(next.every((r) => r.status === "UPCOMING" && r.bettable && r.markets[0].key === "race_winner"));

  const r1 = await prisma.event.findFirstOrThrow({ where: { externalId: "r1" } });
  await prisma.event.update({ where: { id: r1.id }, data: { startsAt: new Date(Date.now() - 2 * 60 * MIN) } });
  const finished = await odds.events(ditaActor, "finished", undefined, "list", "greyhounds");
  assert.deepEqual(finished.find((r) => r.id === r1.id)?.raceResult.positions.map((p) => p.dogId), [101, 103, 102], "a run race with its finishing order");
  await prisma.event.update({ where: { id: r1.id }, data: { startsAt: new Date(Date.now() - 7 * 60 * MIN) } });
  assert.equal((await odds.events(ditaActor, "finished", undefined, "list", "greyhounds")).some((r) => r.id === r1.id), false, "run over six hours ago: off the list");

  // r5 never gets a result: after six hours its bets come back.
  const swift = await pick("r5", "race_winner", "d101");
  await bets.place(ditaActor, { bets: [{ selectionId: swift.id, stake: 4, odds: 0 }] });
  const before = await balance(dita.id);
  await prisma.event.updateMany({ where: { externalId: "r5" }, data: { startsAt: new Date(Date.now() - 6 * 60 * MIN - MIN) } });
  await settlement.settleDue();
  const refunded = await prisma.bet.findFirstOrThrow({ where: { selectionId: swift.id } });
  assert.deepEqual([refunded.status, refunded.voidReason], ["VOID", "No official result within 6 hours of the race"]);
  assert.equal(await balance(dita.id), before + 4);
});

test("a result from the results feed (no dogs listed) settles a race we list, keeps its card, and skips races we don't", async () => {
  await greyhounds.saveRace(race("r7", new Date(Date.now() + 30 * MIN)));
  const swift = await pick("r7", "race_winner", "d101");
  await bets.place(ditaActor, { bets: [{ selectionId: swift.id, stake: 2, odds: 0 }] });
  const resultOnly = { ...race("r7", new Date(Date.now() + 30 * MIN)), runners: [], status: "complete", result: finished([[101, 1, 2], [102, 2, 3]]) };
  assert.equal(await greyhounds.saveRace(resultOnly, false), true);
  const saved = await prisma.event.findFirstOrThrow({ where: { externalId: "r7" }, include: { markets: { include: { selections: true } } } });
  assert.equal(saved.status, "COMPLETED");
  assert.equal(saved.race.runners.length, 4, "the card's dogs are kept");
  assert.equal(saved.markets.find((m) => m.key === "race_winner").selections.filter((s) => !s.withdrawn).length, 4);
  await settlement.settleDue();
  assert.equal((await prisma.bet.findFirstOrThrow({ where: { selectionId: swift.id } })).status, "WON");
  assert.equal(await greyhounds.saveRace({ ...resultOnly, externalId: "not-listed" }, false), false);
  assert.equal(await prisma.event.count({ where: { externalId: "not-listed" } }), 0);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
