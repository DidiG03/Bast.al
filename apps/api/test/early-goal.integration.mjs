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
process.env.LIVE_UNCOVERED_DELAY_MS ??= "0";
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
  for (const table of ["early_goals", "goals_seen", "tracker_mappings", "settlement_entries", "commission_payouts", "balance_transactions", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "idempotency_keys", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
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

// SportScore as the bet API reads it for a slip: each test sets what its match endpoint answers.
const sportScore = new Map();
const fakeFetch = async (url) => {
  const slug = new URL(url).searchParams.get("slug");
  const score = slug ? sportScore.get(slug) : null;
  if (!score) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  const value = typeof score === "function" ? score() : score;
  return new Response(JSON.stringify({ sport: "football", match: { home_score: String(value[0]), away_score: String(value[1]), url: `/football/match/${slug}/x1/` } }), { status: 200 });
};
const checking = new EarlyGoalService(prisma, sync, fakeFetch);
const betsChecked = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, new RiskService(prisma, audit), sync, checking);
async function placeChecked(event, market = "match_winner", key = "home") {
  const selection = pick(event, market, key);
  const price = (await odds.priceForPlayer(player.id, selection.id)).odds;
  return betsChecked.place(actor, { bets: [{ selectionId: selection.id, stake: 10, odds: price }] });
}

test("a click in the gap: SportScore has the goal, no timed read has happened, the board isn't paused; the bet API reads SportScore itself and refuses", async () => {
  const match = await liveMatch("Click in the gap", "gap-1");
  sportScore.set("gap-1", [1, 0]);
  const start = await balance();
  // Nothing has paused the match yet: the price is open, as it was on the Player's screen.
  assert.equal((await odds.priceForPlayer(player.id, pick(match, "match_winner", "home").id)).bettable, true);
  await assert.rejects(placeChecked(match), /goal is being confirmed/);
  assert.equal(await prisma.bet.count({ where: { selection: { market: { eventId: match.id } } } }), 0);
  assert.equal(await balance(), start, "no money moved");
  // The read paused the match for everyone, there and then.
  const after = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
  assert.equal(after.liveEarlyScore, "1:0");
  for (const market of await prisma.market.findMany({ where: { eventId: match.id } })) assert.equal(market.livePauseReason, "ahead");
});

test("SportScore shows the goal while the slip waits: the check at the end of the wait refuses it", async () => {
  const match = await liveMatch("Goal in the wait, read for the slip", "gap-2");
  let reads = 0;
  sportScore.set("gap-2", () => (++reads === 1 ? [0, 0] : [0, 1]));
  const start = await balance();
  await assert.rejects(placeChecked(match), /goal is being confirmed|Something happened in the match|paused while your bet/);
  assert.ok(reads >= 2, "SportScore was read at submission and again after the wait");
  assert.equal(await prisma.bet.count({ where: { selection: { market: { eventId: match.id } } } }), 0);
  assert.equal(await balance(), start, "no money moved");
});

test("with SportScore agreeing, a live slip goes in", async () => {
  const match = await liveMatch("Agreeing", "gap-3");
  sportScore.set("gap-3", [0, 0]);
  const placed = await placeChecked(match);
  assert.equal(placed.bets.length, 1);
  assert.equal((await prisma.bet.findUniqueOrThrow({ where: { id: placed.bets[0].id } })).status, "OPEN");
});

test("a goal taken back: SportScore shows 3–0 while our feed still has 3–1; every market pauses, slips are refused, and it ends when our feed agrees", async () => {
  const match = await liveMatch("Disallowed", "var-1");
  await prisma.event.update({ where: { id: match.id }, data: { homeScore: 3, awayScore: 1 } });
  const before = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
  await early.run(new Date(), [{ id: "var-1", home: 3, away: 0 }]);
  const after = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
  assert.equal(after.liveEarlyScore, "3:0");
  assert.equal(after.liveVersion, before.liveVersion + 1);
  for (const market of await prisma.market.findMany({ where: { eventId: match.id } })) assert.equal(market.livePauseReason, "ahead", `${market.key} paused`);
  // Even with the pauses lifted, the slip is refused while our feed still counts the goal.
  await prisma.market.updateMany({ where: { eventId: match.id }, data: { livePausedUntil: null, livePausedAt: null, liveReopenFrom: null, livePauseReason: null } });
  sportScore.set("var-1", [3, 0]);
  await assert.rejects(placeChecked(match), /goal is being confirmed/);
  // Our feed takes the goal back too: the match is ours again.
  await prisma.event.update({ where: { id: match.id }, data: { awayScore: 0 } });
  await early.run(new Date(), [{ id: "var-1", home: 3, away: 0 }]);
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: match.id } })).liveEarlyScore, null);
});

