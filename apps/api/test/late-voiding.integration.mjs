// Late live bets, end to end against a real Postgres: a goal whose real time
// is before a bet but which reaches the site only after the bet was confirmed
// voids it, whether settlement finds it at full time, the site sees the goal
// while the match is on, or the timeline comes in after the bet was paid. And
// during the wait, the feed read straight from the source (its fixture and
// timeline) refuses a slip when something happened that our saved prices
// don't have yet, or when prices haven't caught up with a goal.
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
// Short waits, so the test is quick: 600 ms usually, 1.2 s on a busy match. No calls to the real feed.
process.env.LIVE_BET_DELAY_MS = "600";
process.env.LIVE_BET_EVENTFUL_DELAY_MS = "1200";
process.env.LIVE_BET_ADAPTIVE_DELAY = "off";
process.env.LIVE_VERIFY = "off";

const prisma = new PrismaClient();
const sent = [];
const notifications = { create: async (n) => (sent.push(n), n) };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const sync = new OddsSyncService(prisma);
// Given the sync, settlement hears about new goals and late timelines from it, as in the app.
const settlement = new SettlementService(prisma, realtime, notifications, users, audit, sync);
const odds = new OddsService(prisma, audit, sync);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, new RiskService(prisma, audit), sync);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_lv${n}`, username: `lv${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hlv${n}`, role, parentId, ...extra } });
}

/** A football match 30 minutes in, 0–0, its prices fresh. */
async function liveMatch(name, extra = {}) {
  return prisma.event.create({
    data: {
      sport: "football",
      provider: "api-football",
      externalId: `lv-${name}`,
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
        create: [{ key: "match_winner", name: "Match winner", selections: { create: [{ key: "home", name: "Home", feedOdds: 2, liveOdds: 2 }, { key: "away", name: "Away", feedOdds: 4, liveOdds: 4 }] } }],
      },
      ...extra,
    },
    include: { markets: { include: { selections: true } } },
  });
}
const homeOf = (event) => event.markets[0].selections.find((s) => s.key === "home");

let player, actor, admin;
async function place(event, stake = 100) {
  const home = homeOf(event);
  const price = (await odds.priceForPlayer(player.id, home.id)).odds;
  return bets.place(actor, { bets: [{ selectionId: home.id, stake, odds: price }] });
}
const balance = async () => Number((await prisma.user.findUniqueOrThrow({ where: { id: player.id } })).balance);
const reload = (id) => prisma.bet.findUniqueOrThrow({ where: { id } });

/** The match ends 1–0 (the home goal in `minute`), with the feed's timeline in; `first` is the first half's kick-off, or null when the feed sent none. */
async function finish(match, minute, { first = Math.floor(match.startsAt.getTime() / 1000), finishedAt = new Date(), timeline = true } = {}) {
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
      finishedAt,
      ...(timeline ? { lateCheck: { first, second: null, goals: [{ minute, extra: null, side: "home" }], cards: [] }, lateCheckedAt: new Date() } : {}),
    },
  });
}

/** The feed's record of a match (FeedMark), as readMarks returns it. */
const mark = (extra = {}) => ({ home: 0, away: 0, goals: 0, cards: 0, reds: 0, vars: 0, missedPenalties: 0, events: 0, last: null, at: new Date().toISOString(), ...extra });
/** Checks with the feed on, answered by `reads` in turn (the read when the slip comes in, then the one at the end of the wait). */
async function withFeed(eventId, reads, work) {
  const real = { verifyLive: sync.verifyLive, readMarks: sync.readMarks };
  let call = 0;
  sync.verifyLive = async () => undefined;
  sync.readMarks = async () => new Map([[eventId, reads[Math.min(call++, reads.length - 1)]]]);
  process.env.LIVE_VERIFY = "on";
  try {
    return await work();
  } finally {
    process.env.LIVE_VERIFY = "off";
    Object.assign(sync, real);
  }
}

test("setup", async () => {
  for (const table of ["goals_seen", "settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  admin = await user("SUPER_ADMIN", null);
  const owner = await user("OWNER", admin.id, { commissionRate: 10, balance: 100000 });
  const manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 10000 });
  player = await user("PLAYER", manager.id, { balance: 10000 });
  actor = { id: player.id, role: "PLAYER", parentId: player.parentId };
});

test("a goal whose real time is before the bet but which reaches the site after it was confirmed: settlement voids the bet, and says why", async () => {
  const match = await liveMatch("Goal before, seen after");
  const placed = await place(match);
  const bet = await reload(placed.bets[0].id);
  assert.equal(bet.status, "OPEN");
  assert.equal(bet.live.home, 0, "confirmed on 0–0: the site hadn't seen the goal");
  // The site saw 1–0 twenty seconds after the bet was confirmed. The feed's timeline puts the goal in the 31st
  // minute (the bet's, by the site's 30' and the kick-off) and, like some leagues', has no kick-off times.
  await prisma.goalSeen.create({ data: { eventId: match.id, homeScore: 1, awayScore: 0, elapsed: 31, source: "odds", seenAt: new Date(bet.placedAt.getTime() + 20_000) } });
  await finish(match, 31, { first: null });
  await settlement.settleEvent(match.id);
  const settled = await reload(bet.id);
  assert.equal(settled.status, "VOID");
  assert.equal(settled.voidReason, "placed after a goal that hadn't shown yet");
  assert.equal(Number(settled.payout), 100, "the stake came back");
  // The decision is kept with the bet and in the audit log.
  assert.equal(settled.live.late.late, true);
  assert.equal(settled.live.late.when, "settlement");
  assert.match(settled.live.late.detail, /goal 1–0 at 31'/);
  const logged = await prisma.auditLog.findFirst({ where: { action: "bet.void_late", targetId: player.id }, orderBy: { createdAt: "desc" } });
  assert.equal(logged.metadata.betId, bet.id);
});

test("a goal the site sees while the match is on voids the open live bets placed after it straight away; a bet from minutes before stands", async () => {
  const match = await liveMatch("Voided on arrival");
  const placed = await place(match);
  const late = await reload(placed.bets[0].id);
  const team = { ownerId: late.ownerId, managerId: late.managerId, ownerRate: late.ownerRate, managerRate: late.managerRate };
  // A bet from five minutes earlier, on the same 0–0.
  const early = await prisma.bet.create({
    data: { playerId: player.id, selectionId: homeOf(match).id, stake: 50, odds: 2, description: "early", placedAt: new Date(Date.now() - 5 * 60_000), live: { home: 0, away: 0, minute: 25, cards: 0, reds: 0 }, ...team },
  });
  const before = await balance();
  // The live prices bring the goal: the sync notes it, and settlement hears at once.
  await sync["noteGoal"](match.id, { homeScore: 0, awayScore: 0 }, { homeScore: 1, awayScore: 0 }, 31, "odds");
  for (let i = 0; i < 50 && (await reload(late.id)).status === "OPEN"; i++) await sleep(20);
  const voided = await reload(late.id);
  assert.equal(voided.status, "VOID");
  assert.equal(voided.live.late.when, "arrival");
  assert.equal(await balance(), before + 100, "the stake came back now, not at full time");
  assert.ok(sent.some((note) => note.title === "Bet voided" && /placed after a goal/.test(note.message)));
  assert.equal((await reload(early.id)).status, "OPEN");
});

test("a winning live bet paid before the check could see its goal is voided when the timeline comes in, and the winnings are taken back", async () => {
  const match = await liveMatch("Paid, then voided");
  const placed = await place(match);
  const bet = await reload(placed.bets[0].id);
  // Full time hours ago, no timeline and no goal seen live (the feed never sent the score in time): it settled as a win.
  await finish(match, 31, { timeline: false, finishedAt: new Date(Date.now() - 4 * 3_600_000) });
  await settlement.settleEvent(match.id);
  assert.equal((await reload(bet.id)).status, "WON");
  const afterWin = await balance();
  // Then the timeline comes in: the goal was in the bet's minute.
  await prisma.event.update({ where: { id: match.id }, data: { lateCheck: { first: Math.floor(match.startsAt.getTime() / 1000), second: null, goals: [{ minute: 31, extra: null, side: "home" }], cards: [] } } });
  await sync.onTimeline([match.id]);
  const voided = await reload(bet.id);
  assert.equal(voided.status, "VOID");
  assert.equal(voided.live.late.when, "recheck");
  assert.equal(Number(voided.payout), 100);
  // The win paid the stake times the price; the stake stays, what it paid over the stake goes back.
  const winnings = Math.round(100 * (Number(bet.odds) - 1) * 100) / 100;
  assert.equal(await balance(), afterWin - winnings);
  const ledger = await prisma.balanceTransaction.findFirst({ where: { betId: bet.id }, orderBy: { createdAt: "desc" } });
  assert.equal(Number(ledger.amount), -winnings);
  assert.ok(sent.some((note) => note.title === "Bet voided" && /taken back/.test(note.message)));
});

test("Super Admin's re-check by username: a dry run only says what it would do, then the real one voids", async () => {
  const match = await liveMatch("Admin re-check");
  const placed = await place(match);
  const bet = await reload(placed.bets[0].id);
  await finish(match, 31, { timeline: false, finishedAt: new Date(Date.now() - 4 * 3_600_000) });
  await settlement.settleEvent(match.id);
  assert.equal((await reload(bet.id)).status, "WON");
  await prisma.event.update({ where: { id: match.id }, data: { lateCheck: { first: Math.floor(match.startsAt.getTime() / 1000), second: null, goals: [{ minute: 31, extra: null, side: "home" }], cards: [] } } });
  const since = new Date(Date.now() - 3_600_000);
  const dry = await settlement.recheckLateFor({ id: admin.id, role: "SUPER_ADMIN" }, { player: player.username, since, dryRun: true });
  assert.equal(dry.dryRun, true);
  const row = dry.bets.find((b) => b.betId === bet.id);
  assert.equal(row.void, true);
  assert.equal(row.balanceChange, -Math.round(100 * (Number(bet.odds) - 1) * 100) / 100);
  assert.equal((await reload(bet.id)).status, "WON", "a dry run changes nothing");
  const real = await settlement.recheckLateFor({ id: admin.id, role: "SUPER_ADMIN" }, { player: player.username, since, dryRun: false });
  assert.ok(real.bets.some((b) => b.betId === bet.id && b.void));
  assert.equal((await reload(bet.id)).status, "VOID");
  assert.ok(await prisma.auditLog.findFirst({ where: { action: "bet.recheck_late", actorId: admin.id } }));
  // Run again, nothing's left to void.
  const again = await settlement.recheckLateFor({ id: admin.id, role: "SUPER_ADMIN" }, { player: player.username, since, dryRun: false });
  assert.equal(again.voided, 0);
});

test("a goal in the feed's fixture during the wait, before its prices have it: the slip is refused, no money moves", async () => {
  const match = await liveMatch("Goal in the fixture");
  const before = await balance();
  await assert.rejects(withFeed(match.id, [mark(), mark({ home: 1, goals: 1, events: 1, last: "goal home 31'" })], () => place(match)), /score changed while your bet/);
  assert.equal(await prisma.bet.count({ where: { selectionId: homeOf(match).id } }), 0);
  assert.equal(await balance(), before);
});

test("a VAR check or a red card in the feed's timeline during the wait refuses the slip too", async () => {
  const match = await liveMatch("VAR in the feed");
  await assert.rejects(withFeed(match.id, [mark(), mark({ vars: 1, events: 1 })], () => place(match)), /VAR check while your bet/);
  await assert.rejects(withFeed(match.id, [mark(), mark({ cards: 1, reds: 1, events: 1 })], () => place(match)), /red card was shown while your bet/);
});

test("nothing new in the feed: the bet goes in, and keeps both readings of the feed, the score from each source and how long the checks took", async () => {
  const match = await liveMatch("Quiet feed");
  const reading = mark({ cards: 1, events: 1, last: "card away 12'" });
  const placed = await withFeed(match.id, [reading, reading], () => place(match));
  const { live } = await reload(placed.bets[0].id);
  assert.equal(live.audit.markAtSubmit.last, "card away 12'");
  assert.equal(live.audit.markAtConfirm.events, 1);
  assert.equal(live.audit.scoreFromOdds, "0:0");
  assert.equal(live.audit.scoreFromFixture, "0:0");
  assert.equal(typeof live.audit.checkMs, "number");
});

test("prices that haven't caught up with a goal (the side that scored no shorter than before it) refuse the slip", async () => {
  // Home scored a minute ago at 2.00; the feed still has 2.00 on them.
  const match = await liveMatch("Prices behind the goal", { homeScore: 1 });
  await prisma.goalSeen.create({ data: { eventId: match.id, homeScore: 1, awayScore: 0, elapsed: 29, source: "odds", seenAt: new Date(Date.now() - 60_000), beforeGoal: { side: "home", home: 2, draw: 3.2, away: 4 } } });
  await assert.rejects(place(match), /haven't caught up with the last goal/);
  // Once the price has shortened, the bet goes in.
  await prisma.selection.update({ where: { id: homeOf(match).id }, data: { liveOdds: 1.4 } });
  const placed = await place(match);
  assert.equal(placed.bets.length, 1);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
