// The wider football offer end to end against a real Postgres: saving the
// feed's prices (and withdrawing outcomes it stops pricing), the light match
// list with one match's full markets, a bet slip's price check, goals fetched
// after full time settling the goal-event markets, and Super Admin settling a
// pick by hand. Like the other integration tests it empties tables, so it
// only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { SettlementService } = require("../dist/bets/settlement.service.js");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
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
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const sync = new OddsSyncService(prisma);
const odds = new OddsService(prisma, audit, sync);

const HOUR = 3_600_000;
const details = JSON.parse(await readFile(new URL("./fixtures/api-football-fixtures-with-events.json", import.meta.url), "utf8")).response;

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_fb${n}`, username: `fb${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hfb${n}`, role, parentId, ...extra } });
}
const reload = (b) => prisma.bet.findUniqueOrThrow({ where: { id: b.id } });
const market = (key, name, selections) => ({ key, name, sortOrder: 0, selections: selections.map(([k, s, o], i) => ({ key: k, name: s, odds: o, sortOrder: i })) });

let sa, owner, manager, dita, ditaActor;

test("setup", async () => {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  sa = await user("SUPER_ADMIN", null);
  owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 1000 });
  dita = await user("PLAYER", manager.id, { balance: 100 });
  ditaActor = { id: dita.id, role: "PLAYER", parentId: manager.id };
});

test("prices are saved only when they change, and an outcome the feed drops is withdrawn until it's back", async () => {
  const event = await prisma.event.create({ data: { name: "Tirana v Partizani", league: "Superiore", provider: "api-football", externalId: "w1", startsAt: new Date(Date.now() + 5 * HOUR) } });
  const scorers = (players) => market("scorer_anytime", "Anytime goalscorer", players);
  await sync.upsertMarkets(event.id, [scorers([["a", "Arbnor Muja", 3.5], ["b", "Bekim Balaj", 4], ["c", "Cristian Rodriguez", 6]])]);
  const snapshots = () => prisma.oddsSnapshot.count({ where: { selection: { market: { eventId: event.id } } } });
  assert.equal(await snapshots(), 3);

  await sync.upsertMarkets(event.id, [scorers([["a", "Arbnor Muja", 3.5], ["b", "Bekim Balaj", 4.5]])]);
  assert.equal(await snapshots(), 4, "one price moved; the unchanged one wasn't written again");
  const c = await prisma.selection.findFirstOrThrow({ where: { key: "c", market: { eventId: event.id } } });
  assert.equal(c.withdrawn, true, "left out of the feed's list");
  assert.equal((await odds.priceForPlayer(dita.id, c.id)).bettable, false, "no bets on a withdrawn outcome");
  const full = await odds.event(ditaActor, event.id);
  assert.equal(full.markets[0].selections.find((s) => s.key === "c").suspended, true);

  await sync.upsertMarkets(event.id, [scorers([["a", "Arbnor Muja", 3.5], ["b", "Bekim Balaj", 4.5], ["c", "Cristian Rodriguez", 7]])]);
  assert.equal((await prisma.selection.findUniqueOrThrow({ where: { id: c.id } })).withdrawn, false, "back on the list, open again");
  assert.equal((await odds.priceForPlayer(dita.id, c.id)).bettable, true);
});

test("the match list carries each match's main market only; a match and a slip's picks load on their own", async () => {
  const event = await prisma.event.create({ data: { name: "Vllaznia v Teuta", league: "Superiore", provider: "api-football", externalId: "w2", startsAt: new Date(Date.now() + 6 * HOUR) } });
  await sync.upsertMarkets(event.id, [
    { ...market("match_winner", "Match winner", [["home", "Vllaznia", 2.1], ["draw", "Draw", 3.2], ["away", "Teuta", 3.4]]), sortOrder: 0 },
    { ...market("btts", "Both teams score", [["yes", "Yes", 1.8], ["no", "No", 1.95]]), sortOrder: 30 },
    { ...market("goal_range", "Number of goals", [["0-1", "0–1 goals", 3.5], ["2-3", "2–3 goals", 2], ["4+", "4+ goals", 3.8]]), sortOrder: 100 },
  ]);
  const list = await odds.events(ditaActor, "upcoming", undefined, "list");
  const row = list.find((e) => e.id === event.id);
  assert.deepEqual(row.markets.map((m) => m.key), ["match_winner"]);
  assert.equal(row.marketCount, 3);
  // Lists asked for together share one read and come out the same; the home page's top matches carry the main market too.
  const [again, top] = await Promise.all([odds.events(ditaActor, "upcoming", undefined, "list"), odds.topEvents(ditaActor, 12), odds.events(ditaActor, "upcoming", undefined, "list")]);
  assert.deepEqual(again, list);
  assert.deepEqual(top.find((e) => e.id === event.id)?.markets.map((m) => m.key), ["match_winner"]);
  const full = await odds.event(ditaActor, event.id);
  assert.deepEqual(full.markets.map((m) => m.key), ["match_winner", "btts", "goal_range"]);

  const pick = full.markets[2].selections[1];
  const [quote] = await odds.selections(ditaActor, [pick.id]);
  assert.deepEqual([quote.id, quote.eventId, quote.price, quote.bettable, quote.suspended], [pick.id, event.id, pick.price, true, false]);

  await prisma.event.update({ where: { id: event.id }, data: { hidden: true } });
  await assert.rejects(odds.event(ditaActor, event.id), /Match not found/);
  assert.deepEqual(await odds.selections(ditaActor, [pick.id]), [], "a hidden match's picks aren't shown either");
});

test("goals fetched after full time settle the goal-event markets; an unclear name waits for Super Admin", async () => {
  // Corinthians 1–3 Fluminense, as the feed sent it.
  const event = await prisma.event.create({
    data: { name: "Corinthians v Fluminense", homeTeam: "Corinthians", awayTeam: "Fluminense", league: "Serie A", provider: "api-football", externalId: "1492382", startsAt: new Date(Date.now() - 3 * HOUR), status: "COMPLETED", resultHome: 1, resultAway: 3, resultSource: "feed" },
  });
  await sync.upsertMarkets(event.id, [
    market("first_team_score", "First team to score", [["home", "Corinthians", 2], ["away", "Fluminense", 2.2], ["none", "No goal", 9]]),
    market("scorer_anytime", "Anytime goalscorer", [["hulk", "Hulk", 2.5], ["memphis-depay", "Memphis Depay", 2.8], ["pedro", "Pedro", 6]]),
    market("scorer_first", "First goalscorer", [["jesse-lingard", "Jesse Lingard", 12], ["none", "No goalscorer", 9]]),
  ]);
  const pick = (marketKey, key) => prisma.selection.findFirstOrThrow({ where: { key, market: { eventId: event.id, key: marketKey } } });
  const bet = async (selection, stake = 10, oddsAt = 2) =>
    prisma.bet.create({ data: { playerId: dita.id, selectionId: selection.id, stake, odds: oddsAt, description: selection.name, ...(await teamOf(prisma, dita.id)) } });
  const first = await bet(await pick("first_team_score", "away"));
  const hulk = await bet(await pick("scorer_anytime", "hulk"));
  const depay = await bet(await pick("scorer_anytime", "memphis-depay"));
  const lingard = await bet(await pick("scorer_first", "jesse-lingard"));
  const pedro = await bet(await pick("scorer_anytime", "pedro"));

  await settlement.settleDue();
  assert.equal((await reload(hulk)).status, "OPEN", "nothing settles before the goals are in");

  const asked = [];
  sync.client = { fixtureDetails: async (ids) => (asked.push(...ids), details.filter((d) => ids.includes(String(d.fixture.id)))) };
  assert.equal(await sync.syncGoals(), 1);
  assert.deepEqual(asked, ["1492382"]);
  assert.equal(await sync.syncGoals(), 0, "saved once, not asked again");
  sync.client = undefined;

  await settlement.settleDue();
  assert.equal((await reload(first)).status, "WON", "Fluminense scored first");
  assert.equal((await reload(hulk)).status, "WON");
  assert.equal((await reload(depay)).status, "LOST");
  assert.deepEqual([(await reload(lingard)).status, Number((await reload(lingard)).payout)], ["VOID", 10], "came on after the first goal: stake back");
  assert.equal((await reload(pedro)).status, "OPEN", "\"Pedro\" could be Pedro Raul, João Pedro or Pedro Milans");

  const card = (await settlement.adminEvents()).find((e) => e.id === event.id);
  assert.deepEqual(card.waiting.map((w) => [w.market, w.name, w.bets]), [["Anytime goalscorer", "Pedro", 1]]);
  assert.deepEqual((await settlement.adminEvents(owner.id)).find((e) => e.id === event.id).waiting, [], "only Super Admin settles by hand");

  await settlement.settleSelection(sa, card.waiting[0].selectionId, "LOST");
  assert.equal((await reload(pedro)).status, "LOST");
  await settlement.settleSelection(sa, card.waiting[0].selectionId, "WON");
  assert.deepEqual([(await reload(pedro)).status, Number((await reload(pedro)).payout)], ["WON", 20], "a change of mind settles the bet again");
  await settlement.settleDue();
  assert.equal((await reload(pedro)).status, "WON", "settlement keeps Super Admin's result");
  assert.equal((await settlement.adminEvents()).find((e) => e.id === event.id).waiting.length, 0);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: "bet.selection_result" } }));
});

test("a score the feed changes throws away the saved goals, so they're fetched again", async () => {
  const event = await prisma.event.findFirstOrThrow({ where: { externalId: "1492382" } });
  assert.ok(event.resultGoals);
  await sync.recordResult("api-football", { externalId: "1492382", result: { home: 1, away: 2 }, halfTime: null, extraTime: false });
  const after = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
  assert.deepEqual([after.resultGoals, after.goalsCheckedAt], [null, null]);

  // The correction settles again: goal bets graded on the old goals go back to open, their winnings taken back.
  const betOn = (marketKey, key) => prisma.bet.findFirstOrThrow({ where: { selection: { key, market: { eventId: event.id, key: marketKey } } } });
  const balanceBefore = Number((await prisma.user.findUniqueOrThrow({ where: { id: dita.id } })).balance);
  await settlement.settleEvent(event.id, true);
  const hulk = await betOn("scorer_anytime", "hulk");
  assert.deepEqual([hulk.status, Number(hulk.payout)], ["OPEN", 0], "Hulk's win was graded on goals that no longer add up");
  assert.equal((await betOn("first_team_score", "away")).status, "OPEN");
  assert.equal((await betOn("scorer_anytime", "pedro")).status, "WON", "Super Admin's own result stays");
  assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: dita.id } })).balance), balanceBefore - 20 - 20 - 10, "both $20 wins and Lingard's $10 refund taken back");
  assert.equal((await betOn("scorer_first", "jesse-lingard")).status, "OPEN");

  // The feed's goals don't add up to 1–2, so they wait; once the score is 1–3 again they settle again.
  sync.client = { fixtureDetails: async (ids) => details.filter((d) => ids.includes(String(d.fixture.id))) };
  assert.equal(await sync.syncGoals(), 0);
  await prisma.event.update({ where: { id: event.id }, data: { resultAway: 3, goalsCheckedAt: null } });
  assert.equal(await sync.syncGoals(), 1);
  sync.client = undefined;
  await settlement.settleDue();
  assert.equal((await betOn("scorer_anytime", "hulk")).status, "WON");
  assert.equal((await betOn("first_team_score", "away")).status, "WON");
  assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: dita.id } })).balance), balanceBefore);
});

test("a pick can only be settled by hand once the match has a result", async () => {
  const event = await prisma.event.create({ data: { name: "Laçi v Bylis", league: "Superiore", provider: "api-football", externalId: "w3", startsAt: new Date(Date.now() + HOUR) } });
  await sync.upsertMarkets(event.id, [market("btts", "Both teams score", [["yes", "Yes", 1.8], ["no", "No", 1.9]])]);
  const selection = await prisma.selection.findFirstOrThrow({ where: { market: { eventId: event.id } } });
  await assert.rejects(settlement.settleSelection(sa, selection.id, "WON"), /Set the match's result first/);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