test("bets placed at prices that counted a goal later disallowed are void at settlement; one placed on the right score is paid", async () => {
  const match = await liveMatch("Placed on a disallowed goal", "var-2");
  const home = pick(match, "match_winner", "home");
  const over = pick(match, "goals_2_5", "over");
  const team = await prisma.user.findUniqueOrThrow({ where: { id: player.id }, select: { parentId: true } });
  const manager = await prisma.user.findUniqueOrThrow({ where: { id: team.parentId } });
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: manager.parentId } });
  const placedAt = new Date(Date.now() - 5 * 60_000);
  const bet = (selection, state, odds) =>
    prisma.bet.create({ data: { playerId: player.id, selectionId: selection.id, stake: 10, odds, description: "live", placedAt, live: state, ownerId: owner.id, managerId: manager.id, ownerRate: 10, managerRate: 20 } });
  // Placed while our board showed 3–1: the away goal was then disallowed.
  const onWrong = await bet(home, { home: 3, away: 1, minute: 70, cards: 0, reds: 0 }, 1.5);
  const overOnWrong = await bet(over, { home: 3, away: 1, minute: 70, cards: 0, reds: 0 }, 1.01);
  // Placed once it showed 3–0.
  const onRight = await bet(home, { home: 3, away: 0, minute: 72, cards: 0, reds: 0 }, 1.2);
  await prisma.event.update({
    where: { id: match.id },
    data: { status: "COMPLETED", period: "FT", homeScore: 3, awayScore: 0, resultHome: 3, resultAway: 0, resultHalfHome: 2, resultHalfAway: 0, finishedAt: new Date(Date.now() - 4 * 3_600_000) },
  });
  await settlement.settleEvent(match.id);
  for (const id of [onWrong.id, overOnWrong.id]) {
    const settled = await prisma.bet.findUniqueOrThrow({ where: { id } });
    assert.equal(settled.status, "VOID");
    assert.equal(settled.voidReason, "placed on a goal that was later disallowed");
    assert.equal(Number(settled.payout), 10);
  }
  assert.equal((await prisma.bet.findUniqueOrThrow({ where: { id: onRight.id } })).status, "WON");
});

test("SportScore's live list empty: linked live matches are read from their match page, so an early goal still pauses the match", async () => {
  // Only this match live (each read takes a few match pages at most, the ones read longest ago first).
  await prisma.event.updateMany({ where: { status: "LIVE" }, data: { status: "COMPLETED" } });
  const match = await liveMatch("Empty live list", "home-v-away-empty");
  const calls = [];
  const reader = new EarlyGoalService(prisma, sync, async (url) => {
    calls.push(url);
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/fixtures/")) return { ok: true, json: async () => ({ count: 0, matches: [] }) };
    const slug = searchParams.get("slug");
    if (slug === "home-v-away-empty") return { ok: true, json: async () => ({ match: { home: "Home", away: "Away", home_score: "1", away_score: "0", status: "live", url: `/football/match/${slug}/x1/` } }) };
    return { ok: false, status: 404 };
  });
  assert.ok((await reader.run(new Date())) >= 1);

  assert.ok(calls.some((url) => new URL(url).searchParams.get("status") === "live"), "the live list is still asked first");
  assert.ok(calls.some((url) => new URL(url).searchParams.get("slug") === "home-v-away-empty"), `then the match page: ${calls.join(" | ")}`);
  const after = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
  assert.equal(after.liveEarlyScore, "1:0");
  for (const market of await prisma.market.findMany({ where: { eventId: match.id } })) assert.equal(market.livePauseReason, "ahead");
  await assert.rejects(place(match), /paused|goal is being confirmed/);

  // The live list failing outright: the match pages are still read, and nothing throws while one is read.
  const failing = new EarlyGoalService(prisma, sync, async (url) => (new URL(url).pathname.endsWith("/fixtures/") ? { ok: false, status: 503 } : { ok: true, json: async () => ({ match: { home_score: "1", away_score: "0", url: "/football/match/home-v-away-empty/x1/" } }) }));
  assert.ok((await failing.run(new Date())) >= 1);
  await prisma.event.update({ where: { id: match.id }, data: { status: "COMPLETED" } });
});

