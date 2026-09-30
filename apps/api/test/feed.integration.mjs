// Moving a Player, the feed correcting a score, and matches that aren't
// played, end to end against a real Postgres. Like journal.integration.mjs it
// empties the tables it uses, so it only runs against a database whose name
// ends in "_test" (see there for how to set one up).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient, Prisma } = require("@prisma/client");
const { SettlementService } = require("../dist/bets/settlement.service.js");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { teamOf } = require("../dist/bets/team.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
delete process.env.API_FOOTBALL_KEY;
delete process.env.ODDS_FEED_MOCK;

const prisma = new PrismaClient();
const sent = [];
const notifications = { create: async (n) => (sent.push(n), n) };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
// No feed key: nothing is fetched, but results and kick-offs are saved as the feed would save them.
const sync = new OddsSyncService(prisma);

const HOUR = 3_600_000;
let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_f${n}`, username: `f${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hf${n}`, role, parentId, ...extra } });
}
const find = (account) => prisma.user.findUniqueOrThrow({ where: { id: account.id } });
const reload = (b) => prisma.bet.findUniqueOrThrow({ where: { id: b.id } });

/** A match from the feed with one pick on the home side. */
async function match(name, data) {
  const event = await prisma.event.create({ data: { name, league: "Superiore", provider: "api-football", ...data } });
  const market = await prisma.market.create({ data: { eventId: event.id, key: "match_winner", name: "Match winner" } });
  const selection = await prisma.selection.create({ data: { marketId: market.id, key: "home", name: name.split(" v ")[0], feedOdds: 2 } });
  return { event, selection };
}

/** An open single at 2.00, as bet placement records it. */
async function bet(player, selection, { stake, placedAt }) {
  return prisma.bet.create({ data: { playerId: player.id, selectionId: selection.id, stake, odds: 2, description: "Match winner", ...(placedAt ? { placedAt } : {}), ...(await teamOf(prisma, player.id)) } });
}

let sa, owner, managerA, managerB, cara;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "bet_legs", "bets", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  managerA = await user("MANAGER", owner.id, { commissionRate: 20, balance: 1000 });
  managerB = await user("MANAGER", owner.id, { commissionRate: 30 });
  cara = await user("PLAYER", managerA.id, { balance: 70 });
});

test("a Player with open bets, or below zero, waits to be moved", async () => {
  const { selection } = await match("Vllaznia v Teuta", { startsAt: new Date(Date.now() + HOUR), externalId: "m1" });
  const open = await bet(cara, selection, { stake: 10 });
  await assert.rejects(users.reassignPlayer(owner, cara.id, managerB.id), new RegExp(`${cara.username} still has 1 open bet. Move them once it's settled.`));
  const preview = await users.reassignmentPreview(owner, cara.id, managerB.id);
  assert.equal(preview.valid, false);
  assert.match(preview.reason, /open bet/);
  await prisma.bet.delete({ where: { id: open.id } });

  await prisma.user.update({ where: { id: cara.id }, data: { balance: -20 } });
  await assert.rejects(users.reassignPlayer(owner, cara.id, managerB.id), /balance is below zero \(-\$20\.00\)/);
  await prisma.user.update({ where: { id: cara.id }, data: { balance: 70 } });
  assert.equal((await find(cara)).parentId, managerA.id, "nothing moved");
});

test("a moved Player's balance goes back to whoever gave it to them", async () => {
  // A top-up from the old Manager still waiting for approval.
  const pending = await prisma.balanceTransaction.create({
    data: { fromUserId: managerA.id, toUserId: cara.id, actorId: managerA.id, type: "DELEGATION", amount: 20000, reason: "Big top-up", status: "PENDING" },
  });
  const preview = await users.reassignmentPreview(owner, cara.id, managerB.id);
  assert.deepEqual([preview.valid, preview.impact.returnedBalance, preview.impact.returnedTo], [true, 70, managerA.username]);

  sent.length = 0;
  await users.reassignPlayer(owner, cara.id, managerB.id);
  const [moved, a] = await Promise.all([find(cara), find(managerA)]);
  assert.equal(moved.parentId, managerB.id);
  assert.equal(Number(moved.balance), 0, "Manager B starts them from nothing");
  assert.equal(Number(a.balance), 1070, "Manager A has their 70 back");
  const back = await prisma.balanceTransaction.findFirstOrThrow({ where: { type: "RECLAIM", fromUserId: cara.id } });
  assert.deepEqual([back.toUserId, Number(back.amount), back.reason, back.actorId], [managerA.id, 70, `Returned when moved to ${managerB.username}`, owner.id]);
  assert.equal((await prisma.balanceTransaction.findUniqueOrThrow({ where: { id: pending.id } })).status, "REJECTED", "the old team's top-up can't land after the move");
  assert.equal(sent.find((s) => s.userId === managerA.id).message, `${cara.username} was moved to another manager. Their $70.00 balance came back to you.`);
  assert.equal(sent.find((s) => s.userId === cara.id).message, `Your account was reassigned to manager ${managerB.username}. Your $70.00 balance went back to ${managerA.username}.`);
  assert.equal(sent.find((s) => s.userId === managerB.id).message, `${cara.username} was assigned to your team. Their balance starts at $0.00.`);
});

