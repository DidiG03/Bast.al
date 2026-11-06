// The Casino's long money run: plays every game through its real service,
// against a real Postgres, as a Player, with real randomness and a mix of
// options (stakes, lines, risks, targets, picks, mines, cash-out points,
// double or nothing), and after each game checks the money:
//  - the balance moved by exactly what the game's rounds paid less what they took,
//  - the balance matches the Player's ledger,
//  - no round is left open, and nothing failed that shouldn't have.
// It prints what each game paid back over the run. Empties tables, so it only
// runs against a database whose name ends in "_test". Run after `nest build`:
//   DATABASE_URL=postgresql://…/bastal_test node scripts/casino-soak.mjs [rounds per game=2000]
// SOAK_ONLY="Hi-Lo,Tower" plays only the games named.
import { createRequire } from "node:module";
import { randomInt } from "node:crypto";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient } = require("@prisma/client");
const { CasinoService } = require("../dist/casino/casino.service.js");
const { BookService } = require("../dist/casino/book.service.js");
const { BlackjackService } = require("../dist/casino/blackjack.service.js");
const { RouletteService } = require("../dist/casino/roulette.service.js");
const { MinesService } = require("../dist/casino/mines.service.js");
const { PenaltyService } = require("../dist/casino/penalty.service.js");
const { PlinkoService } = require("../dist/casino/plinko.service.js");
const { DiceService } = require("../dist/casino/dice.service.js");
const { KenoService } = require("../dist/casino/keno.service.js");
const { CoinFlipService } = require("../dist/casino/coin-flip.service.js");
const { ScratchService } = require("../dist/casino/scratch.service.js");
const { HouseService } = require("../dist/casino/house.service.js");
const { HouseGamesService } = require("../dist/casino/house-games.service.js");
const { BettingLimitsService } = require("../dist/commissions/betting-limits.service.js");
const { CommissionsService } = require("../dist/commissions/commissions.service.js");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const Roulette = require("../dist/casino/roulette.js");
const Hilo = require("../dist/casino/hilo.js");
const Crash = require("../dist/casino/crash.js");

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
process.env.HOUSE_SWEEP_DISABLED = "true";
const ROUNDS = Number(process.argv[2] ?? 2000);

const prisma = new PrismaClient();
const notifications = { create: async (n) => n };
const realtime = { publish: async () => undefined, publishBalances: async () => undefined };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const limits = new BettingLimitsService(prisma, hierarchy);
const commissions = new CommissionsService(prisma, hierarchy);
const casino = new CasinoService(prisma, limits, commissions, realtime, users, audit);
const book = new BookService(prisma, limits, realtime, users, audit);
const blackjack = new BlackjackService(prisma, limits, realtime, users);
const roulette = new RouletteService(prisma, limits, realtime, users, audit);
const mines = new MinesService(prisma, limits, realtime, users);
const penalty = new PenaltyService(prisma, limits, realtime, users);
const plinko = new PlinkoService(prisma, limits, realtime, users, audit);
const dice = new DiceService(prisma, limits, realtime, users, audit);
const keno = new KenoService(prisma, limits, realtime, users, audit);
const coin = new CoinFlipService(prisma, limits, realtime, users);
const scratch = new ScratchService(prisma, limits, realtime, users, audit);
const house = new HouseService(prisma, limits, realtime, users);
const games = new HouseGamesService(house);

const pick = (list) => list[randomInt(list.length)];
const STAKES = [50, 100, 250, 500, 1000, 2500];
const problems = [];
const report = [];

