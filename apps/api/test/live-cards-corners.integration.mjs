// Live cards and corners, end to end against a real Postgres: a red card the
// feed reports only after a bet was confirmed voids the bets it helped (the
// other side's), never corners; a card on a cards market voids an Over bet,
// not an Under one; a card that shows up in the feed during the wait refuses
// a cards bet; and a live corners bet waits longer than others and is capped
// for each match. Like the other integration tests it empties tables, so it
// only runs against a database whose name ends in "_test".
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
// Short waits: 300 ms usually, 1.5 s with a corners pick; at most 150 ALL on one match's live corners. Read when the code loads.
process.env.LIVE_BET_DELAY_MS = "300";
process.env.LIVE_BET_EVENTFUL_DELAY_MS = "600";
process.env.LIVE_CORNERS_DELAY_MS = "1500";
process.env.LIVE_CORNERS_MAX_STAKE = "150";
process.env.LIVE_BET_ADAPTIVE_DELAY = "off";
process.env.LIVE_VERIFY = "off";

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

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const sync = new OddsSyncService(prisma);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit, sync);
const odds = new OddsService(prisma, audit, sync);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, new RiskService(prisma, audit), sync);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_cc${n}`, username: `cc${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hcc${n}`, role, parentId, ...extra } });
}

/** A football match 30 minutes in, 0–0, one yellow card shown, with match result, cards and corners markets. */
async function liveMatch(name) {
  return prisma.event.create({
    data: {
      sport: "football",
      provider: "api-football",
      externalId: `cc-${name}`,
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
      matchCentre: { moments: [{ kind: "yellow" }] },
      markets: {
        create: [
          { key: "match_winner", name: "Match winner", selections: { create: [{ key: "home", name: "Home", feedOdds: 2, liveOdds: 2 }, { key: "draw", name: "Draw", feedOdds: 3.2, liveOdds: 3.2 }, { key: "away", name: "Away", feedOdds: 4, liveOdds: 4 }] } },
          { key: "cards_2_5", name: "Total cards 2.5", selections: { create: [{ key: "over", name: "Over 2.5", feedOdds: 2, liveOdds: 2 }, { key: "under", name: "Under 2.5", feedOdds: 1.8, liveOdds: 1.8 }] } },
          { key: "corners_9_5", name: "Total corners 9.5", selections: { create: [{ key: "over", name: "Over 9.5", feedOdds: 2, liveOdds: 2 }, { key: "under", name: "Under 9.5", feedOdds: 1.8, liveOdds: 1.8 }] } },
        ],
      },
    },
    include: { markets: { include: { selections: true } } },
  });
}
const sel = (event, market, key) => event.markets.find((m) => m.key === market).selections.find((s) => s.key === key);

let player, actor;
async function place(selection, stake = 50) {
  const price = (await odds.priceForPlayer(player.id, selection.id)).odds;
  return (await bets.place(actor, { bets: [{ selectionId: selection.id, stake, odds: price }] })).bets[0];
}
const reload = (id) => prisma.bet.findUniqueOrThrow({ where: { id } });

/** The match ends 0–0 with the feed's timeline: the first-half kick-off and these cards (minutes counted like the feed's). */
async function finish(match, cards) {
  await prisma.event.update({
    where: { id: match.id },
    data: {
      status: "COMPLETED",
      period: "FT",
      resultHome: 0,
      resultAway: 0,
      resultHalfHome: 0,
      resultHalfAway: 0,
      resultCardsHome: cards.filter((c) => c.side === "home").length,
      resultCardsAway: cards.filter((c) => c.side === "away").length,
      resultCornersHome: 6,
      resultCornersAway: 5,
      statsSource: "feed",
      finishedAt: new Date(),
      lateCheck: { first: Math.floor(match.startsAt.getTime() / 1000), second: null, goals: [], cards },
      lateCheckedAt: new Date(),
    },
  });
}
/** The minute (feed-style) a bet was placed in, from the match's kick-off. */
const minuteOf = (match, bet) => Math.floor((bet.placedAt.getTime() - match.startsAt.getTime()) / 60_000) + 1;

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

test("a red card the feed reports only after the bets were confirmed: the side it helped is voided, the side it hurt and corners settle", async () => {
  const match = await liveMatch("Late red");
  const home = await place(sel(match, "match_winner", "home"));
  const away = await place(sel(match, "match_winner", "away"));
  const draw = await place(sel(match, "match_winner", "draw"));
  // Corners waits longer and is capped separately; placed last.
  const corners = await place(sel(match, "corners_9_5", "over"));
  const homeRow = await reload(home.id);
  assert.equal(homeRow.live.reds, 0, "no red card showing when it was placed");
  // The away side's red card came in the minute the match-result bets were placed.
  await finish(match, [{ minute: 10, extra: null, side: "home" }, { minute: minuteOf(match, homeRow), extra: null, side: "away", red: true }]);
  await settlement.settleEvent(match.id);
  const voided = await reload(home.id);
  assert.equal(voided.status, "VOID");
  assert.equal(voided.voidReason, "placed after a red card that hadn't shown yet");
  assert.equal((await reload(away.id)).status, "LOST", "the red hurt the away side's bet: it settles");
  assert.equal((await reload(draw.id)).status, "VOID", "whether a red helps a draw can't be told: void");
  assert.equal((await reload(corners.id)).status, "WON", "corners aren't checked: it settles");
});

test("a card the feed reports only after a cards bet was confirmed voids Over, not Under", async () => {
  const match = await liveMatch("Late card");
  const over = await place(sel(match, "cards_2_5", "over"));
  const under = await place(sel(match, "cards_2_5", "under"));
  const overRow = await reload(over.id);
  assert.equal(overRow.live.cards, 1, "one card showing when it was placed");
  // A second yellow, for the away side, in the bet's minute: two cards in the end.
  await finish(match, [{ minute: 10, extra: null, side: "home" }, { minute: minuteOf(match, overRow), extra: null, side: "away" }]);
  await settlement.settleEvent(match.id);
  const voided = await reload(over.id);
  assert.equal(voided.status, "VOID");
  assert.equal(voided.voidReason, "placed after a card that hadn't shown yet");
  assert.equal((await reload(under.id)).status, "WON", "two cards, under 2.5: the card didn't help it, so it settles");
});

test("a card that shows up in the feed during the wait refuses a cards bet", async () => {
  const match = await liveMatch("Card in the wait");
  const mark = (cards) => ({ home: 0, away: 0, goals: 0, cards, reds: 0, vars: 0, missedPenalties: 0, events: cards, last: null, at: new Date().toISOString() });
  const real = { verifyLive: sync.verifyLive, readMarks: sync.readMarks };
  let call = 0;
  sync.verifyLive = async () => undefined;
  sync.readMarks = async () => new Map([[match.id, call++ === 0 ? mark(1) : mark(2)]]);
  process.env.LIVE_VERIFY = "on";
  try {
    await assert.rejects(place(sel(match, "cards_2_5", "over")), /A card was shown while your bet/);
  } finally {
    process.env.LIVE_VERIFY = "off";
    Object.assign(sync, real);
  }
});

test("a live corners bet uses the same confirmation delay, and a Player's live corners stakes on one match are capped", async () => {
  const match = await liveMatch("Corners");
  const winner = await place(sel(match, "match_winner", "home"));
  const first = await place(sel(match, "corners_9_5", "over"), 100);
  const winnerDelay = (await reload(winner.id)).live.audit.delayMs;
  assert.equal((await reload(first.id)).live.audit.delayMs, winnerDelay, "corners wait as long as the rest of the match, not a flat extra");
  // 100 of the 150 allowed is on already: another 100 is refused, 50 goes in.
  await assert.rejects(place(sel(match, "corners_9_5", "under"), 100), /limited to 150 ALL a match. You can stake 50.00 ALL more/);
  await place(sel(match, "corners_9_5", "under"), 50);
});

test("teardown", async () => {
  await prisma.$disconnect();
});