test("Croatia U21 v Germany U21, 17 Nov 2026: a goal only SportScore has (2–2) while the odds feed still shows 1–2; a draw slip at the old 5.50 is refused, and one placed before SportScore had it is void at settlement", async () => {
  await prisma.event.updateMany({ where: { status: "LIVE" }, data: { status: "COMPLETED" } });
  const match = await liveMatch("Croatia U21 vs Germany U21", "germany-u21-vs-croatia-u21");
  // The feed (API-Football) still has 1–2, priced for it: the draw at 5.50, open.
  await prisma.event.update({ where: { id: match.id }, data: { homeScore: 1, awayScore: 2, elapsed: 66, period: "2H" } });
  await prisma.selection.update({ where: { id: pick(match, "match_winner", "draw").id }, data: { liveOdds: 5.5, feedOdds: 5.5 } });
  const draw = pick(match, "match_winner", "draw");
  assert.equal((await odds.priceForPlayer(player.id, draw.id)).bettable, true, "nothing has paused the match yet");

  // (1) SportScore already shows 2–2; no timed read has happened. The slip reads SportScore itself and is refused.
  sportScore.set("germany-u21-vs-croatia-u21", [2, 2]);
  const start = await balance();
  await assert.rejects(placeChecked(match, "match_winner", "draw"), /goal is being confirmed/);
  assert.equal(await balance(), start, "no stake taken");
  assert.equal(await prisma.bet.count({ where: { selectionId: draw.id } }), 0);
  const paused = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
  assert.equal(paused.liveEarlyScore, "2:2");
  for (const market of await prisma.market.findMany({ where: { eventId: match.id } })) assert.equal(market.livePauseReason, "ahead", `${market.key} paused for everyone`);

  // (2) A draw bet that went in before SportScore had the goal (its check still saw 1–2): void at settlement, never paid.
  await prisma.event.update({ where: { id: match.id }, data: { liveEarlyScore: null, liveEarlyAt: null } });
  await prisma.market.updateMany({ where: { eventId: match.id }, data: { livePausedUntil: null, livePausedAt: null, liveReopenFrom: null, livePauseReason: null } });
  await prisma.earlyGoal.deleteMany({ where: { eventId: match.id } });
  sportScore.set("germany-u21-vs-croatia-u21", [1, 2]);
  await sleep(1_100); // past the second in which slips on one match share a read
  const placed = await placeChecked(match, "match_winner", "draw");
  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: placed.bets[0].id } });
  assert.deepEqual([bet.live.home, bet.live.away], [1, 2], "placed on 1–2");
  // The goal was scored 20 s before the bet; SportScore and the feed showed it after.
  await sync.earlyGoal(match.id, { home: 2, away: 2 }, "sportscore", new Date(bet.placedAt.getTime() + 5_000));
  const first = Math.floor(match.startsAt.getTime() / 1000);
  const goalMinute = Math.floor(((bet.placedAt.getTime() - 20_000) / 1000 - first) / 60) + 1;
  await prisma.event.update({
    where: { id: match.id },
    data: {
      status: "COMPLETED",
      period: "FT",
      homeScore: 2,
      awayScore: 2,
      resultHome: 2,
      resultAway: 2,
      resultHalfHome: 1,
      resultHalfAway: 0,
      finishedAt: new Date(),
      lateCheck: {
        first,
        second: first,
        goals: [
          { minute: 1, extra: null, side: "home" },
          { minute: 2, extra: null, side: "away" },
          { minute: 3, extra: null, side: "away" },
          { minute: goalMinute, extra: null, side: "home" },
        ],
        cards: [],
      },
      lateCheckedAt: new Date(),
    },
  });
  await settlement.settleEvent(match.id);
  const settled = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
  assert.equal(settled.status, "VOID", "the draw would have won at 5.50: it is void instead");
  assert.equal(settled.voidReason, "placed after a goal that hadn't shown yet");
  assert.equal(Number(settled.payout), 10, "only the stake back");
});