async function balanceOf(id) {
  return Number((await prisma.user.findUniqueOrThrow({ where: { id } })).balance);
}
async function ledgerTotal(id) {
  const rows = await prisma.balanceTransaction.findMany({ where: { OR: [{ toUserId: id }, { fromUserId: id }], status: "APPROVED" } });
  return Math.round(rows.reduce((sum, row) => sum + (row.toUserId === id ? Number(row.amount) : -Number(row.amount)), 0) * 100) / 100;
}
async function playsOf(id, kinds) {
  const rows = await prisma.casinoSpin.findMany({ where: { playerId: id, kind: { in: kinds } }, select: { stake: true, win: true } });
  return { n: rows.length, stake: rows.reduce((s, r) => s + Number(r.stake), 0), win: rows.reduce((s, r) => s + Number(r.win), 0) };
}
const round2 = (x) => Math.round(x * 100) / 100;

let player;
let n = 0;
async function user(role, parentId, extra = {}) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_soak${n}`, username: `soak${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `soak${n}`, role, parentId, ...extra } });
}

/** Plays one game `rounds` times, then checks its money. `kinds` are the CasinoPlayKind rows it writes. */
/** Only these games, when SOAK_ONLY lists them (comma-separated names, e.g. "Hi-Lo,Tower"). */
const ONLY = process.env.SOAK_ONLY ? process.env.SOAK_ONLY.split(",").map((name) => name.trim()) : null;

async function run(name, kinds, rounds, playOne) {
  if (ONLY && !ONLY.includes(name)) return;
  const before = await balanceOf(player.id);
  const playsBefore = await playsOf(player.id, kinds);
  let failures = 0;
  const started = Date.now();
  for (let i = 0; i < rounds; i++) {
    try {
      await playOne(i);
    } catch (err) {
      failures++;
      if (failures <= 3) problems.push(`${name}: round ${i} failed: ${err.message}`);
    }
  }
  const after = await balanceOf(player.id);
  const plays = await playsOf(player.id, kinds);
  const stake = plays.stake - playsBefore.stake;
  const win = plays.win - playsBefore.win;
  const moved = round2(after - before);
  const recorded = round2(win - stake);
  if (Math.abs(moved - recorded) > 0.005) problems.push(`${name}: the balance moved ${moved}, the rounds recorded ${recorded}.`);
  const ledger = await ledgerTotal(player.id);
  if (Math.abs(ledger - after) > 0.005) problems.push(`${name}: the balance is ${after}, the ledger says ${ledger}.`);
  if (after < 0) problems.push(`${name}: the balance went below zero (${after}).`);
  const open = await prisma.casinoRound.count({ where: { playerId: player.id } });
  if (open) problems.push(`${name}: ${open} round(s) left open.`);
  if (failures) problems.push(`${name}: ${failures} of ${rounds} rounds failed.`);
  const line = `${name.padEnd(14)} ${String(plays.n - playsBefore.n).padStart(6)} rows  staked ${stake.toFixed(0).padStart(10)}  paid ${win.toFixed(0).padStart(10)}  back ${stake ? ((win / stake) * 100).toFixed(2) : "–"}%  (${((Date.now() - started) / 1000).toFixed(0)}s)`;
  report.push(line);
  console.log(line);
}

