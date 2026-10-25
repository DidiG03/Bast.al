// Keeping live markets open, end to end against a real Postgres: a goal
// pauses only the markets it changes and they reopen on fresh prices after
// the minimum (or at the fallback without them); a market the feed suspends
// pauses alone, and only the match-wide flag pauses the match; a market the
// feed hasn't priced for a while is taken off the live board, as are cards
// markets in a competition the feed never prices them for live; a
// competition whose feed is too slow is pre-match only; and the metrics
// (market-time open, pauses) add up. Times are a tenth of the real ones.
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
// A tenth of the real times: 1.5 s least, 9 s fallback after a goal. Read when the code loads.
process.env.LIVE_GOAL_MIN_PAUSE_MS = "1500";
process.env.LIVE_GOAL_COOLDOWN_MS = "9000";
process.env.LIVE_SWING_COOLDOWN_MS = "3000";
process.env.LIVE_REOPEN_COOLDOWN_MS = "1500";
process.env.LIVE_COMPETITION_MAX_LAG_MS = "15000";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");
const { OddsService } = require("../dist/odds/odds.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");

const prisma = new PrismaClient();
const sync = new OddsSyncService(prisma);
const odds = new OddsService(prisma, new AuditService(prisma), sync);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let player;
let n = 0;
/** A reading: the score, markets as { key: { outcome: price } }, the suspended ones, when the bookmaker made it (ms ago), and the match-wide flag. */
const reading = (home, away, markets, { suspended = [], madeMsAgo = 500, stopped = false } = {}) => ({
  externalId: "x",
  stopped,
  finished: false,
  homeScore: home,
  awayScore: away,
  elapsed: 30,
  bookmakerUpdate: new Date(Date.now() - madeMsAgo).toISOString(),
  markets: Object.entries(markets).map(([key, outcomes], sortOrder) => ({
    key,
    name: key,
    sortOrder,
    suspended: suspended.includes(key),
    selections: Object.entries(outcomes).map(([outcome, price], order) => ({ key: outcome, name: outcome, odds: price, sortOrder: order })),
  })),
});
const board = (winner, goals, cards) => ({ match_winner: winner, goals_2_5: goals, cards_3_5: cards });

async function liveMatch(name, league = "League") {
  n += 1;
  return prisma.event.create({ data: { sport: "football", provider: "api-football", externalId: `lm-${n}`, name, league, homeTeam: "A", awayTeam: "B", startsAt: new Date(Date.now() - 30 * 60_000), status: "LIVE", period: "1H", elapsed: 30, homeScore: 0, awayScore: 0 } });
}
/** Whether a Player can bet on this market's first outcome right now. */
async function open(match, key) {
  const selection = await prisma.selection.findFirstOrThrow({ where: { market: { eventId: match.id, key } }, orderBy: { sortOrder: "asc" } });
  return (await odds.priceForPlayer(player.id, selection.id)).bettable;
}
const marketOf = (match, key) => prisma.market.findFirstOrThrow({ where: { eventId: match.id, key } });

