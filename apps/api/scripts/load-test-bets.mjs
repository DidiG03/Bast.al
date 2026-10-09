// A load test for placing bets, against a throwaway Postgres: one busy team,
// many Players sending slips at once, with thousands of bets already open,
// with and without the Owner's payout cap. Then it checks every stake left
// the balance once. Like the integration tests it empties tables, so it only
// runs against a database whose name ends in "_test".
//
//   npm run build --workspace apps/api
//   DATABASE_URL=postgresql://…/bastal_test node apps/api/scripts/load-test-bets.mjs
//
// Options (environment): PLAYERS (default 300), SLIPS per Player (default 5),
// OPEN, bets already open for the team (default 20000), POOL (default 10).
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const dist = new URL("../dist/", import.meta.url).pathname;
const { PrismaClient } = require("@prisma/client");
const { BetsService } = require(`${dist}bets/bets.service.js`);
const { RiskService } = require(`${dist}bets/risk.service.js`);
const { BettingLimitsService } = require(`${dist}commissions/betting-limits.service.js`);
const { OddsSyncService } = require(`${dist}odds/odds-sync.service.js`);
const { OddsService } = require(`${dist}odds/odds.service.js`);
const { UsersService } = require(`${dist}users/users.service.js`);
const { HierarchyService } = require(`${dist}users/hierarchy.service.js`);
const { AuditService } = require(`${dist}audit/audit.service.js`);
const { parseMarkets } = require(`${dist}odds/api-football.js`);
const { teamOf } = require(`${dist}bets/team.js`);

const url = new URL(process.env.DATABASE_URL ?? "postgresql://x/none");
if (!url.pathname.slice(1).endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${url.pathname.slice(1)}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
const PLAYERS = Number(process.env.PLAYERS ?? 300);
const SLIPS = Number(process.env.SLIPS ?? 5);
const OPEN = Number(process.env.OPEN ?? 20000);
const POOL = Number(process.env.POOL ?? 10);
url.searchParams.set("connection_limit", String(POOL));

const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, { create: async (n) => n }, realtime);
const sync = new OddsSyncService(prisma);
const odds = new OddsService(prisma, audit, sync);
const risk = new RiskService(prisma, audit);
const bets = new BetsService(prisma, odds, new BettingLimitsService(prisma, hierarchy), realtime, users, audit, risk, sync);
const actor = (u) => ({ id: u.id, role: u.role, parentId: u.parentId });

let made = 0;
const account = (role, parentId, extra = {}) => {
  made += 1;
  return prisma.user.create({ data: { clerkId: `clerk_lb${made}`, username: `lb${made}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hlb${made}`, role, parentId, ...extra } });
};

async function match(i) {
  const event = await prisma.event.create({ data: { sport: "football", provider: "api-football", externalId: `load-${i}`, name: `Home ${i} v Away ${i}`, league: "Premier League", homeTeam: `Home ${i}`, awayTeam: `Away ${i}`, startsAt: new Date(Date.now() + (2 + i) * 3_600_000) } });
  const bet = (name, values) => ({ id: 0, name, values: Object.entries(values).map(([value, odd]) => ({ value, odd: String(odd) })) });
  await sync.upsertMarkets(event.id, parseMarkets({ fixture: { id: i }, bookmakers: [{ id: 8, name: "Bet365", bets: [bet("Match Winner", { Home: 1.8, Draw: 3.8, Away: 4.3 }), bet("Goals Over/Under", { "Over 2.5": 1.7, "Under 2.5": 2.15 }), bet("Both Teams Score", { Yes: 1.75, No: 2.05 })] }] }, `Home ${i}`, `Away ${i}`, 8));
  return prisma.selection.findMany({ where: { market: { eventId: event.id, key: "match_winner" } }, orderBy: { sortOrder: "asc" } });
}

