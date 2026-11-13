// A goal SportScore shows before API-Football, end to end against a real
// Postgres: every market of the match pauses at once, live slips are refused,
// and a live bet placed between the real goal and our feed's confirmation is
// voided at settlement, never paid. Like the other integration tests it
// empties tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { SettlementService } = require("../dist/bets/settlement.service.js");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { EarlyGoalService } = require("../dist/odds/early-goal.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { BetsService } = require("../dist/bets/bets.service.js");
const { RiskService } = require("../dist/bets/risk.service.js");
const { BettingLimitsService } = require("../dist/commissions/betting-limits.service.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
delete process.env.API_FOOTBALL_KEY;
delete process.env.ODDS_FEED_MOCK;
delete process.env.LATE_KEEP_HURT_BETS;
process.env.LIVE_BET_DELAY_MS = "600";
process.env.LIVE_VERIFY = "off";

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const sync = new OddsSyncService(prisma);
const odds = new OddsService(prisma, audit, sync);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, new RiskService(prisma, audit), sync);
// No fetch: each test hands in what SportScore shows.
const early = new EarlyGoalService(prisma, sync, async () => {
  throw new Error("no network in tests");
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_eg${n}`, username: `eg${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `heg${n}`, role, parentId, ...extra } });
}

/** A football match 30 minutes in, 0–0, linked to SportScore's `slug`, its prices fresh. */
async function liveMatch(name, slug) {
  const event = await prisma.event.create({
    data: {
      sport: "football",
      provider: "api-football",
      externalId: `eg-${slug}`,
      name,
      league: "League",
      homeTeam: "Home",
      awayTeam: "Away",
      startsAt: new Date(Date.now() - 30 * 60_000),
      status: "LIVE",
      period: "1H",
      elapsed: 30,
      homeScore: 0,
      awayScore: 0,
      liveOddsAt: new Date(),
      matchCentre: { moments: [] },
      markets: {
        create: [
          { key: "match_winner", name: "Match winner", liveQuotedAt: new Date(), selections: { create: [{ key: "home", name: "Home", feedOdds: 2, liveOdds: 2 }, { key: "draw", name: "Draw", feedOdds: 3, liveOdds: 3 }, { key: "away", name: "Away", feedOdds: 4, liveOdds: 4 }] } },
          { key: "goals_2_5", name: "Total goals 2.5", liveQuotedAt: new Date(), selections: { create: [{ key: "over", name: "Over 2.5", feedOdds: 2, liveOdds: 2 }, { key: "under", name: "Under 2.5", feedOdds: 1.8, liveOdds: 1.8 }] } },
        ],
      },
    },
    include: { markets: { include: { selections: true } } },
  });
  await prisma.trackerMapping.create({ data: { eventId: event.id, externalId: slug, confidence: 1, method: "manual" } });
  return event;
}
const pick = (event, market, key) => event.markets.find((m) => m.key === market).selections.find((s) => s.key === key);

let player, actor;
async function place(event, market = "match_winner", key = "home") {
  const selection = pick(event, market, key);
  const price = (await odds.priceForPlayer(player.id, selection.id)).odds;
  return bets.place(actor, { bets: [{ selectionId: selection.id, stake: 10, odds: price }] });
}
const balance = async () => Number((await prisma.user.findUniqueOrThrow({ where: { id: player.id } })).balance);

test("setup", async () => {
  for (const table of ["early_goals", "goals_seen", "tracker_mappings", "settlement_entries", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  const sa = await user("SUPER_ADMIN", null);
  const owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  const manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 1000 });
  player = await user("PLAYER", manager.id, { balance: 1000 });
  actor = { id: player.id, role: "PLAYER", parentId: player.parentId };
});

test("a goal SportScore shows first pauses every market of the match at once, and a new live slip is refused", async () => {
  const match = await liveMatch("SportScore first", "home-v-away-1");
  const before = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
  const now = new Date();
  assert.equal(await early.run(now, [{ id: "home-v-away-1", home: 1, away: 0 }]), 1);

  const markets = await prisma.market.findMany({ where: { eventId: match.id } });
  assert.equal(markets.length, 2);
  for (const market of markets) {
    assert.equal(market.livePauseReason, "ahead", `${market.key} is paused`);
    assert.ok(market.livePausedUntil > now);
  }
  const after = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
  assert.equal(after.liveEarlyScore, "1:0");
  assert.equal(after.homeScore, 0, "our own score is untouched until our feed has the goal");
  assert.equal(after.liveVersion, before.liveVersion + 1, "a slip already waiting is refused");
  assert.equal((await odds.priceForPlayer(player.id, pick(match, "goals_2_5", "over").id)).bettable, false);
  const sightings = await prisma.earlyGoal.findMany({ where: { eventId: match.id } });
  assert.deepEqual(sightings.map((s) => [s.homeScore, s.awayScore, s.source]), [[1, 0, "sportscore"]]);

  // Even with the market pauses lifted (a pause can end on its own), the unconfirmed goal still refuses the slip.
  await prisma.market.updateMany({ where: { eventId: match.id }, data: { livePausedUntil: null, livePausedAt: null, liveReopenFrom: null, livePauseReason: null } });
  await assert.rejects(place(match), /goal is being confirmed/);
  assert.equal(await prisma.bet.count({ where: { selection: { market: { eventId: match.id } } } }), 0);
  assert.equal(await balance(), 1000);

  // Our feed catches up: the early score is cleared and the match is ours again.
  await prisma.event.update({ where: { id: match.id }, data: { homeScore: 1 } });
  await early.run(new Date(), [{ id: "home-v-away-1", home: 1, away: 0 }]);
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: match.id } })).liveEarlyScore, null);
});