test("pace: linked matches missing from the live list are read from their pages at their own pace, and never slow the list's reads", async () => {
  await prisma.event.updateMany({ where: { status: "LIVE" }, data: { status: "COMPLETED" } });
  const listed = await liveMatch("Listed match", "listed-1");
  for (let i = 0; i < 8; i++) await liveMatch(`Missing ${i}`, `missing-${i}`);
  const calls = [];
  const reader = new EarlyGoalService(prisma, sync, async (url) => {
    calls.push(url);
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/fixtures/")) return new Response(JSON.stringify({ matches: [{ home_score: "0", away_score: "0", url: "/football/match/listed-1/a1/" }] }), { status: 200 });
    return new Response(JSON.stringify({ match: { home_score: "0", away_score: "0", url: `/football/match/${searchParams.get("slug")}/a1/` } }), { status: 200 });
  });
  const pages = () => calls.filter((url) => new URL(url).pathname.endsWith("/match/")).length;
  const lists = () => calls.filter((url) => new URL(url).pathname.endsWith("/fixtures/")).length;
  await reader.run(new Date());
  assert.equal(lists(), 1);
  assert.equal(pages(), 6, "a batch of match pages (6 without a key)");
  const paced = reader.nextDelay();
  await reader.run(new Date());
  await reader.run(new Date());
  assert.equal(lists(), 3, "the list is read every time");
  assert.equal(pages(), 6, "the pages wait their 30 s");
  // The pace is spread over what's left of the day, so it moves by a few ms between reads; the pages mustn't stretch it.
  assert.ok(Math.abs(reader.nextDelay() - paced) <= paced * 0.01, "the pages don't stretch the list's pace");
  assert.ok(paced < 20_000, `about one list read every 13 s without a key (${paced} ms)`);
  await prisma.event.update({ where: { id: listed.id }, data: { status: "COMPLETED" } });
});