const stats = new Map();
const errors = new Map();
const note = (map, key, value) => (map.has(key) ? map.get(key).push(value) : map.set(key, [value]));
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
function report(title, seconds) {
  console.log(`\n${title}`);
  console.log("slip            sent   per sec      p50      p95      p99      max");
  for (const [name, times] of [...stats].sort()) {
    const sorted = [...times].sort((a, b) => a - b);
    const ms = (value) => `${value.toFixed(0).padStart(6)}ms`;
    console.log(`${name.padEnd(12)} ${String(times.length).padStart(7)} ${(times.length / seconds).toFixed(1).padStart(9)} ${ms(quantile(sorted, 0.5))} ${ms(quantile(sorted, 0.95))} ${ms(quantile(sorted, 0.99))} ${ms(sorted.at(-1) ?? 0)}`);
  }
  for (const [message, hits] of [...errors].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(hits.length).padStart(5)} × ${message}`);
  stats.clear();
  errors.clear();
}

for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "idempotency_keys", "login_history", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "audit_logs", "platform_settings", "users"]) {
  await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
}
await prisma.platformSettings.create({ data: { id: "default", baseOddsMargin: 5 } });
const sa = await account("SUPER_ADMIN", null);
const owner = await account("OWNER", sa.id, { commissionRate: 10 });
const players = [];
for (let m = 0; m < 10; m++) {
  const manager = await account("MANAGER", owner.id, { commissionRate: 20 });
  for (let i = 0; i < PLAYERS / 10; i++) players.push(await account("PLAYER", manager.id, { balance: 100_000 }));
}
const matches = [];
for (let i = 0; i < 30; i++) matches.push(await match(i));
const picks = matches.flat();

// A busy weekend: thousands of the team's bets already open, singles and accumulators.
const team = await teamOf(prisma, players[0].id);
for (let done = 0; done < OPEN; done += 1000) {
  const batch = Array.from({ length: Math.min(1000, OPEN - done) }, (_, i) => {
    const n = done + i;
    const player = players[n % players.length];
    const accumulator = n % 3 === 0;
    return { id: `open-${n}`, playerId: player.id, stake: 10, odds: accumulator ? 6.5 : 2, kind: accumulator ? "ACCUMULATOR" : "SINGLE", selectionId: accumulator ? null : picks[n % picks.length].id, description: "Load", ...team, managerId: player.parentId };
  });
  await prisma.bet.createMany({ data: batch });
  const legs = batch.filter((bet) => bet.kind === "ACCUMULATOR").flatMap((bet, b) => [0, 1, 2].map((k) => ({ betId: bet.id, selectionId: picks[(b * 7 + k * 3) % picks.length].id, odds: 1.9, description: "Load", sortOrder: k })));
  await prisma.betLeg.createMany({ data: legs });
}
// Up-to-date statistics, as a live database has, so the plans are the ones it would use.
if (!process.env.STALE) await prisma.$executeRawUnsafe("ANALYZE");
console.log(`Bets load test: ${players.length} Players on one team, ${OPEN} bets already open, ${POOL} database connections`);

// The prices Players see, read once up front: the page already shows them, so slips don't wait on quotes.
const prices = new Map();
for (let i = 0; i < picks.length; i += 20) {
  for (const quote of await odds.selections(actor(players[0]), picks.slice(i, i + 20).map((pick) => pick.id))) prices.set(quote.id, quote.price);
}

async function round(title) {
  const start = performance.now();
  await Promise.all(
    players.map(async (player, p) => {
      for (let s = 0; s < SLIPS; s++) {
        const accumulator = (p + s) % 2 === 1;
        const chosen = accumulator ? [0, 1, 2, 3].map((k) => matches[(p + s * 3 + k * 5) % matches.length][(p + k) % 3]) : [matches[(p * 7 + s) % matches.length][(p + s) % 3]];
        const legs = chosen.map((selection) => ({ selectionId: selection.id, odds: prices.get(selection.id) }));
        const slip = accumulator ? { accumulator: { stake: 10, legs } } : { bets: legs.map((leg) => ({ ...leg, stake: 10 })) };
        const began = performance.now();
        try {
          await bets.place(actor(player), { ...slip, acceptOddsChanges: true });
        } catch (error) {
          note(errors, `${accumulator ? "accumulator" : "single"}: ${error.message.split("\n").pop().slice(0, 140)}`, 1);
        } finally {
          note(stats, accumulator ? "accumulator" : "single", performance.now() - began);
        }
      }
    }),
  );
  report(title, (performance.now() - start) / 1000);
}

await round("1. No payout cap");
await prisma.user.update({ where: { id: owner.id }, data: { maxOutcomePayout: 10_000_000 } });
await round("2. With the Owner's payout cap (every slip checks the team's open bets)");

// Every stake left the balance once, and the ledger adds up.
const placed = await prisma.$queryRaw`SELECT player_id AS id, SUM(stake) AS staked FROM bets WHERE id NOT LIKE 'open-%' GROUP BY player_id`;
const byPlayer = new Map(placed.map((row) => [row.id, Number(row.staked)]));
let wrong = 0;
for (const row of await prisma.user.findMany({ where: { id: { in: players.map((player) => player.id) } }, select: { id: true, balance: true } })) {
  if (Math.abs(100_000 - (byPlayer.get(row.id) ?? 0) - Number(row.balance)) > 0.001) wrong++;
}
console.log(wrong ? `\n  ✗ ${wrong} Players' balances don't match their stakes` : "\n  ✓ every stake left the balance exactly once");
await prisma.$disconnect();