test("setup", async () => {
  for (const table of ["live_pauses", "goals_seen", "settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  const sa = await prisma.user.create({ data: { clerkId: "clerk_lm1", username: "lm_sa", emailCipher: "x", emailHash: "hlm1", role: "SUPER_ADMIN" } });
  const owner = await prisma.user.create({ data: { clerkId: "clerk_lm2", username: "lm_owner", emailCipher: "x", emailHash: "hlm2", role: "OWNER", parentId: sa.id } });
  player = await prisma.user.create({ data: { clerkId: "clerk_lm3", username: "lm_player", emailCipher: "x", emailHash: "hlm3", role: "PLAYER", parentId: owner.id } });
});

test("(a) fresh prices after a goal reopen its markets at the minimum, not the fallback; (c) a priced cards market stays open", async () => {
  const match = await liveMatch("Fresh after a goal");
  await sync.applyLiveOdds(match.id, reading(0, 0, board({ home: 2.1, draw: 3.2, away: 3.6 }, { over: 1.8, under: 2 }, { over: 2, under: 1.8 })));
  assert.equal(await open(match, "match_winner"), true);
  const goalAt = Date.now();
  // The goal comes with the bookmaker's prices for it; cards are still priced.
  await sync.applyLiveOdds(match.id, reading(1, 0, board({ home: 1.4, draw: 4.5, away: 8 }, { over: 1.5, under: 2.5 }, { over: 2, under: 1.8 })));
  assert.equal(await open(match, "match_winner"), false, "the goal pauses the match result");
  assert.equal(await open(match, "goals_2_5"), false, "and the totals");
  assert.equal(await open(match, "cards_3_5"), true, "(c) not a cards market the goal's reading still prices");
  const paused = await marketOf(match, "match_winner");
  assert.ok(paused.livePausedUntil.getTime() - goalAt >= 8_500, "the fallback, until fresh prices come");
  // (a) Fresh prices a second in (a tenth of 10 s): made after the goal, moved since it.
  await sleep(1_000);
  await sync.applyLiveOdds(match.id, reading(1, 0, board({ home: 1.38, draw: 4.6, away: 8.5 }, { over: 1.48, under: 2.55 }, { over: 2, under: 1.8 }), { madeMsAgo: 200 }));
  const reopening = await marketOf(match, "match_winner");
  assert.equal(reopening.livePausedUntil.getTime(), reopening.liveReopenFrom.getTime(), "it reopens at the minimum (a tenth of 15 s)");
  assert.equal(await open(match, "match_winner"), false, "not before it");
  await sleep(reopening.livePausedUntil.getTime() - Date.now() + 50);
  assert.equal(await open(match, "match_winner"), true, "open again at about 1.5 s, not 9");
  assert.equal(await open(match, "goals_2_5"), true);
  const pause = await prisma.livePause.findFirstOrThrow({ where: { eventId: match.id } });
  assert.equal(pause.reason, "goal");
  assert.equal(pause.fresh, true);
  assert.ok(pause.endsAt.getTime() - pause.startedAt.getTime() < 2_000);
});

test("(b) without fresh prices the fallback applies", async () => {
  const match = await liveMatch("No fresh prices");
  await sync.applyLiveOdds(match.id, reading(0, 0, board({ home: 2.1, draw: 3.2, away: 3.6 }, { over: 1.8, under: 2 }, { over: 2, under: 1.8 })));
  await sync.applyLiveOdds(match.id, reading(0, 1, board({ home: 4, draw: 3.4, away: 1.9 }, { over: 1.5, under: 2.5 }, { over: 2, under: 1.8 })));
  const fallback = (await marketOf(match, "match_winner")).livePausedUntil.getTime();
  await sleep(1_700);
  // Past the minimum, but the bookmaker made these before the goal, and the prices haven't moved: no reopening.
  await sync.applyLiveOdds(match.id, reading(0, 1, board({ home: 4, draw: 3.4, away: 1.9 }, { over: 1.5, under: 2.5 }, { over: 2, under: 1.8 }), { madeMsAgo: 5_000 }));
  await sync.applyLiveOdds(match.id, reading(0, 1, board({ home: 4, draw: 3.4, away: 1.9 }, { over: 1.5, under: 2.5 }, { over: 2, under: 1.8 }), { madeMsAgo: 100 }));
  assert.equal((await marketOf(match, "match_winner")).livePausedUntil.getTime(), fallback, "the fallback stands");
  assert.equal(await open(match, "match_winner"), false);
  const pause = await prisma.livePause.findFirstOrThrow({ where: { eventId: match.id } });
  assert.equal(pause.fresh, false);
});

test("(d) a market the feed suspends pauses alone; the match-wide flag pauses the match", async () => {
  const match = await liveMatch("Flags");
  await sync.applyLiveOdds(match.id, reading(0, 0, board({ home: 2.1, draw: 3.2, away: 3.6 }, { over: 1.8, under: 2 }, { over: 2, under: 1.8 }), { suspended: ["goals_2_5"] }));
  assert.equal(await open(match, "goals_2_5"), false, "its own flag pauses it");
  assert.equal(await open(match, "match_winner"), true, "and nothing else");
  assert.equal(await open(match, "cards_3_5"), true);
  await sync.applyLiveOdds(match.id, reading(0, 0, board({ home: 2.1, draw: 3.2, away: 3.6 }, { over: 1.8, under: 2 }, { over: 2, under: 1.8 }), { stopped: true }));
  assert.equal(await open(match, "match_winner"), false, "the match-wide flag");
  const listed = (await odds.events({ id: player.id, role: "PLAYER", parentId: player.parentId }, "live")).find((event) => event.id === match.id);
  assert.equal(listed.livePause, "feed");
});

test("(e) a market the feed hasn't priced live for a while is off the board; so are cards in a competition never priced live", async () => {
  const match = await liveMatch("Stale");
  await sync.applyLiveOdds(match.id, reading(0, 0, board({ home: 2.1, draw: 3.2, away: 3.6 }, { over: 1.8, under: 2 }, { over: 2, under: 1.8 })));
  await prisma.market.updateMany({ where: { eventId: match.id, key: "goals_2_5" }, data: { liveQuotedAt: new Date(Date.now() - 6 * 60_000), liveSuspended: true } });
  const actor = { id: player.id, role: "PLAYER", parentId: player.parentId };
  const view = await odds.event(actor, match.id);
  const stale = view.markets.find((market) => market.key === "goals_2_5");
  assert.equal(stale.stale, true, "shown under Not available during play");
  assert.equal(stale.suspended, true);
  assert.equal(view.markets.find((market) => market.key === "match_winner").stale, false);

  // Three finished live matches in a competition, none with a live cards price: its live matches leave cards out.
  for (let i = 0; i < 3; i++) {
    const done = await liveMatch(`No live cards ${i}`, "Quiet League");
    await sync.applyLiveOdds(done.id, reading(0, 0, board({ home: 2.1, draw: 3.2, away: 3.6 }, { over: 1.8, under: 2 }, {})));
    await prisma.event.update({ where: { id: done.id }, data: { status: "COMPLETED" } });
  }
  const quiet = await liveMatch("Quiet now", "Quiet League");
  await sync.applyLiveOdds(quiet.id, reading(0, 0, board({ home: 2.1, draw: 3.2, away: 3.6 }, { over: 1.8, under: 2 }, {})));
  odds.limitsKept = null;
  const shown = await odds.event(actor, quiet.id);
  assert.ok(!shown.markets.some((market) => market.key.startsWith("cards_")), "no cards market on the live match");
  assert.equal(shown.marketCount, 2);
  assert.ok((await odds.event(actor, match.id)).markets.some((market) => market.key === "cards_3_5"), "another competition keeps its cards");
});

test("a competition whose goals reach the site 15 s or more late is pre-match only", async () => {
  const slow = await liveMatch("Slow feed", "Slow League");
  await sync.applyLiveOdds(slow.id, reading(0, 0, board({ home: 2.1, draw: 3.2, away: 3.6 }, { over: 1.8, under: 2 }, { over: 2, under: 1.8 })));
  for (let i = 1; i <= 5; i++) await prisma.goalSeen.create({ data: { eventId: slow.id, homeScore: i, awayScore: 0, source: "odds", lagMs: 22_000, lagMinMs: 20_000 } });
  odds.limitsKept = null;
  assert.equal(await open(slow, "match_winner"), false);
  const [listed] = (await odds.events({ id: player.id, role: "PLAYER", parentId: player.parentId }, "live")).filter((event) => event.id === slow.id);
  assert.equal(listed.livePause, "competition");
  assert.equal(listed.bettable, false);
});

test("the live metrics add up: market-time open, pauses and how they ended", async () => {
  const health = await odds.liveHealth(1);
  assert.ok(health.overall.openOfShown > 0 && health.overall.openOfShown <= 100);
  assert.ok(health.overall.pauses >= 2);
  assert.ok(health.pausesByReason.some((row) => row.reason === "goal" && row.fresh >= 1));
  const fresh = health.matches.find((match) => match.name === "Fresh after a goal");
  assert.ok(fresh.openOfAll !== null);
  assert.ok(health.liveLimits.slow.includes("api-football · Slow League"));
  assert.ok(health.liveLimits.noCards.includes("api-football · Quiet League"));
  assert.equal(health.polling.matches.length > 0, true, "each match's readings are counted");
});

test("teardown", async () => {
  await prisma.$disconnect();
});
