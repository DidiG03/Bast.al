// Live bets around a goal or a red card, end to end against a real Postgres
// (bets.service confirmLive, bets/late.ts). A live bet waits before it's
// accepted. Something that reaches the site during that wait refuses the slip;
// something the feed only reports after the wait (it's often some seconds
// behind the ground) doesn't stop the bet, but settlement voids it from the
// match's timeline. The wait is longer on a busy match, and every live bet
// keeps a record of how it was confirmed.
// Like the other integration tests it empties tables, so it only runs against
// a database whose name ends in "_test".
import assert from "node:assert/strict";
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
// Short waits, so the test is quick: 600 ms usually, 1.2 s on a busy match. No calls to the feed.
process.env.LIVE_BET_DELAY_MS = "600";
process.env.LIVE_BET_EVENTFUL_DELAY_MS = "1200";
process.env.LIVE_VERIFY = "off";

const prisma = new PrismaClient();
const sent = [];
const notifications = { create: async (n) => (sent.push(n), n) };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
const sync = new OddsSyncService(prisma);
const odds = new OddsService(prisma, audit, sync);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, new RiskService(prisma, audit), sync);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_lc${n}`, username: `lc${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hlc${n}`, role, parentId, ...extra } });
}

/** A football match 30 minutes in, 0–0, a yellow card shown, its prices fresh. */
async function liveMatch(name, extra = {}) {
  const kickOff = new Date(Date.now() - 30 * 60_000);
  return prisma.event.create({
    data: {
      sport: "football",
      provider: "api-football",
      externalId: `lc-${name}`,
      name,
      league: "League",
      homeTeam: "Home",
      awayTeam: "Away",
      startsAt: kickOff,
      status: "LIVE",
      period: "1H",
      elapsed: 30,
      homeScore: 0,
      awayScore: 0,
      liveOddsAt: new Date(),
      matchCentre: { moments: [{ kind: "yellow" }] },
      markets: {
        create: [{ key: "match_winner", name: "Match winner", selections: { create: [{ key: "home", name: "Home", feedOdds: 2, liveOdds: 2 }, { key: "away", name: "Away", feedOdds: 4, liveOdds: 4 }] } }],
      },
      ...extra,
    },
    include: { markets: { include: { selections: true } } },
  });
}
const homeOf = (event) => event.markets[0].selections.find((s) => s.key === "home");

let player, actor;
async function place(event) {
  const home = homeOf(event);
  const price = (await odds.priceForPlayer(player.id, home.id)).odds;
  return bets.place(actor, { bets: [{ selectionId: home.id, stake: 10, odds: price }] });
}
/** Places a bet on the home side and, `afterMs` into the wait, changes the match as `change` says. */
async function placeWhile(event, afterMs, change) {
  const placing = place(event);
  await sleep(afterMs);
  await prisma.event.update({ where: { id: event.id }, data: change });
  return placing;
}

test("setup", async () => {
  for (const table of ["goals_seen", "settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  const sa = await user("SUPER_ADMIN", null);
  const owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  const manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 1000 });
  player = await user("PLAYER", manager.id, { balance: 1000 });
  actor = { id: player.id, role: "PLAYER", parentId: player.parentId };
});

test("a goal that reaches the site during the wait refuses the bet; no money moves", async () => {
  const match = await liveMatch("Goal during the wait");
  await assert.rejects(placeWhile(match, 200, { homeScore: 1 }), /score changed while your bet/);
  assert.equal(await prisma.bet.count({ where: { selectionId: homeOf(match).id } }), 0);
  assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: player.id } })).balance), 1000);
});

test("a red card that reaches the site during the wait refuses the bet too", async () => {
  const match = await liveMatch("Red during the wait");
  await assert.rejects(placeWhile(match, 200, { matchCentre: { moments: [{ kind: "yellow" }, { kind: "red" }] } }), /red card was shown while your bet/);
  assert.equal(await prisma.bet.count({ where: { selectionId: homeOf(match).id } }), 0);
});

test("a pause on the market during the wait (the goal's own pause) refuses the bet", async () => {
  const match = await liveMatch("Paused during the wait");
  const placing = place(match);
  await sleep(200);
  await prisma.market.updateMany({ where: { eventId: match.id }, data: { livePausedAt: new Date(), livePausedUntil: new Date(Date.now() + 60_000), liveReopenFrom: new Date(Date.now() + 15_000), livePauseReason: "goal" } });
  await assert.rejects(placing, /paused while your bet/);
});

test("a goal the feed reports only after the wait: the bet goes in, and settlement voids it from the timeline", async () => {
  const match = await liveMatch("Goal after the wait");
  const placed = await place(match);
  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: placed.bets[0].id } });
  assert.equal(bet.status, "OPEN");
  // The goal went in the minute the bet was placed; the feed sent it later. The match ends 1–0.
  const first = Math.floor(match.startsAt.getTime() / 1000);
  const minute = Math.floor((bet.placedAt.getTime() / 1000 - first) / 60) + 1;
  await prisma.event.update({
    where: { id: match.id },
    data: {
      status: "COMPLETED",
      period: "FT",
      homeScore: 1,
      resultHome: 1,
      resultAway: 0,
      resultHalfHome: 1,
      resultHalfAway: 0,
      finishedAt: new Date(),
      lateCheck: { first, second: null, goals: [{ minute, extra: null, side: "home" }], cards: [] },
      lateCheckedAt: new Date(),
    },
  });
  await settlement.settleEvent(match.id);
  const settled = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
  assert.equal(settled.status, "VOID");
  assert.equal(settled.voidReason, "placed after a goal that hadn't shown yet");
  assert.equal(Number(settled.payout), 10);
});

test("a red card the feed reports only after the wait: settlement voids the match-result bet", async () => {
  const match = await liveMatch("Red after the wait");
  const placed = await place(match);
  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: placed.bets[0].id } });
  assert.equal(bet.live.reds, 0, "the bet recorded that no red card was showing");
  const first = Math.floor(match.startsAt.getTime() / 1000);
  const minute = Math.floor((bet.placedAt.getTime() / 1000 - first) / 60) + 1;
  await prisma.event.update({
    where: { id: match.id },
    data: {
      status: "COMPLETED",
      period: "FT",
      resultHome: 0,
      resultAway: 0,
      resultHalfHome: 0,
      resultHalfAway: 0,
      finishedAt: new Date(),
      lateCheck: { first, second: null, goals: [], cards: [{ minute: 10, extra: null, side: "home" }, { minute, extra: null, side: "away", red: true }] },
      lateCheckedAt: new Date(),
    },
  });
  await settlement.settleEvent(match.id);
  const settled = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
  assert.equal(settled.status, "VOID");
  assert.equal(settled.voidReason, "placed after a red card that hadn't shown yet");
});

test("a goal a minute before the bet that the site was showing doesn't void it", async () => {
  const match = await liveMatch("Goal already showing", { homeScore: 1 });
  const placed = await place(match);
  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: placed.bets[0].id } });
  const first = Math.floor(match.startsAt.getTime() / 1000);
  const minute = Math.floor((bet.placedAt.getTime() / 1000 - first) / 60) + 1;
  await prisma.event.update({
    where: { id: match.id },
    data: {
      status: "COMPLETED",
      period: "FT",
      resultHome: 1,
      resultAway: 0,
      resultHalfHome: 1,
      resultHalfAway: 0,
      finishedAt: new Date(),
      lateCheck: { first, second: null, goals: [{ minute: minute - 1, extra: null, side: "home" }], cards: [] },
      lateCheckedAt: new Date(),
    },
  });
  await settlement.settleEvent(match.id);
  assert.equal((await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status, "WON");
});

test("every live bet keeps how it was confirmed: when, at what price, and how fresh the feed was", async () => {
  const match = await liveMatch("The record");
  const before = Date.now();
  const placed = await place(match);
  const { live } = await prisma.bet.findUniqueOrThrow({ where: { id: placed.bets[0].id } });
  assert.equal(live.home, 0);
  assert.equal(live.cards, 1);
  assert.equal(live.reds, 0);
  assert.equal(live.audit.delayMs, 600);
  assert.equal(live.audit.longerBecause, null);
  assert.equal(live.audit.askedOdds, live.audit.confirmedOdds);
  assert.ok(new Date(live.audit.submittedAt).getTime() >= before);
  assert.ok(new Date(live.audit.confirmedAt).getTime() - new Date(live.audit.submittedAt).getTime() >= 600, "it waited the whole delay");
  assert.ok(live.audit.feedAtSubmit && live.audit.feedAtConfirm);
});

test("a recent goal is noted and does not lengthen the confirmation wait", async () => {
  const match = await liveMatch("Busy match", { homeScore: 1 });
  await prisma.goalSeen.create({ data: { eventId: match.id, homeScore: 1, awayScore: 0, elapsed: 29, source: "odds" } });
  const started = Date.now();
  const placed = await place(match);
  assert.ok(Date.now() - started >= 600, "it waited the competition's delay");
  const { live } = await prisma.bet.findUniqueOrThrow({ where: { id: placed.bets[0].id } });
  assert.equal(live.audit.delayMs, 600);
  assert.equal(live.audit.longerBecause, "a goal in the last minutes");
});

test("teardown", async () => {
  await prisma.$disconnect();
});
