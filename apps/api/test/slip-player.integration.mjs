// The bet slip's API, end to end against a real Postgres: the Player's
// setting for prices that move before a bet goes in (a live pick is always
// taken only at the price on the slip), how long a live slip will wait, picks
// that are over for good, and the open bets coming a short page at a time.
// Like the other integration tests it empties tables, so it only runs against
// a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
delete process.env.API_FOOTBALL_KEY;
delete process.env.ODDS_FEED_MOCK;
process.env.LIVE_BET_DELAY_MS = "300";
process.env.LIVE_BET_EVENTFUL_DELAY_MS = "600";
process.env.LIVE_BET_ADAPTIVE_DELAY = "off";
process.env.LIVE_VERIFY = "off";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { BetsService } = require("../dist/bets/bets.service.js");
const { RiskService } = require("../dist/bets/risk.service.js");
const { BettingLimitsService } = require("../dist/commissions/betting-limits.service.js");

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const sync = new OddsSyncService(prisma);
const odds = new OddsService(prisma, audit, sync);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, new RiskService(prisma, audit), sync);

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_sp${n}`, username: `sp${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hsp${n}`, role, parentId, ...extra } });
}

async function match(name, extra = {}) {
  return prisma.event.create({
    data: {
      sport: "football",
      provider: "api-football",
      externalId: `sp-${name}`,
      name,
      league: "League",
      homeTeam: "Home",
      awayTeam: "Away",
      startsAt: new Date(Date.now() + 3 * 3_600_000),
      status: "UPCOMING",
      markets: { create: [{ key: "match_winner", name: "Match winner", selections: { create: [{ key: "home", name: "Home", feedOdds: 2 }, { key: "away", name: "Away", feedOdds: 4 }] } }] },
      ...extra,
    },
    include: { markets: { include: { selections: true } } },
  });
}
const homeOf = (event) => event.markets[0].selections.find((s) => s.key === "home");
const liveExtra = () => ({ status: "LIVE", startsAt: new Date(Date.now() - 30 * 60_000), period: "1H", elapsed: 30, homeScore: 0, awayScore: 0, liveOddsAt: new Date(), matchCentre: { moments: [] } });

let player, actor;
const shown = async (selection) => (await odds.priceForPlayer(player.id, selection.id)).odds;
/** The price moves from what the slip showed to `feed` (a pre-match price, or a live one). */
const moveTo = (selection, feed, live = false) => prisma.selection.update({ where: { id: selection.id }, data: live ? { liveOdds: feed } : { feedOdds: feed } });

test("setup", async () => {
  for (const table of ["goals_seen", "settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  const sa = await user("SUPER_ADMIN", null);
  const owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 100000 });
  const manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 10000 });
  player = await user("PLAYER", manager.id, { balance: 10000 });
  actor = { id: player.id, role: "PLAYER", parentId: player.parentId };
});

test("\"only higher odds\": a pre-match price that went up is taken at the new price; one that went down is refused", async () => {
  const up = await match("Up");
  const was = await shown(homeOf(up));
  await moveTo(homeOf(up), 2.5);
  const placed = await bets.place(actor, { bets: [{ selectionId: homeOf(up).id, stake: 10, odds: was }], priceChanges: "higher" });
  assert.ok(placed.bets[0].odds > was);
  assert.equal(placed.adjusted, true);
  const down = await match("Down");
  const before = await shown(homeOf(down));
  await moveTo(homeOf(down), 1.6);
  await assert.rejects(bets.place(actor, { bets: [{ selectionId: homeOf(down).id, stake: 10, odds: before }], priceChanges: "higher" }), /odds changed/);
});

test("\"never\": any move refuses the slip, even a better price", async () => {
  const event = await match("Never");
  const was = await shown(homeOf(event));
  await moveTo(homeOf(event), 2.04);
  await assert.rejects(bets.place(actor, { bets: [{ selectionId: homeOf(event).id, stake: 10, odds: was }], priceChanges: "never" }), /odds changed/);
  // At the price the slip shows now, it goes in.
  const now = await shown(homeOf(event));
  const placed = await bets.place(actor, { bets: [{ selectionId: homeOf(event).id, stake: 10, odds: now }], priceChanges: "never" });
  assert.equal(placed.bets[0].odds, now);
});

test("a live pick is only ever taken at the price on the slip, whatever the setting", async () => {
  const event = await match("Live", { ...liveExtra(), markets: { create: [{ key: "match_winner", name: "Match winner", selections: { create: [{ key: "home", name: "Home", feedOdds: 2, liveOdds: 2 }, { key: "away", name: "Away", feedOdds: 4, liveOdds: 4 }] } }] } });
  const was = await shown(homeOf(event));
  await moveTo(homeOf(event), 2.5, true);
  await assert.rejects(bets.place(actor, { bets: [{ selectionId: homeOf(event).id, stake: 10, odds: was }], priceChanges: "higher" }), /odds changed/);
  assert.equal(await prisma.bet.count({ where: { selectionId: homeOf(event).id } }), 0);
});

test("how long a slip would wait: nothing for pre-match picks; the minimum for a live one, and a recent goal does not add to it", async () => {
  const pre = await match("Pre wait");
  assert.deepEqual(await bets.plannedWait(actor, [homeOf(pre).id]), { live: false, waitMs: 0, checkMs: 0, longerBecause: null });
  const quiet = await match("Quiet wait", liveExtra());
  const planned = await bets.plannedWait(actor, [homeOf(quiet).id]);
  assert.equal(planned.live, true);
  assert.equal(planned.waitMs, 300);
  assert.ok(planned.checkMs > 0);
  const busy = await match("Busy wait", liveExtra());
  await prisma.goalSeen.create({ data: { eventId: busy.id, homeScore: 1, awayScore: 0, source: "odds" } });
  const longer = await bets.plannedWait(actor, [homeOf(busy).id, homeOf(pre).id]);
  assert.equal(longer.waitMs, 300, "a recent goal is noted and does not lengthen the wait");
  assert.equal(longer.longerBecause, "a goal in the last minutes");
});

test("a pick on a finished match is over for good (the slip drops it); one on a match that's about to start isn't", async () => {
  const done = await match("Finished", { status: "COMPLETED", startsAt: new Date(Date.now() - 3 * 3_600_000), resultHome: 1, resultAway: 0 });
  const soon = await match("Soon");
  const quotes = await odds.selections({ id: player.id, role: "PLAYER", parentId: player.parentId }, [homeOf(done).id, homeOf(soon).id]);
  assert.equal(quotes.find((q) => q.id === homeOf(done).id).final, true);
  assert.equal(quotes.find((q) => q.id === homeOf(soon).id).final, false);
});

test("open bets come a short page at a time", async () => {
  const page = await bets.mine(actor, "open", undefined, 2);
  assert.equal(page.bets.length, 2);
  assert.equal(page.hasMore, true);
  const next = await bets.mine(actor, "open", page.bets[1].placedAt.toISOString(), 2);
  assert.ok(next.bets.every((bet) => !page.bets.some((first) => first.id === bet.id)));
});

test("teardown", async () => {
  await prisma.$disconnect();
});
