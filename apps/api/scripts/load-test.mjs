// A load test for the Casino, against a throwaway Postgres. It plays every
// game as many Players at once, and as one Player in several tabs at once,
// then checks that the money still adds up. Like the integration tests it
// empties tables, so it only runs against a database whose name ends in "_test".
//
//   npm run build --workspace apps/api
//   DATABASE_URL=postgresql://…/bastal_test node apps/api/scripts/load-test.mjs
//
// Options (environment): PLAYERS (default 120), ROUNDS per game per Player
// (default 6), POOL, the database connections, like production's (default 10),
// TABS, requests one Player sends at once in the tabs test (default 8).
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const dist = new URL("../dist/", import.meta.url).pathname;
const { PrismaClient } = require("@prisma/client");
const { CasinoService } = require(`${dist}casino/casino.service.js`);
const { RouletteService } = require(`${dist}casino/roulette.service.js`);
const { BlackjackService } = require(`${dist}casino/blackjack.service.js`);
const { BookService } = require(`${dist}casino/book.service.js`);
const { MinesService } = require(`${dist}casino/mines.service.js`);
const { PenaltyService } = require(`${dist}casino/penalty.service.js`);
const { PlinkoService } = require(`${dist}casino/plinko.service.js`);
const { DiceService } = require(`${dist}casino/dice.service.js`);
const { KenoService } = require(`${dist}casino/keno.service.js`);
const { CoinFlipService } = require(`${dist}casino/coin-flip.service.js`);
const { ScratchService } = require(`${dist}casino/scratch.service.js`);
const { BettingLimitsService } = require(`${dist}commissions/betting-limits.service.js`);
const { CommissionsService } = require(`${dist}commissions/commissions.service.js`);
const { UsersService } = require(`${dist}users/users.service.js`);
const { HierarchyService } = require(`${dist}users/hierarchy.service.js`);
const { AuditService } = require(`${dist}audit/audit.service.js`);