test("no SportScore for a match (Arnavutköy v Aksaray, 18 Nov 2026): a longer wait, a live stake cap, and a bet placed after a goal nobody had seen yet is void, never paid at 1.09", async () => {
  await prisma.event.updateMany({ where: { status: "LIVE" }, data: { status: "COMPLETED" } });
  const covered = await liveMatch("Covered match", "covered-1");
  const bare = await liveMatch("Arnavutköy vs Aksaray", "no-link");
  await prisma.trackerMapping.update({ where: { eventId: bare.id }, data: { externalId: null, method: "none" } });
  await prisma.event.update({ where: { id: bare.id }, data: { homeScore: 0, awayScore: 1, elapsed: 70, period: "2H" } });
  await prisma.selection.update({ where: { id: pick(bare, "match_winner", "away").id }, data: { liveOdds: 1.09, feedOdds: 1.09 } });
  process.env.LIVE_UNCOVERED_DELAY_MS = "1500";
  process.env.LIVE_UNCOVERED_MAX_STAKE = "25";
  try {
    // (b) The wait: longer on the match without a second score source.
    const plan = async (event) => (await bets.plannedWait(actor, [pick(event, "match_winner", "home").id])).waitMs;
    assert.equal(await plan(covered), 600);
    assert.equal(await plan(bare), 1500);
    // (b) The cap: 25 ALL of open live stakes on it, every market together.
    const started = Date.now();
    const placed = await place(bare, "match_winner", "away");
    assert.ok(Date.now() - started >= 1_400, "it waited the longer wait");
    await place(bare, "goals_2_5", "over");
    await assert.rejects(place(bare, "match_winner", "draw"), /limited to 25 ALL: it has no live tracker.*5\.00 ALL more/);
    await place(covered, "match_winner", "home");
    await place(covered, "match_winner", "draw");
    await place(covered, "match_winner", "away");
    // 0 turns live betting on such matches off.
    process.env.LIVE_UNCOVERED_MAX_STAKE = "0";
    await assert.rejects(place(bare, "goals_2_5", "under"), /closed: we have no second live score source/);

    // (e) Aksaray's 0–2 went in 20 s before the bet; the feed showed it only after. At settlement the bet is void, not paid at 1.09.
    const bet = await prisma.bet.findUniqueOrThrow({ where: { id: placed.bets[0].id } });
    assert.deepEqual([bet.live.home, bet.live.away], [0, 1]);
    await prisma.goalSeen.create({ data: { eventId: bare.id, homeScore: 0, awayScore: 2, source: "odds", seenAt: new Date(bet.placedAt.getTime() + 25_000) } });
    const first = Math.floor(bare.startsAt.getTime() / 1000);
    const goalMinute = Math.floor(((bet.placedAt.getTime() - 20_000) / 1000 - first) / 60) + 1;
    await prisma.event.update({
      where: { id: bare.id },
      data: {
        status: "COMPLETED", period: "FT", homeScore: 0, awayScore: 2, resultHome: 0, resultAway: 2, resultHalfHome: 0, resultHalfAway: 1, finishedAt: new Date(),
        lateCheck: { first, second: first, goals: [{ minute: 1, extra: null, side: "away" }, { minute: goalMinute, extra: null, side: "away" }], cards: [] },
        lateCheckedAt: new Date(),
      },
    });
    await settlement.settleEvent(bare.id);
    const settled = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    assert.equal(settled.status, "VOID", "Aksaray won, but the bet came after the goal: void");
    assert.equal(Number(settled.payout), 10, "the stake back, never 10.90");
  } finally {
    process.env.LIVE_UNCOVERED_DELAY_MS = "0";
    delete process.env.LIVE_UNCOVERED_MAX_STAKE;
  }
});

test("Kyrgyzstan v Vietnam, 17 Nov 2026: our feed credits the goal to the home side (1–0), SportScore to the away side (0–1). Every market pauses, slips are refused past the usual hold, and the feed's prices can't reopen it until both agree", async () => {
  await prisma.event.updateMany({ where: { status: "LIVE" }, data: { status: "COMPLETED" } });
  const match = await liveMatch("Kyrgyzstan vs Vietnam", "kyrgyzstan-vs-vietnam");
  await prisma.event.update({ where: { id: match.id }, data: { homeScore: 1, awayScore: 0, elapsed: 20 } });
  const t0 = new Date();
  await early.run(t0, [{ id: "kyrgyzstan-vs-vietnam", home: 0, away: 1 }]);
  let event = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
  assert.equal(event.liveEarlyScore, "0:1", "the disagreement is kept: same total, other side");
  for (const market of await prisma.market.findMany({ where: { eventId: match.id } })) assert.equal(market.livePauseReason, "ahead", `${market.key} paused`);
  assert.equal(await prisma.earlyGoal.count({ where: { eventId: match.id } }), 0, "no new goal is recorded: it's who scored, not whether");
  await assert.rejects(place(match), /paused|goal is being confirmed/);

  // A fresh reading from the odds feed, still 1–0: its prices are for the wrong team, so nothing reopens on them.
  const readingOf = (home, away) => ({
    externalId: "x", stopped: false, finished: false, homeScore: home, awayScore: away, elapsed: 30, bookmakerUpdate: new Date().toISOString(),
    markets: [{ key: "match_winner", name: "Match winner", sortOrder: 0, suspended: false, selections: [{ key: "home", name: "Home", odds: 1.5, sortOrder: 0 }, { key: "draw", name: "Draw", odds: 4, sortOrder: 1 }, { key: "away", name: "Away", odds: 6, sortOrder: 2 }] }],
  });
  await sync.applyLiveOdds(match.id, readingOf(1, 0));
  event = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
  assert.equal(event.liveEarlyScore, "0:1", "the feed's 1–0 doesn't end it");
  assert.equal((await odds.priceForPlayer(player.id, pick(match, "match_winner", "home").id)).bettable, false, "1X2 stays closed");

  // The feed corrects itself to 0–1: they agree, and the hold is over.
  await sync.applyLiveOdds(match.id, readingOf(0, 1));
  event = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
  assert.equal(event.liveEarlyScore, null, "agreed: 0–1");
  assert.deepEqual([event.homeScore, event.awayScore], [0, 1]);
  await prisma.event.update({ where: { id: match.id }, data: { status: "COMPLETED" } });

  // Another match where they still disagree after the 4-minute hold: live betting closes on it, said as closed, not a pause
  // with no end (the stuck pauses of 24 Nov).
  const stuck = await liveMatch("Still disagreeing", "still-disagreeing");
  await prisma.event.update({ where: { id: stuck.id }, data: { homeScore: 1, awayScore: 0 } });
  const s0 = new Date();
  await early.run(s0, [{ id: "still-disagreeing", home: 0, away: 1 }]);
  await early.run(new Date(s0.getTime() + 5 * 60_000), [{ id: "still-disagreeing", home: 0, away: 1 }]);
  const closed = await prisma.event.findUniqueOrThrow({ where: { id: stuck.id } });
  assert.equal(closed.liveSlowFeed, true, "closed for the rest of the match");
  assert.equal(closed.liveEarlyScore, null);
  assert.equal((await odds.events(actor, "live")).find((row) => row.id === stuck.id)?.livePause, "slow");
  await prisma.event.update({ where: { id: stuck.id }, data: { status: "COMPLETED" } });
});