test("a score the feed corrects settles the bets again, once it has held for 10 minutes", async () => {
  await prisma.user.update({ where: { id: cara.id }, data: { balance: 100 } });
  const { event, selection } = await match("Egnatia v Dinamo", { startsAt: new Date(Date.now() - 3 * HOUR), status: "COMPLETED", externalId: "m2", resultHome: 2, resultAway: 0, resultSource: "feed" });
  const b = await bet(cara, selection, { stake: 10 });
  await settlement.settleDue();
  assert.equal((await reload(b)).status, "WON");
  assert.equal(Number((await find(cara)).balance), 120);

  const fixture = { externalId: "m2", result: { home: 0, away: 1 }, halfTime: null, extraTime: false };
  await sync.recordResult("api-football", { ...fixture, result: { home: 2, away: 0 } });
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).resultChangedAt, null, "the same score again isn't a change");
  await sync.recordResult("api-football", { ...fixture, result: { home: 2, away: 0 }, halfTime: { home: 1, away: 0 } });
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).resultChangedAt, null, "nor is a half-time score arriving late");

  await sync.recordResult("api-football", fixture);
  const flagged = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
  assert.ok(flagged.resultChangedAt);
  assert.deepEqual([flagged.resultHome, flagged.resultAway], [0, 1]);
  await settlement.settleDue();
  assert.equal((await reload(b)).status, "WON", "not yet: the feed might change it back");

  await prisma.event.update({ where: { id: event.id }, data: { resultChangedAt: new Date(Date.now() - 11 * 60_000) } });
  sent.length = 0;
  await settlement.settleDue();
  const corrected = await reload(b);
  assert.deepEqual([corrected.status, Number(corrected.payout)], ["LOST", 0]);
  assert.equal(Number((await find(cara)).balance), 100, "the 20 paid out was taken back");
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).resultChangedAt, null);
  assert.equal(sent.find((s) => s.userId === sa.id)?.message, "The feed changed Egnatia v Dinamo to 0-1, so 1 bet was settled again.");
  assert.equal(sent.find((s) => s.userId === cara.id)?.title, "Result corrected");
  const journal = await prisma.settlementEntry.findMany({ where: { betId: b.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(journal.map((row) => Number(row.payout)), [20, -20], "the correction is journalled as a difference");

  // A score Super Admin sets by hand is never changed by the feed.
  await settlement.correctResult(sa, event.id, 3, 3);
  await sync.recordResult("api-football", { ...fixture, result: { home: 5, away: 0 } });
  const manual = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
  assert.deepEqual([manual.resultHome, manual.resultAway, manual.resultChangedAt], [3, 3, null]);
});

test("finished matches with bets are asked about again for two days, each once an hour", async () => {
  const asked = [];
  const scores = { m8: { home: 1, away: 1 }, m9: { home: 0, away: 0 } };
  sync.client = { fixturesByIds: async (ids) => (asked.push(...ids), ids.map((id) => ({ externalId: id, result: scores[id] ?? null, halfTime: null, extraTime: false }))) };
  const twoHoursAgo = new Date(Date.now() - 2 * HOUR);
  const yesterday = await match("Teuta v Laçi", { startsAt: new Date(Date.now() - 20 * HOUR), status: "COMPLETED", externalId: "m8", resultHome: 1, resultAway: 0, resultSource: "feed", syncedAt: twoHoursAgo });
  await prisma.bet.create({ data: { playerId: cara.id, selectionId: yesterday.selection.id, stake: 5, odds: 2, status: "WON", payout: 10, settledAt: new Date() } });
  await match("Bylis v Vora", { startsAt: new Date(Date.now() - 20 * HOUR), status: "COMPLETED", externalId: "m9", resultHome: 2, resultAway: 0, resultSource: "feed", syncedAt: twoHoursAgo });
  const old = await match("Dinamo v Egnatia", { startsAt: new Date(Date.now() - 60 * HOUR), status: "COMPLETED", externalId: "m10", resultHome: 0, resultAway: 0, resultSource: "feed", syncedAt: twoHoursAgo });
  await prisma.bet.create({ data: { playerId: cara.id, selectionId: old.selection.id, stake: 5, odds: 2, status: "LOST", settledAt: new Date() } });

  assert.equal(await sync.recheckResults(), 1);
  assert.deepEqual(asked, ["m8"], "only the match with bets, from the last two days");
  const saved = await prisma.event.findUniqueOrThrow({ where: { id: yesterday.event.id } });
  assert.deepEqual([saved.resultHome, saved.resultAway, Boolean(saved.resultChangedAt)], [1, 1, true]);
  assert.equal(await sync.recheckResults(), 0, "not again within the hour");
  sync.client = undefined;
});

test("bets on a match not played within 48 hours of kick-off are refunded", async () => {
  await prisma.user.update({ where: { id: cara.id }, data: { balance: 0 } });
  const late = await match("Laçi v Bylis", { startsAt: new Date(Date.now() - 49 * HOUR), status: "POSTPONED", externalId: "m3" });
  const recent = await match("Kukësi v Elbasani", { startsAt: new Date(Date.now() - 47 * HOUR), status: "POSTPONED", externalId: "m4" });
  const stuck = await match("Flamurtari v Besa", { startsAt: new Date(Date.now() - 50 * HOUR), status: "LIVE", externalId: "m5" });
  const won = await match("Tirana v Apolonia", { startsAt: new Date(Date.now() - 50 * HOUR), status: "COMPLETED", externalId: "m6", resultHome: 1, resultAway: 0, resultSource: "feed" });
  const single = await bet(cara, late.selection, { stake: 30 });
  const waiting = await bet(cara, recent.selection, { stake: 15 });
  const abandoned = await bet(cara, stuck.selection, { stake: 5 });
  // An accumulator with a pick on the postponed match and one that won.
  const acca = await prisma.bet.create({
    data: {
      playerId: cara.id, stake: 10, odds: 4, kind: "ACCUMULATOR", description: "Accumulator",
      legs: { create: [{ selectionId: late.selection.id, odds: 2, description: "Laçi" }, { selectionId: won.selection.id, odds: 2, description: "Tirana", result: "WON" }] },
      ...(await teamOf(prisma, cara.id)),
    },
  });

  sent.length = 0;
  await settlement.settleDue();
  const refunded = await reload(single);
  assert.deepEqual([refunded.status, Number(refunded.payout), refunded.voidReason], ["VOID", 30, "Not played within 48 hours of kick-off"]);
  assert.equal((await reload(abandoned)).status, "VOID", "a match stuck on live for two days too");
  assert.equal((await reload(waiting)).status, "OPEN", "47 hours: still waiting");
  const accumulator = await reload(acca);
  assert.deepEqual([accumulator.status, Number(accumulator.payout)], ["WON", 20], "the postponed pick drops out and the rest still counts");
  assert.equal(Number((await find(cara)).balance), 30 + 5 + 20);
  assert.equal(sent.find((s) => s.userId === cara.id && s.title === "Bet voided")?.message, "Laçi v Bylis: your bet was voided (Not played within 48 hours of kick-off). $30.00 went back to your balance.");
});

test("a match moved to a later date refunds only the bets placed for the old date", async () => {
  const kickOff = new Date(Date.now() + HOUR);
  const { event, selection } = await match("Partizani v Skënderbeu", { startsAt: kickOff, externalId: "m7" });
  const early = await bet(cara, selection, { stake: 12, placedAt: new Date(Date.now() - 60_000) });
  const fixture = { externalId: "m7", leagueId: 310, season: 2026, league: "Superiore", country: "Albania", homeTeam: "Partizani", awayTeam: "Skënderbeu", status: "UPCOMING", elapsed: null, homeScore: null, awayScore: null, result: null, halfTime: null, extraTime: false };

  const nextDay = new Date(kickOff.getTime() + 24 * HOUR);
  await sync.upsertEvent({ ...fixture, startsAt: nextDay }, kickOff);
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).rescheduledAt, null, "a day later: the bets stand");

  await sync.upsertEvent({ ...fixture, startsAt: new Date(nextDay.getTime() + 3 * 24 * HOUR) }, nextDay);
  assert.ok((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).rescheduledAt);
  const later = await bet(cara, selection, { stake: 8, placedAt: new Date(Date.now() + 1_000) });

  await settlement.settleDue();
  const refunded = await reload(early);
  assert.deepEqual([refunded.status, refunded.voidReason], ["VOID", "Moved more than 48 hours after the original kick-off"]);
  assert.equal((await reload(later)).status, "OPEN", "a bet placed for the new date stands");
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).rescheduledAt, null);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