test("a SportScore goal that comes in while a live slip waits refuses it; no money moves", async () => {
  const match = await liveMatch("SportScore during the wait", "home-v-away-2");
  const placing = place(match);
  await sleep(200);
  await early.run(new Date(), [{ id: "home-v-away-2", home: 0, away: 1 }]);
  await assert.rejects(placing, /goal is being confirmed|Something happened in the match|paused while your bet/);
  assert.equal(await prisma.bet.count({ where: { selection: { market: { eventId: match.id } } } }), 0);
  assert.equal(await balance(), 1000);
});

test("a live bet placed between the real goal and API-Football's confirmation is voided at settlement, never paid", async () => {
  const match = await liveMatch("Bet in the window", "home-v-away-3");
  // The home side scores. Nothing has shown it yet, so two bets go in: one the goal helps, one it hurts.
  const helped = await prisma.bet.findUniqueOrThrow({ where: { id: (await place(match, "match_winner", "home")).bets[0].id } });
  const hurt = await prisma.bet.findUniqueOrThrow({ where: { id: (await place(match, "match_winner", "away")).bets[0].id } });
  // And one placed well before the goal, which stands.
  const earlier = await prisma.bet.findUniqueOrThrow({ where: { id: (await place(match, "goals_2_5", "over")).bets[0].id } });
  await prisma.bet.update({ where: { id: earlier.id }, data: { placedAt: new Date(helped.placedAt.getTime() - 10 * 60_000) } });
  assert.equal(helped.status, "OPEN");
  assert.equal(hurt.status, "OPEN");
  assert.equal(helped.live.home, 0, "the bet was placed on 0–0");

  const goalAt = helped.placedAt.getTime() - 3_000;
  // SportScore shows 1–0 two seconds after the first bet; API-Football has it 25 seconds after that.
  await sync.earlyGoal(match.id, { home: 1, away: 0 }, "sportscore", new Date(hurt.placedAt.getTime() + 2_000));
  await prisma.goalSeen.create({ data: { eventId: match.id, homeScore: 1, awayScore: 0, source: "odds", seenAt: new Date(hurt.placedAt.getTime() + 27_000) } });

  // The match ends 1–3: the away bet would have won, the over bet wins too.
  const first = Math.floor(match.startsAt.getTime() / 1000);
  const minuteOf = (ms) => Math.floor((ms / 1000 - first) / 60) + 1;
  await prisma.event.update({
    where: { id: match.id },
    data: {
      status: "COMPLETED",
      period: "FT",
      homeScore: 1,
      awayScore: 3,
      resultHome: 1,
      resultAway: 3,
      resultHalfHome: 1,
      resultHalfAway: 1,
      finishedAt: new Date(),
      lateCheck: {
        first,
        second: first + 60 * 60,
        goals: [
          { minute: minuteOf(goalAt), extra: null, side: "home" },
          { minute: 80, extra: null, side: "away" },
          { minute: 84, extra: null, side: "away" },
          { minute: 88, extra: null, side: "away" },
        ],
        cards: [],
      },
      lateCheckedAt: new Date(),
    },
  });
  await settlement.settleEvent(match.id);

  const voided = await prisma.bet.findMany({ where: { id: { in: [helped.id, hurt.id] } } });
  for (const bet of voided) {
    assert.equal(bet.status, "VOID", `the ${bet.id === helped.id ? "home" : "away"} bet placed after the goal is void`);
    assert.equal(bet.voidReason, "placed after a goal that hadn't shown yet");
    assert.equal(Number(bet.payout), 10, "only the stake comes back");
  }
  assert.equal((await prisma.bet.findUniqueOrThrow({ where: { id: earlier.id } })).status, "WON", "a bet from before the goal stands");
  // 1000 - 3 × 10 staked, the two stakes back, and the over bet paid at its price.
  const won = await prisma.bet.findUniqueOrThrow({ where: { id: earlier.id } });
  assert.equal(await balance(), Math.round((1000 - 30 + 20 + Number(won.payout)) * 100) / 100);
  assert.equal(Number(won.payout), Math.floor(10 * Number(won.odds) * 100) / 100);
});

test("without the feed's timeline, SportScore's sighting is when we knew of the goal", async () => {
  const match = await liveMatch("No timeline", "home-v-away-4");
  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: (await place(match, "match_winner", "away")).bets[0].id } });
  await sync.earlyGoal(match.id, { home: 1, away: 0 }, "sportscore", new Date(bet.placedAt.getTime() + 1_000));
  // Our own feed only saw it 3 minutes later: by that alone the bet would count as placed before the goal.
  await prisma.goalSeen.create({ data: { eventId: match.id, homeScore: 1, awayScore: 0, source: "odds", seenAt: new Date(bet.placedAt.getTime() + 180_000) } });
  await prisma.event.update({
    where: { id: match.id },
    // Finished over 3 hours ago: settlement has stopped waiting for the timeline and goes by the sightings.
    data: { status: "COMPLETED", period: "FT", homeScore: 1, awayScore: 2, resultHome: 1, resultAway: 2, resultHalfHome: 1, resultHalfAway: 0, finishedAt: new Date(Date.now() - 4 * 3_600_000) },
  });
  await settlement.settleEvent(match.id);
  const settled = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
  assert.equal(settled.status, "VOID");
  assert.equal(settled.voidReason, "placed after a goal that hadn't shown yet");
});

test("teardown", async () => {
  await prisma.$disconnect();
});