const url = new URL(process.env.DATABASE_URL ?? "postgresql://x/none");
if (!url.pathname.slice(1).endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${url.pathname.slice(1)}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
const PLAYERS = Number(process.env.PLAYERS ?? 120);
const ROUNDS = Number(process.env.ROUNDS ?? 6);
const POOL = Number(process.env.POOL ?? 10);
const TABS = Number(process.env.TABS ?? 8);
url.searchParams.set("connection_limit", String(POOL));

const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const limits = new BettingLimitsService(prisma, hierarchy);
const commissions = new CommissionsService(prisma, hierarchy);
const casino = new CasinoService(prisma, limits, commissions, realtime, users, audit);
const games = {
  roulette: new RouletteService(prisma, limits, realtime, users, audit),
  blackjack: new BlackjackService(prisma, limits, realtime, users),
  book: new BookService(prisma, limits, realtime, users, audit),
  mines: new MinesService(prisma, limits, realtime, users),
  penalty: new PenaltyService(prisma, limits, realtime, users),
  plinko: new PlinkoService(prisma, limits, realtime, users, audit),
  dice: new DiceService(prisma, limits, realtime, users, audit),
  keno: new KenoService(prisma, limits, realtime, users, audit),
  coinflip: new CoinFlipService(prisma, limits, realtime, users),
  scratch: new ScratchService(prisma, limits, realtime, users, audit),
};

/** One round of each game, the way a Player plays it: the steps of a round are separate requests. */
const ROUND = {
  slot: (p) => timed("slot", () => casino.spin(p, 100)),
  book: (p) => timed("book", () => games.book.spin(p, 100)),
  roulette: (p) => timed("roulette", () => games.roulette.spin(p, [{ spot: "RED", amount: 100 }])),
  blackjack: async (p) => {
    let answer = await timed("blackjack", () => games.blackjack.deal(p, 100));
    for (let i = 0; i < 6 && answer.round.phase !== "DONE"; i++) {
      const action = answer.round.phase === "INSURANCE" ? "noInsurance" : "stand";
      answer = await timed("blackjack", () => games.blackjack.act(p, action));
    }
  },
  mines: async (p) => {
    let answer = await timed("mines", () => games.mines.start(p, 100, 3));
    answer = await timed("mines", () => games.mines.open(p, Math.floor(Math.random() * 25)));
    if (answer.round.phase === "PLAY") await timed("mines", () => games.mines.collect(p));
  },
  penalty: async (p) => {
    let answer = await timed("penalty", () => games.penalty.start(p, 100));
    answer = await timed("penalty", () => games.penalty.shoot(p, ["LEFT", "CENTER", "RIGHT"][Math.floor(Math.random() * 3)]));
    if (answer.round.phase === "PLAY") await timed("penalty", () => games.penalty.collect(p));
  },
  plinko: (p) => timed("plinko", () => games.plinko.drop(p, 100, 12, "MEDIUM")),
  dice: (p) => timed("dice", () => games.dice.roll(p, 100, 50, "UNDER")),
  keno: (p) => timed("keno", () => games.keno.play(p, 100, [3, 17, 22, 41, 58])),
  coinflip: (p) => timed("coinflip", () => games.coinflip.flip(p, 100, "HEADS")),
  scratch: (p) => timed("scratch", () => games.scratch.buy(p, 100)),
};

const stats = new Map();
const errors = new Map();
function note(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
async function timed(name, run) {
  const start = performance.now();
  try {
    return await run();
  } catch (error) {
    note(errors, `${name}: ${error?.message?.split("\n").pop()?.slice(0, 140) ?? error}`, 1);
    throw error;
  } finally {
    note(stats, name, performance.now() - start);
  }
}
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
function report(title, seconds) {
  console.log(`\n${title}`);
  console.log("game        requests   per sec      p50      p95      p99      max");
  let all = 0;
  for (const [name, times] of [...stats].sort()) {
    const sorted = [...times].sort((a, b) => a - b);
    all += times.length;
    const ms = (value) => `${value.toFixed(0).padStart(6)}ms`;
    console.log(`${name.padEnd(10)} ${String(times.length).padStart(9)} ${(times.length / seconds).toFixed(1).padStart(9)} ${ms(quantile(sorted, 0.5))} ${ms(quantile(sorted, 0.95))} ${ms(quantile(sorted, 0.99))} ${ms(sorted.at(-1) ?? 0)}`);
  }
  console.log(`all        ${String(all).padStart(9)} ${(all / seconds).toFixed(1).padStart(9)}   in ${seconds.toFixed(1)}s`);
  if (errors.size) {
    console.log("errors:");
    for (const [message, hits] of [...errors].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(hits.length).padStart(5)} × ${message}`);
  }
  stats.clear();
  errors.clear();
}

let made = 0;
async function account(role, parentId, extra = {}) {
  made += 1;
  return prisma.user.create({ data: { clerkId: `clerk_load${made}`, username: `load${made}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hload${made}`, role, parentId, ...extra } });
}

async function setup() {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_spins", "casino_free_spins", "casino_gambles", "casino_book_features", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default", casinoEnabled: true }, update: { casinoEnabled: true } });
  const sa = await account("SUPER_ADMIN", null);
  const players = [];
  for (let o = 0; o < 4; o++) {
    const owner = await account("OWNER", sa.id, { commissionRate: 10, balance: 0, casinoEnabled: true });
    for (let m = 0; m < 3; m++) {
      const manager = await account("MANAGER", owner.id, { commissionRate: 20, balance: 0 });
      for (let i = 0; players.length < PLAYERS && i < Math.ceil(PLAYERS / 12); i++) {
        const player = await account("PLAYER", manager.id, { balance: 1_000_000 });
        await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: player.id, actorId: manager.id, type: "DELEGATION", amount: 1_000_000, reason: "Top-up" } });
        players.push(player);
      }
    }
  }
  return players;
}

/** Runs `work` for every item, at most `limit` at once. */
async function pool(items, limit, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await work(item).catch(() => undefined);
      }
    }),
  );
}

async function crowd(players) {
  // Every Player at once, each playing every game in turn, like a busy evening.
  const start = performance.now();
  await Promise.all(
    players.map(async (player) => {
      for (let r = 0; r < ROUNDS; r++) {
        for (const play of Object.values(ROUND)) await play(player).catch(() => undefined);
      }
    }),
  );
  report(`1. ${players.length} Players at once, ${ROUNDS} rounds of each game each, ${POOL} database connections`, (performance.now() - start) / 1000);
}

async function tabs(players) {
  // One Player sending the same request from several tabs at once (or autoplay in two tabs, or a double tap).
  const start = performance.now();
  const group = players.slice(0, 20);
  await pool(group, group.length, async (player) => {
    for (const name of ["dice", "keno", "coinflip", "scratch", "plinko", "roulette", "slot", "book"]) {
      await Promise.all(Array.from({ length: TABS }, () => ROUND[name](player).catch(() => undefined)));
    }
    // Rounds that stay open: only one may start, and its steps must not run twice.
    for (const name of ["mines", "penalty", "blackjack"]) {
      const service = games[name];
      const begin = name === "mines" ? () => service.start(player, 100, 3) : name === "penalty" ? () => service.start(player, 100) : () => service.deal(player, 100);
      const started = await Promise.allSettled(Array.from({ length: TABS }, () => timed(`${name} start`, begin)));
      const ok = started.filter((result) => result.status === "fulfilled").length;
      if (ok > 1) note(errors, `${name}: ${ok} rounds started at once for one Player`, 1);
      if (name === "mines") await Promise.allSettled([...Array.from({ length: TABS }, (_, i) => timed("mines step", () => service.open(player, i))), timed("mines step", () => service.collect(player))]);
      if (name === "penalty") await Promise.allSettled([...Array.from({ length: TABS }, () => timed("penalty step", () => service.shoot(player, "LEFT"))), timed("penalty step", () => service.collect(player))]);
      if (name === "blackjack") await Promise.allSettled(Array.from({ length: TABS }, () => timed("blackjack step", () => service.act(player, "stand").catch(() => service.act(player, "noInsurance")))));
      // Finish whatever is left so the next test starts clean.
      await service.collect?.(player).catch(() => undefined);
      for (let i = 0; i < 4; i++) await service.act?.(player, "stand").catch(() => service.act?.(player, "noInsurance")).catch(() => undefined);
    }
  });
  report(`2. ${group.length} Players, each sending ${TABS} requests at once per game`, (performance.now() - start) / 1000);
}

async function lossLimit(players) {
  // A daily loss limit must hold even when many rounds arrive at once.
  const group = players.slice(20, 30);
  const limit = 1000;
  for (const player of group) {
    const used = await limits.usedToday(player.id);
    await prisma.bettingLimit.upsert({ where: { playerId: player.id }, create: { playerId: player.id, ownerDailyLossLimit: used + limit }, update: { ownerDailyLossLimit: used + limit } });
  }
  const before = new Map(await Promise.all(group.map(async (player) => [player.id, await limits.usedToday(player.id)])));
  const start = performance.now();
  await Promise.all(group.map((player) => Promise.all(Array.from({ length: 40 }, (_, i) => ROUND[["dice", "coinflip", "scratch", "keno"][i % 4]](player).catch(() => undefined)))));
  let broken = 0;
  for (const player of group) {
    const used = await limits.usedToday(player.id);
    if (used - before.get(player.id) > limit + 0.001) broken++;
  }
  for (const key of [...errors.keys()]) if (key.includes("daily loss limit")) errors.delete(key);
  if (broken) note(errors, `loss limit: ${broken} Players went past their daily loss limit`, 1);
  report("3. 10 Players with a 1,000 ALL daily loss limit, 40 rounds sent at once each", (performance.now() - start) / 1000);
  await prisma.bettingLimit.deleteMany({ where: { playerId: { in: group.map((player) => player.id) } } });
}

async function check(players) {
  // The money must add up: every balance equals its ledger, nothing below zero, every round in the journal, no seed nonce used twice.
  const problems = [];
  const ids = players.map((player) => player.id);
  const balances = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, balance: true } })).map((row) => [row.id, Number(row.balance)]));
  const ledger = await prisma.$queryRaw`
    SELECT u.id, COALESCE(SUM(CASE WHEN t.to_user_id = u.id THEN t.amount ELSE -t.amount END), 0) AS total
    FROM users u LEFT JOIN balance_transactions t ON (t.to_user_id = u.id OR t.from_user_id = u.id) AND t.status = 'APPROVED'
    WHERE u.role = 'PLAYER' GROUP BY u.id`;
  const open = await prisma.$queryRaw`
    SELECT player_id AS id, SUM(staked) AS staked FROM (
      SELECT player_id, staked FROM blackjack_hands UNION ALL SELECT player_id, staked FROM mines_rounds UNION ALL SELECT player_id, staked FROM penalty_rounds
    ) o GROUP BY player_id`;
  const openBy = new Map(open.map((row) => [row.id, Number(row.staked)]));
  for (const row of ledger) {
    const balance = balances.get(row.id);
    if (balance === undefined) continue;
    if (balance < 0) problems.push(`${row.id}: balance below zero (${balance})`);
    if (Math.abs(Number(row.total) - balance) > 0.001) problems.push(`${row.id}: ledger ${Number(row.total)} but balance ${balance}`);
  }
  // Every finished round has its journal row with the same money.
  const [journal] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS rounds, COUNT(e.id)::int AS entries,
      COALESCE(SUM(s.stake), 0) AS spin_stake, COALESCE(SUM(e.stake), 0) AS entry_stake,
      COALESCE(SUM(s.win), 0) AS spin_win, COALESCE(SUM(e.payout), 0) AS entry_win
    FROM casino_spins s LEFT JOIN settlement_entries e ON e.casino_spin_id = s.id`;
  if (journal.rounds !== journal.entries) problems.push(`journal: ${journal.rounds} rounds but ${journal.entries} journal rows`);
  if (Number(journal.spin_stake) !== Number(journal.entry_stake) || Number(journal.spin_win) !== Number(journal.entry_win)) problems.push("journal: the money in the journal differs from the rounds");
  // Each provably fair round used its own nonce.
  const reused = await prisma.$queryRaw`
    SELECT COALESCE(dice, keno, coin, scratch)->>'seedId' AS seed, COALESCE(dice, keno, coin, scratch)->>'nonce' AS nonce, COUNT(*)::int AS times
    FROM casino_spins WHERE kind IN ('DICE', 'KENO', 'COIN_FLIP', 'SCRATCH')
    GROUP BY 1, 2 HAVING COUNT(*) > 1`;
  if (reused.length) problems.push(`seeds: ${reused.length} nonces used twice`);
  // Each game's line for the day adds up to that game's rounds, less what's still riding.
  const lines = await prisma.$queryRaw`SELECT to_user_id AS id, SUM(amount) AS amount FROM balance_transactions WHERE type = 'CASINO' GROUP BY to_user_id`;
  const rounds = new Map((await prisma.$queryRaw`SELECT player_id AS id, SUM(win - stake) AS net FROM casino_spins GROUP BY player_id`).map((row) => [row.id, Number(row.net)]));
  for (const row of lines) {
    const expected = (rounds.get(row.id) ?? 0) - (openBy.get(row.id) ?? 0);
    if (Math.abs(Number(row.amount) - expected) > 0.001) problems.push(`${row.id}: casino lines ${Number(row.amount)} but rounds ${expected}`);
  }
  const counts = await prisma.$queryRaw`SELECT kind, COUNT(*)::int AS n FROM casino_spins GROUP BY kind ORDER BY kind`;
  console.log(`\n4. Checks over ${counts.reduce((sum, row) => sum + row.n, 0)} rounds (${counts.map((row) => `${row.kind.toLowerCase()} ${row.n}`).join(", ")})`);
  console.log(problems.length ? problems.slice(0, 30).map((line) => `  ✗ ${line}`).join("\n") + (problems.length > 30 ? `\n  … and ${problems.length - 30} more` : "") : "  ✓ every balance matches its ledger, none below zero, every round in the journal, no nonce used twice, every day line adds up");
  return problems.length;
}

const players = await setup();
console.log(`Load test: ${players.length} Players, pool of ${POOL} connections`);
await crowd(players);
await tabs(players);
await lossLimit(players);
const problems = await check(players);
await prisma.$disconnect();
process.exit(problems ? 1 : 0);
