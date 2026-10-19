// Late live bets end to end against a real Postgres (bets/late.ts): live bets
// on a finished match wait for its timeline, then the ones placed after a
// goal (or, on a cards market, a card) the site hadn't shown are void, stake
// back, in singles and in accumulator legs alike; the rest settle as usual.
// And the feed's delay on goals, measured from when the site first saw them,
// and the cap on a Player's live corners bets on a match.
// Like the other integration tests it empties tables, so it only runs against
// a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Read when bets/late.ts loads: live corners bets confirm at once here too, under a 100 ALL cap.
process.env.LIVE_CORNERS_DELAY_MS = "0";
process.env.LIVE_CORNERS_MAX_STAKE = "100";
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { SettlementService } = require("../dist/bets/settlement.service.js");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { teamOf } = require("../dist/bets/team.js");
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
// Live bets confirm at once here, without asking the feed.
process.env.LIVE_BET_DELAY_MS = "0";
process.env.LIVE_VERIFY = "off";

// The first half kicked off at 18:00 UTC yesterday, the second at 19:00. The home side scored in the 22nd minute.
const day = new Date();
day.setUTCDate(day.getUTCDate() - 1);
const FIRST = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 18, 0, 0) / 1000;
const SECOND = FIRST + 3_600;
const at = (minutes, seconds = 0) => new Date((FIRST + minutes * 60 + seconds) * 1000);
const TIMELINE = { first: FIRST, second: SECOND, goals: [{ minute: 22, extra: null, side: "home" }], cards: [{ minute: 10, extra: null, side: "away" }, { minute: 30, extra: null, side: "home" }] };

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_lb${n}`, username: `lb${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hlb${n}`, role, parentId, ...extra } });
}
const reload = (b) => prisma.bet.findUniqueOrThrow({ where: { id: b.id }, include: { legs: { orderBy: { sortOrder: "asc" } } } });

/** A finished match, 1–0, with a match result market and a cards line. */
async function finishedMatch(name, extra = {}) {
  return prisma.event.create({
    data: {
      sport: "football",
      provider: "api-football",
      externalId: `late-${name}`,
      name,
      league: "League",
      homeTeam: "Home",
      awayTeam: "Away",
      startsAt: new Date(FIRST * 1000),
      status: "COMPLETED",
      period: "FT",
      homeScore: 1,
      awayScore: 0,
      resultHome: 1,
      resultAway: 0,
      resultHalfHome: 1,
      resultHalfAway: 0,
      resultCardsHome: 1,
      resultCardsAway: 1,
      resultCornersHome: 5,
      resultCornersAway: 4,
      finishedAt: new Date(),
      markets: {
        create: [
          { key: "match_winner", name: "Match winner", selections: { create: [{ key: "home", name: "Home", feedOdds: 2 }, { key: "draw", name: "Draw", feedOdds: 3 }, { key: "away", name: "Away", feedOdds: 4 }] } },
          { key: "cards_1_5", name: "Total cards 1.5", selections: { create: [{ key: "over", name: "Over 1.5", feedOdds: 2 }, { key: "under", name: "Under 1.5", feedOdds: 1.8 }] } },
        ],
      },
      ...extra,
    },
    include: { markets: { include: { selections: true } } },
  });
}
const pick = (event, market, key) => event.markets.find((m) => m.key === market).selections.find((s) => s.key === key);

let player, match, other;
let lateSingle, earlySingle, preMatch, lateCards, fineCards, acca;

test("setup", async () => {
  for (const table of ["goals_seen", "settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  const sa = await user("SUPER_ADMIN", null);
  const owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 10000 });
  const manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 1000 });
  player = await user("PLAYER", manager.id, { balance: 0 });
  match = await finishedMatch("Home v Away");
  other = await finishedMatch("Second v Match");
  const team = await teamOf(prisma, player.id);
  const single = (selection, placedAt, live, odds = 2) =>
    prisma.bet.create({ data: { playerId: player.id, selectionId: selection.id, stake: 100, odds, description: selection.name, placedAt, ...(live ? { live } : {}), ...team } });
  // In the 23rd minute with the site still showing 0–0: after the goal.
  lateSingle = await single(pick(match, "match_winner", "home"), at(22, 30), { home: 0, away: 0, minute: 21, cards: 1 });
  // In the 16th minute, before it.
  earlySingle = await single(pick(match, "match_winner", "home"), at(15, 10), { home: 0, away: 0, minute: 15, cards: 1 });
  preMatch = await single(pick(match, "match_winner", "home"), new Date((FIRST - 3_600) * 1000), null);
  // Cards: one shown so far, the second came in the 30th minute. One bet after it, one before.
  lateCards = await single(pick(match, "cards_1_5", "over"), at(31, 0), { home: 1, away: 0, minute: 30, cards: 1 });
  fineCards = await single(pick(match, "cards_1_5", "over"), at(25, 0), { home: 1, away: 0, minute: 25, cards: 1 });
  // An accumulator: a late live leg on this match, and a pre-match leg on the other.
  acca = await prisma.bet.create({
    data: {
      playerId: player.id,
      kind: "ACCUMULATOR",
      stake: 100,
      odds: 4,
      description: "Accumulator · 2 picks",
      placedAt: at(23, 0),
      ...team,
      legs: {
        create: [
          { selectionId: pick(match, "match_winner", "home").id, odds: 2, description: "Home", sortOrder: 0, live: { home: 0, away: 0, minute: 22, cards: 1 } },
          { selectionId: pick(other, "match_winner", "home").id, odds: 2, description: "Second", sortOrder: 1 },
        ],
      },
    },
  });
});

test("live bets wait for the match's timeline; a bet placed before kick-off settles straight away", async () => {
  await settlement.settleEvent(match.id);
  await settlement.settleEvent(other.id);
  assert.equal((await reload(preMatch)).status, "WON");
  for (const bet of [lateSingle, earlySingle, lateCards, fineCards]) assert.equal((await reload(bet)).status, "OPEN");
  const waiting = await reload(acca);
  assert.equal(waiting.status, "OPEN");
  assert.equal(waiting.legs[0].result, null);
  assert.equal(waiting.legs[1].result, "WON");
});

test("with the timeline in, a bet placed after a goal the site hadn't shown is void, stake back; the others settle as usual", async () => {
  await prisma.event.update({ where: { id: match.id }, data: { lateCheck: TIMELINE, lateCheckedAt: new Date() } });
  sent.length = 0;
  await settlement.settleEvent(match.id);

  const late = await reload(lateSingle);
  assert.equal(late.status, "VOID");
  assert.equal(Number(late.payout), 100);
  assert.equal(late.voidReason, "placed after a goal that hadn't shown yet");
  assert.equal((await reload(earlySingle)).status, "WON");

  // Cards: the one placed after the second card is void; the one before it won (2 cards, over 1.5).
  const cards = await reload(lateCards);
  assert.equal(cards.status, "VOID");
  assert.equal(cards.voidReason, "placed after a card that hadn't shown yet");
  assert.equal((await reload(fineCards)).status, "WON");

  // The accumulator's late leg is void, so it pays on the other leg alone.
  const settled = await reload(acca);
  assert.equal(settled.legs[0].result, "VOID");
  assert.equal(settled.legs[0].voidReason, "placed after a goal that hadn't shown yet");
  assert.equal(settled.status, "WON");
  assert.equal(Number(settled.payout), 200);

  // The Player is told the late bets were voided, and why.
  const voided = sent.filter((note) => note.title === "Bet voided");
  assert.equal(voided.length, 1);
  assert.match(voided[0].message, /voided \(placed after a/);

  // The refund is in the Player's balance: stake back on the two void singles, winnings on the rest.
  const balance = Number((await prisma.user.findUniqueOrThrow({ where: { id: player.id } })).balance);
  assert.equal(balance, 100 + 100 + 200 + 200 + 200 + 200);
});

test("a late bet stays void when the result is corrected", async () => {
  await settlement.settleEvent(match.id, true);
  assert.equal((await reload(lateSingle)).status, "VOID");
});

test("without a timeline after LATE_CHECK_WAIT_MS, live bets settle without the check", async () => {
  const stale = await finishedMatch("No v Timeline", { finishedAt: new Date(Date.now() - 4 * 3_600_000) });
  const team = await teamOf(prisma, player.id);
  const bet = await prisma.bet.create({
    data: { playerId: player.id, selectionId: pick(stale, "match_winner", "home").id, stake: 50, odds: 2, description: "Home", placedAt: at(22, 30), live: { home: 0, away: 0, minute: 21, cards: 1 }, ...team },
  });
  await settlement.settleEvent(stale.id);
  assert.equal((await reload(bet)).status, "WON");
});

test("the feed's delay: when the site first saw each goal, against the timeline", async () => {
  // The 22nd-minute goal (21:30 in, in the middle of its minute) seen 25 seconds later.
  await prisma.goalSeen.create({ data: { eventId: match.id, homeScore: 1, awayScore: 0, elapsed: 22, source: "odds", seenAt: new Date((FIRST + 21.5 * 60 + 25) * 1000) } });
  const delay = await odds.feedDelay(7);
  assert.equal(delay.goals, 1);
  assert.equal(delay.average, 25);
  assert.equal(delay.recent[0].eventName, "Home v Away");
  assert.equal(delay.recent[0].minute, "22");
});

test("placing a live bet records the score, the minute and the cards the site showed; a pre-match pick records nothing", async () => {
  await prisma.user.update({ where: { id: player.id }, data: { balance: 1000 } });
  const live = await prisma.event.create({
    data: {
      sport: "football",
      provider: "api-football",
      externalId: "late-live",
      name: "Live v Now",
      league: "League",
      homeTeam: "Live",
      awayTeam: "Now",
      startsAt: new Date(Date.now() - 40 * 60_000),
      status: "LIVE",
      period: "1H",
      elapsed: 34,
      homeScore: 1,
      awayScore: 0,
      liveOddsAt: new Date(),
      matchCentre: { moments: [{ kind: "goal" }, { kind: "yellow" }, { kind: "sub" }, { kind: "red" }] },
      markets: { create: [{ key: "match_winner", name: "Match winner", selections: { create: [{ key: "home", name: "Live", feedOdds: 1.5, liveOdds: 1.5 }, { key: "away", name: "Now", feedOdds: 5, liveOdds: 5 }] } }] },
    },
    include: { markets: { include: { selections: true } } },
  });
  const later = await prisma.event.create({
    data: {
      sport: "football",
      provider: "api-football",
      externalId: "late-later",
      name: "Later v Today",
      league: "League",
      homeTeam: "Later",
      awayTeam: "Today",
      startsAt: new Date(Date.now() + 2 * 3_600_000),
      status: "UPCOMING",
      markets: { create: [{ key: "match_winner", name: "Match winner", selections: { create: [{ key: "home", name: "Later", feedOdds: 2, liveOdds: null }] } }] },
    },
    include: { markets: { include: { selections: true } } },
  });
  const home = pick(live, "match_winner", "home");
  const preMatchPick = pick(later, "match_winner", "home");
  const quote = async (selection) => (await odds.priceForPlayer(player.id, selection.id)).odds;
  const actor = { id: player.id, role: "PLAYER", parentId: player.parentId };
  const placed = await bets.place(actor, {
    bets: [{ selectionId: home.id, stake: 10, odds: await quote(home) }],
    accumulator: { legs: [{ selectionId: home.id, odds: await quote(home) }, { selectionId: preMatchPick.id, odds: await quote(preMatchPick) }], stake: 10 },
  });
  const single = await reload(placed.bets.find((bet) => bet.kind === "SINGLE"));
  assert.deepEqual(single.live, { home: 1, away: 0, minute: 34, cards: 2 });
  const combined = await reload(placed.bets.find((bet) => bet.kind === "ACCUMULATOR"));
  const legOf = (selection) => combined.legs.find((leg) => leg.selectionId === selection.id);
  assert.deepEqual(legOf(home).live, { home: 1, away: 0, minute: 34, cards: 2 });
  assert.equal(legOf(preMatchPick).live, null);
});

test("a Player's open live corners bets on a match are capped, accumulators at their whole stake; pre-match corners aren't", async () => {
  await prisma.user.update({ where: { id: player.id }, data: { balance: 1000 } });
  const corners = (name, externalId, live) =>
    prisma.event.create({
      data: {
        sport: "football",
        provider: "api-football",
        externalId,
        name,
        league: "League",
        homeTeam: name.split(" v ")[0],
        awayTeam: name.split(" v ")[1],
        startsAt: new Date(Date.now() + (live ? -30 : 120) * 60_000),
        status: live ? "LIVE" : "UPCOMING",
        ...(live ? { period: "1H", elapsed: 30, homeScore: 0, awayScore: 0, liveOddsAt: new Date() } : {}),
        markets: {
          create: [
            { key: "corners_9_5", name: "Total corners 9.5", selections: { create: [{ key: "over", name: "Over 9.5", feedOdds: 1.9, liveOdds: live ? 1.9 : null }, { key: "under", name: "Under 9.5", feedOdds: 1.9, liveOdds: live ? 1.9 : null }] } },
            { key: "match_winner", name: "Match winner", selections: { create: [{ key: "home", name: "Home", feedOdds: 2, liveOdds: live ? 2 : null }] } },
          ],
        },
      },
      include: { markets: { include: { selections: true } } },
    });
  const live = await corners("Corner v Kings", "late-corners", true);
  const upcoming = await corners("Later v Corners", "late-corners-later", false);
  const actor = { id: player.id, role: "PLAYER", parentId: player.parentId };
  const quote = async (selection) => (await odds.priceForPlayer(player.id, selection.id)).odds;
  const over = pick(live, "corners_9_5", "over");
  const under = pick(live, "corners_9_5", "under");
  await bets.place(actor, { bets: [{ selectionId: over.id, stake: 60, odds: await quote(over) }] });
  // 60 on already: 50 more goes over the 100 cap.
  await assert.rejects(
    bets.place(actor, { bets: [{ selectionId: under.id, stake: 50, odds: await quote(under) }] }),
    (error) => error.message === "Live bets on corners are limited to 100 ALL a match. You can stake 40.00 ALL more on Corner v Kings.",
  );
  // An accumulator with a live corners leg counts at its whole stake.
  const laterHome = pick(upcoming, "match_winner", "home");
  await assert.rejects(bets.place(actor, { accumulator: { legs: [{ selectionId: under.id, odds: await quote(under) }, { selectionId: laterHome.id, odds: await quote(laterHome) }], stake: 45 } }), /limited to 100 ALL/);
  await bets.place(actor, { bets: [{ selectionId: under.id, stake: 40, odds: await quote(under) }] });
  // Other markets on the match, and corners before kick-off, aren't capped.
  const home = pick(live, "match_winner", "home");
  const laterOver = pick(upcoming, "corners_9_5", "over");
  await bets.place(actor, { bets: [{ selectionId: home.id, stake: 200, odds: await quote(home) }, { selectionId: laterOver.id, stake: 200, odds: await quote(laterOver) }] });
});

test("teardown", async () => {
  await prisma.$disconnect();
});