test("Wolves v Derby, 24 Nov 2026 (no SportScore link, the feed 40–75 s late): a refused slip locks the whole match; the match's own lag closes it; a bet placed 5 s after the unseen 3–0 at 1.01 is void, never paid", async () => {
  await prisma.event.updateMany({ where: { status: "LIVE" }, data: { status: "COMPLETED" } });
  const match = await liveMatch("Wolves vs Derby", "no-link-wolves");
  await prisma.trackerMapping.update({ where: { eventId: match.id }, data: { externalId: null, method: "none" } });
  await prisma.event.update({ where: { id: match.id }, data: { homeScore: 2, awayScore: 0, elapsed: 80, period: "2H" } });
  await prisma.selection.update({ where: { id: pick(match, "match_winner", "home").id }, data: { liveOdds: 1.01, feedOdds: 1.01 } });
  process.env.LIVE_UNCOVERED_MAX_STAKE = "1000";
  try {
    // (1) A slip refused because the feed's timeline had the 3–0 its prices didn't: the whole match pauses for everyone.
    await sync.lockMatch(match.id, "goal", { home: 3, away: 0 });
    let event = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
    assert.equal(event.liveScoreAhead, "3:0");
    for (const market of await prisma.market.findMany({ where: { eventId: match.id } })) assert.equal(market.livePauseReason, "ahead", `${market.key} paused`);
    await assert.rejects(place(match), /paused/);
    // Even once the market pauses run out, the board's 2–0 is older than the 3–0 the feed has: still no bets.
    await prisma.market.updateMany({ where: { eventId: match.id }, data: { livePausedUntil: null, livePausedAt: null, liveReopenFrom: null, livePauseReason: null } });
    await prisma.event.update({ where: { id: match.id }, data: { liveCooldownUntil: null } });
    assert.equal((await odds.events(actor, "live")).find((row) => row.id === match.id)?.livePause, "score");
    await assert.rejects(place(match), /paused/);

    // (2) The match's own goals reached us 50 s late: no wait covers that, so no live bets on it.
    await prisma.event.update({ where: { id: match.id }, data: { liveScoreAhead: null } });
    await prisma.goalSeen.create({ data: { eventId: match.id, homeScore: 2, awayScore: 0, source: "odds", seenAt: new Date(), lagMs: 50_000, lagMinMs: 20_000 } });
    await assert.rejects(place(match), /running too far behind/);
    await prisma.goalSeen.deleteMany({ where: { eventId: match.id } });

    // (3) A bet that went in on 2–0 (b1ga4g6h: 50 ALL at 1.01), placed 5 s after the real 3–0, which reached us a minute later.
    const placed = await place(match, "match_winner", "home");
    const bet = await prisma.bet.findUniqueOrThrow({ where: { id: placed.bets[0].id } });
    assert.deepEqual([bet.live.home, bet.live.away], [2, 0]);
    await prisma.goalSeen.create({ data: { eventId: match.id, homeScore: 3, awayScore: 0, source: "odds", seenAt: new Date(bet.placedAt.getTime() + 60_000) } });
    const first = Math.floor(match.startsAt.getTime() / 1000);
    const goalMinute = Math.floor(((bet.placedAt.getTime() - 5_000) / 1000 - first) / 60) + 1;
    await prisma.event.update({
      where: { id: match.id },
      data: {
        status: "COMPLETED", period: "FT", homeScore: 3, awayScore: 0, resultHome: 3, resultAway: 0, resultHalfHome: 1, resultHalfAway: 0, finishedAt: new Date(),
        lateCheck: { first, second: first, goals: [{ minute: 1, extra: null, side: "home" }, { minute: 2, extra: null, side: "home" }, { minute: goalMinute, extra: null, side: "home" }], cards: [] },
        lateCheckedAt: new Date(),
      },
    });
    await settlement.settleEvent(match.id);
    const settled = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    assert.equal(settled.status, "VOID", "Wolves won, but the bet came after the unseen 3–0: void");
    assert.equal(Number(settled.payout), 10, "the stake back, never paid at 1.01");
  } finally {
    delete process.env.LIVE_UNCOVERED_MAX_STAKE;
  }
});

