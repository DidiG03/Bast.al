// Saving live readings against a real Postgres: only what changed is
// written, and what's saved is right: new markets and outcomes added, moved
// prices updated, an outcome the feed stops pricing loses its price, a market
// it stops sending is suspended (and comes back), and a goal pauses the match.
// Like the other integration tests it empties tables, so it only runs against
// a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { OddsSyncService } = require("../dist/odds/odds-sync.service.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const prisma = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
let writes = 0;
prisma.$on("query", (event) => {
  if (/^\s*(INSERT|UPDATE|DELETE)/i.test(event.query)) writes++;
});
const sync = new OddsSyncService(prisma);

let match;
/** A reading: the score, and markets as { key: { outcome: price } }; `suspended` lists suspended market keys. */
const reading = (home, away, markets, suspended = []) => ({
  externalId: "x",
  stopped: false,
  finished: false,
  homeScore: home,
  awayScore: away,
  elapsed: 30,
  markets: Object.entries(markets).map(([key, outcomes], sortOrder) => ({
    key,
    name: key,
    sortOrder,
    suspended: suspended.includes(key),
    selections: Object.entries(outcomes).map(([outcome, odds], order) => ({ key: outcome, name: outcome, odds, sortOrder: order })),
  })),
});
async function prices() {
  const rows = await prisma.selection.findMany({ where: { market: { eventId: match.id } }, select: { key: true, liveOdds: true, market: { select: { key: true } } } });
  return Object.fromEntries(rows.map((row) => [`${row.market.key}.${row.key}`, row.liveOdds === null ? null : Number(row.liveOdds)]));
}
const suspendedMarkets = async () => (await prisma.market.findMany({ where: { eventId: match.id, liveSuspended: true }, select: { key: true }, orderBy: { key: "asc" } })).map((market) => market.key);

test("setup: a live match", async () => {
  for (const table of ["settlement_entries", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\""]) await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  match = await prisma.event.create({ data: { sport: "football", provider: "api-football", externalId: "live-1", name: "A v B", league: "League", homeTeam: "A", awayTeam: "B", startsAt: new Date(Date.now() - 1_800_000), status: "LIVE", homeScore: 0, awayScore: 0 } });
});

test("the first reading adds every market and price", async () => {
  await sync.applyLiveOdds(match.id, reading(0, 0, { match_winner: { home: 2.1, draw: 3.2, away: 3.6 }, goals: { over: 1.8, under: 2 } }));
  assert.deepEqual(await prices(), { "match_winner.home": 2.1, "match_winner.draw": 3.2, "match_winner.away": 3.6, "goals.over": 1.8, "goals.under": 2 });
});

test("the same reading again writes no prices", async () => {
  writes = 0;
  await sync.applyLiveOdds(match.id, reading(0, 0, { match_winner: { home: 2.1, draw: 3.2, away: 3.6 }, goals: { over: 1.8, under: 2 } }));
  assert.equal(writes, 1, "only the match's own row (when it was last read)");
});

test("moved prices are updated, a new outcome is added, one no longer priced loses its price, and a market not sent is suspended", async () => {
  writes = 0;
  await sync.applyLiveOdds(match.id, reading(0, 0, { match_winner: { home: 2.05, draw: 3.2, away: 3.7 }, corners: { over: 1.9, under: 1.9 } }));
  assert.deepEqual(await prices(), {
    "match_winner.home": 2.05,
    "match_winner.draw": 3.2,
    "match_winner.away": 3.7,
    "goals.over": 1.8,
    "goals.under": 2,
    "corners.over": 1.9,
    "corners.under": 1.9,
  });
  assert.deepEqual(await suspendedMarkets(), ["goals"], "the market the feed stopped sending");
  assert.ok(writes <= 5, `a handful of writes, not one per price (${writes})`);

  await sync.applyLiveOdds(match.id, reading(0, 0, { match_winner: { home: 2.05, away: 3.7 }, goals: { over: 1.75, under: 2.05 }, corners: { over: 1.9, under: 1.9 } }, ["corners"]));
  const now = await prices();
  assert.equal(now["match_winner.draw"], null, "an outcome the feed stopped pricing can't be bet on");
  assert.deepEqual([now["goals.over"], now["goals.under"]], [1.75, 2.05]);
  assert.deepEqual(await suspendedMarkets(), ["corners"], "goals came back; corners the feed suspended");
});

test("a goal still pauses live betting", async () => {
  await sync.applyLiveOdds(match.id, reading(1, 0, { match_winner: { home: 1.4, away: 6.5 }, goals: { over: 1.4, under: 2.9 }, corners: { over: 1.9, under: 1.9 } }));
  const saved = await prisma.event.findUniqueOrThrow({ where: { id: match.id } });
  assert.deepEqual([saved.homeScore, saved.awayScore, saved.liveCooldownReason], [1, 0, "goal"]);
  assert.ok(saved.liveCooldownUntil > new Date());
});

test("teardown", async () => {
  await prisma.event.deleteMany({ where: { id: match.id } });
  await prisma.$disconnect();
});