async function main() {
  for (const table of ["settlement_entries", "commission_payouts", "balance_transactions", "casino_rounds", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "dice_seeds", "betting_limits", "bet_legs", "bets", "notifications", "audit_logs", "idempotency_keys", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { casinoEnabled: false, casinoGamesOff: [] } });
  const sa = await user("SUPER_ADMIN", null);
  const owner = await user("OWNER", sa.id, { commissionRate: 10, balance: 1e9 });
  const manager = await user("MANAGER", owner.id, { commissionRate: 20, balance: 1e9 });
  player = await user("PLAYER", manager.id, { balance: 0 });
  await prisma.balanceTransaction.create({ data: { fromUserId: manager.id, toUserId: player.id, actorId: manager.id, type: "DELEGATION", amount: 50_000_000, reason: "Soak" } });
  await prisma.user.update({ where: { id: player.id }, data: { balance: 50_000_000 } });
  await casino.setOpen(sa, true);
  await casino.setOpen(owner, true);

  await run("Sizzling Hot", ["SPIN", "GAMBLE"], ROUNDS, async () => {
    const spin = await casino.spin(player, pick(STAKES), pick([5, 10]));
    // Double or nothing now and then: up to 3 guesses.
    if (spin.gamble && randomInt(4) === 0) {
      for (let g = 0; g < 3; g++) {
        const res = await casino.gamble(player, pick(["RED", "BLACK"]));
        if (!res.won || !res.next) break;
      }
    }
    await casino.collect(player).catch(() => undefined);
  });

  await run("Book of Ra", ["BOOK", "GAMBLE"], ROUNDS, async () => {
    await book.spin(player, pick(STAKES));
  });
  // Free spins still owed are played out.
  for (let guard = 0; guard < 500; guard++) {
    const owed = await prisma.casinoFreeSpins.findFirst({ where: { playerId: player.id, remaining: { gt: 0 } } });
    if (!owed) break;
    await book.spin(player, Number(owed.bet));
  }

  await run("Roulette", ["ROULETTE"], ROUNDS, async () => {
    const spots = [...Roulette.SPOTS.keys()];
    const count = 1 + randomInt(6);
    const chosen = new Set();
    while (chosen.size < count) chosen.add(pick(spots));
    await roulette.spin(player, [...chosen].map((spot) => ({ spot, amount: pick([50, 100, 250]) })));
  });

  await run("Blackjack", ["BLACKJACK"], ROUNDS, async () => {
    let view = await blackjack.deal(player, pick(STAKES));
    let round = view.round ?? view;
    for (let step = 0; step < 12 && round.phase !== "DONE"; step++) {
      const moves = round.allowed;
      let move;
      if (moves.includes("noInsurance")) move = randomInt(5) === 0 ? "insure" : "noInsurance";
      else {
        const total = round.hands[round.active].total;
        move = moves.includes("split") && randomInt(2) === 0 ? "split" : moves.includes("double") && total >= 9 && total <= 11 ? "double" : total < 17 ? "hit" : "stand";
      }
      view = await blackjack.act(player, move);
      round = view.round ?? view;
    }
  });

  await run("Mines", ["MINES"], ROUNDS, async () => {
    const count = pick([5, 10, 15, 20, 24]);
    let { round } = await mines.start(player, pick(STAKES), count);
    const want = 1 + randomInt(Math.min(6, 25 - count));
    const order = Array.from({ length: 25 }, (_, t) => t).sort(() => Math.random() - 0.5);
    for (let k = 0; k < want && round.phase === "PLAY"; k++) ({ round } = await mines.open(player, order[k]));
    if (round.phase === "PLAY") await mines.collect(player);
  });

  await run("Penalty", ["PENALTY"], ROUNDS, async () => {
    let { round } = await penalty.start(player, pick(STAKES));
    const want = 1 + randomInt(4);
    for (let k = 0; k < want && round.phase === "PLAY"; k++) ({ round } = await penalty.shoot(player, pick(["LEFT", "CENTER", "RIGHT"])));
    if (round.phase === "PLAY") await penalty.collect(player);
  });

  await run("Plinko", ["PLINKO"], ROUNDS, () => plinko.drop(player, pick(STAKES), pick([8, 12, 16]), pick(["LOW", "MEDIUM", "HIGH"])));
  await run("Dice", ["DICE"], ROUNDS, () => {
    const direction = pick(["UNDER", "OVER"]);
    const target = direction === "UNDER" ? 1 + randomInt(83) + randomInt(100) / 100 : 16 + randomInt(83) + randomInt(100) / 100;
    return dice.roll(player, pick(STAKES), Math.round(target * 100) / 100, direction);
  });
  await run("Keno", ["KENO"], ROUNDS, () => {
    const picks = new Set();
    const want = 1 + randomInt(10);
    while (picks.size < want) picks.add(1 + randomInt(80));
    return keno.play(player, pick(STAKES), [...picks]);
  });
  await run("Coin Flip", ["COIN_FLIP"], ROUNDS, () => coin.flip(player, pick(STAKES), pick(["HEADS", "TAILS"])));
  await run("Scratch", ["SCRATCH"], ROUNDS, () => scratch.buy(player, pick(STAKES)));
  await run("Money Wheel", ["WHEEL"], ROUNDS, () => games.wheelSpin(player, pick(STAKES), pick(["LOW", "MEDIUM", "HIGH"])));
  await run("Baccarat", ["BACCARAT"], ROUNDS, () => games.baccaratDeal(player, pick(STAKES), pick(["PLAYER", "BANKER", "TIE"])));

  await run("Hi-Lo", ["HILO"], ROUNDS, async () => {
    let { round } = await games.hiloStart(player, pick(STAKES));
    const want = 1 + randomInt(4);
    let rights = 0;
    for (let k = 0; k < 10 && round.phase === "PLAY" && rights < want; k++) {
      const choice = round.higher.chance >= round.lower.chance ? (round.higher.chance === 100 ? "SKIP" : "HIGHER") : round.lower.chance === 100 ? "SKIP" : "LOWER";
      ({ round } = await games.hiloGuess(player, choice));
      if (choice !== "SKIP" && round.phase !== "LOST") rights++;
    }
    if (round.phase === "PLAY" && round.canCashOut) await games.hiloCashOut(player);
    else if (round.phase === "PLAY") {
      // Nothing right yet (only skips): one real guess, then cash out if it came good.
      ({ round } = await games.hiloGuess(player, round.higher.chance >= round.lower.chance ? "HIGHER" : "LOWER"));
      if (round.phase === "PLAY") await games.hiloCashOut(player);
    }
  });

  await run("Tower", ["TOWER"], ROUNDS, async () => {
    const level = pick(["EASY", "MEDIUM", "HARD", "EXPERT"]);
    const doors = { EASY: 4, MEDIUM: 3, HARD: 2, EXPERT: 3 }[level];
    let { round } = await games.towerStart(player, pick(STAKES), level);
    const want = 1 + randomInt(8);
    for (let k = 0; k < want && round.phase === "PLAY"; k++) ({ round } = await games.towerClimb(player, randomInt(doors)));
    if (round.phase === "PLAY") await games.towerCashOut(player);
  });

  // Crash on a moved clock: a start, then a check far enough on to settle it (an automatic cash-out or the crash).
  let clock = Date.now();
  house.now = () => clock;
  await run("Crash", ["CRASH"], ROUNDS, async () => {
    const auto = pick([1.01, 1.5, 2, 3, 10, 100]);
    const start = await games.crashStart(player, pick(STAKES), auto);
    if (start.round.phase === "PLAY") {
      clock += Crash.msToReach(Math.round(auto * 100)) + 50;
      const res = await games.crashCheck(player);
      if (res.round.phase === "PLAY") {
        clock += 10 * 60 * 1000;
        await games.crashCheck(player);
      }
    }
    clock += 1000;
  });
  // And by hand: cash out at a moment a little way into the climb.
  await run("Crash (manual)", ["CRASH"], Math.round(ROUNDS / 2), async () => {
    const start = await games.crashStart(player, pick(STAKES), null);
    if (start.round.phase === "PLAY") {
      clock += 200 + randomInt(15000);
      await games.crashCashOut(player).catch(async () => games.crashCheck(player));
      const left = await prisma.casinoRound.count({ where: { playerId: player.id } });
      if (left) {
        clock += 3_600_000;
        await games.crashCheck(player);
      }
    }
    clock += 1000;
  });

  const balance = await balanceOf(player.id);
  const ledger = await ledgerTotal(player.id);
  console.log(`\nPlayer's balance ${balance}, ledger ${ledger}${Math.abs(balance - ledger) > 0.005 ? "  ← DIFFERENT" : ""}`);
  console.log(problems.length ? `\nProblems:\n  ${problems.join("\n  ")}` : "\nNo problems.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