test("a goal SportScore shows and then takes back (VAR): the match stays paused until the bookmaker's prices move, never back at the pre-goal ones (Shabab Al Ahli v Al-Qadisiyah)", async () => {
  await prisma.event.updateMany({ where: { status: "LIVE" }, data: { status: "COMPLETED" } });
  const match = await liveMatch("Shabab Al Ahli vs Al-Qadisiyah", "shabab-var");
  const readingOf = (home, draw, away) => ({
    externalId: "x", stopped: false, finished: false, homeScore: 0, awayScore: 0, elapsed: 60, bookmakerUpdate: new Date().toISOString(),
    markets: [{ key: "match_winner", name: "Match winner", sortOrder: 0, suspended: false, selections: [{ key: "home", name: "Home", odds: home, sortOrder: 0 }, { key: "draw", name: "Draw", odds: draw, sortOrder: 1 }, { key: "away", name: "Away", odds: away, sortOrder: 2 }] }],
  });
  await sync.applyLiveOdds(match.id, readingOf(6, 5.5, 1.4));
  // SportScore shows 0–1, then takes it back to 0–0 (a VAR check).
  await early.run(new Date(), [{ id: "shabab-var", home: 0, away: 1 }]);
  await early.run(new Date(), [{ id: "shabab-var", home: 0, away: 0 }]);
  let market = await prisma.market.findFirstOrThrow({ where: { eventId: match.id, key: "match_winner" } });
  assert.equal(market.livePauseReason, "withdrawn", "paused as a goal taken back");
  const until = market.livePausedUntil.getTime();
  // The bookmaker's same pre-goal prices, made after: not a reason to reopen.
  await sync.applyLiveOdds(match.id, readingOf(6, 5.5, 1.4));
  market = await prisma.market.findFirstOrThrow({ where: { eventId: match.id, key: "match_winner" } });
  assert.equal(market.livePausedUntil.getTime(), until, "the pre-goal prices don't reopen it");
  assert.equal((await odds.priceForPlayer(player.id, pick(match, "match_winner", "away").id)).bettable, false);
  // Prices that moved after the call: they reopen it (at the minimum).
  await sync.applyLiveOdds(match.id, readingOf(7, 6, 1.3));
  market = await prisma.market.findFirstOrThrow({ where: { eventId: match.id, key: "match_winner" } });
  assert.ok(market.livePausedUntil.getTime() <= until && market.livePausedUntil.getTime() === market.liveReopenFrom.getTime(), "moved prices: reopens at the minimum");
  await prisma.event.update({ where: { id: match.id }, data: { status: "COMPLETED" } });
});

test("teardown", async () => {
  await prisma.$disconnect();
});
