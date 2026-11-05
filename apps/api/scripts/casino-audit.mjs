// Audits every Casino game's maths, through the very code the API plays, and
// prints what each one pays back: worked out exactly where the odds allow,
// and measured over long simulated runs where they don't (or as a check on
// the exact figure). Flags anything that pays back more than its game says,
// any rule that breaks along the way, and rounding that drifts.
// Run after `nest build`:
//   node scripts/casino-audit.mjs [scale=1]
// scale multiplies the simulated rounds (1 is a few minutes in all).
// Sizzling Hot, Book of Ra and Blackjack have their own longer scripts
// (casino-rtp.mjs, book-rtp.mjs, blackjack-rtp.mjs); Sizzling Hot is also
// worked out exactly here, over every stop of its five reels.
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const Dice = require("../dist/casino/dice.js");
const Coin = require("../dist/casino/coin-flip.js");
const Keno = require("../dist/casino/keno.js");
const Plinko = require("../dist/casino/plinko.js");
const Scratch = require("../dist/casino/scratch.js");
const Roulette = require("../dist/casino/roulette.js");
const Mines = require("../dist/casino/mines.js");
const Penalty = require("../dist/casino/penalty.js");
const Wheel = require("../dist/casino/wheel.js");
const Baccarat = require("../dist/casino/baccarat.js");
const Hilo = require("../dist/casino/hilo.js");
const Tower = require("../dist/casino/tower.js");
const Crash = require("../dist/casino/crash.js");
const Slot = require("../dist/casino/game.js");

const scale = Number(process.argv[2] ?? 1);
const N = (n) => Math.round(n * scale);

/** A seeded draw (mulberry32): draw(n) is a whole number from 0 up to n. */
function seeded(seed) {
  let state = seed >>> 0;
  return (below) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
  };
}

const findings = [];
const pct = (x) => `${(x * 100).toFixed(3)}%`;
const section = (title) => console.log(`\n=== ${title} ===`);
/** Records a problem: `level` is "BUG" (wrong), "LEAK" (pays back more than it says) or "NOTE". */
const flag = (level, game, text) => {
  findings.push({ level, game, text });
  console.log(`  !! ${level} ${game}: ${text}`);
};
/** Payback measured over `n` rounds should be within `sigmas` standard errors of `expected`. */
function checkSim(game, label, paid, staked, sq, n, expected, sigmas = 4) {
  const mean = paid / staked;
  const perRound = paid / n / (staked / n);
  const variance = sq / n / (staked / n) ** 2 - perRound ** 2;
  const se = Math.sqrt(Math.max(variance, 0) / n);
  const z = (mean - expected) / (se || 1e-12);
  console.log(`  ${label.padEnd(34)} simulated ${pct(mean)} ± ${pct(se)}  (exact ${pct(expected)}, z ${z.toFixed(2)})`);
  if (Math.abs(z) > sigmas) flag("BUG", game, `${label}: simulated ${pct(mean)} is ${z.toFixed(1)} standard errors from the exact ${pct(expected)}.`);
}

// ——— Dice ———
section("Dice");
{
  let worst = 0;
  let best = 1;
  for (const direction of Dice.DIRECTIONS) {
    for (let target = 0; target < Dice.OUTCOMES; target++) {
      if (Dice.invalidTarget(target, direction)) continue;
      const winning = Dice.winningNumbers(target, direction);
      // Exact, cents included: the stake is the smallest chip.
      const rtp = ((winning / Dice.OUTCOMES) * Dice.winCents(5000, winning)) / 5000;
      worst = Math.max(worst, rtp);
      best = Math.min(best, rtp);
      // The winning numbers counted must be the rolls that actually win.
      if (target % 997 === 0) {
        let count = 0;
        for (let roll = 0; roll < Dice.OUTCOMES; roll++) if (Dice.wins(roll, target, direction)) count++;
        if (count !== winning) flag("BUG", "Dice", `target ${target} ${direction}: ${count} rolls win, the pay is worked out for ${winning}.`);
      }
    }
  }
  console.log(`  every target, both sides: payback from ${pct(best)} to ${pct(worst)} (stake 50 ALL)`);
  if (worst > 0.85 + 1e-9) flag("LEAK", "Dice", `a target pays back ${pct(worst)}, over 85%.`);
  // The roll from the seeds: every outcome about as likely.
  const counts = new Uint32Array(Dice.OUTCOMES);
  const rolls = N(2_000_000);
  const server = randomBytes(32).toString("hex");
  for (let i = 0; i < rolls; i++) counts[Dice.rollFor(server, "audit", i)]++;
  const expected = rolls / Dice.OUTCOMES;
  const chi = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
  const zChi = (chi - (Dice.OUTCOMES - 1)) / Math.sqrt(2 * (Dice.OUTCOMES - 1));
  console.log(`  ${rolls.toLocaleString("en")} seeded rolls: chi-square ${chi.toFixed(0)} on ${Dice.OUTCOMES - 1} degrees of freedom (z ${zChi.toFixed(2)})`);
  if (Math.abs(zChi) > 5) flag("BUG", "Dice", "rolls from the seeds aren't evenly spread.");
}

// ——— Coin Flip ———
section("Coin Flip");
{
  const flips = N(2_000_000);
  const server = randomBytes(32).toString("hex");
  let heads = 0;
  for (let i = 0; i < flips; i++) if (Coin.flipFor(server, "audit", i) === "HEADS") heads++;
  const share = heads / flips;
  const exact = (0.5 * Coin.winCents(5000)) / 5000;
  console.log(`  exact payback ${pct(exact)}; heads came up ${pct(share)} of ${flips.toLocaleString("en")} flips`);
  if (exact > 0.85 + 1e-9) flag("LEAK", "Coin Flip", `pays back ${pct(exact)}.`);
  if (Math.abs(share - 0.5) > 5 * Math.sqrt(0.25 / flips)) flag("BUG", "Coin Flip", `heads came up ${pct(share)} of the time.`);
}

// ——— Keno ———
section("Keno");
{
  for (let picks = 1; picks <= 10; picks++) {
    let exact = 0;
    for (let hits = 0; hits <= picks; hits++) exact += Keno.chanceOf(picks, hits) * (Keno.winCents(5000, picks, hits) / 5000);
    console.log(`  ${String(picks).padStart(2)} picks: exact payback ${pct(exact)}`);
    if (exact > 0.85 + 1e-6) flag("LEAK", "Keno", `${picks} picks pay back ${pct(exact)}.`);
  }
  // The draw: 20 different numbers, every number as likely; hits as the odds say.
  const rounds = N(300_000);
  const server = randomBytes(32).toString("hex");
  const seen = new Uint32Array(81);
  const picks = [3, 17, 25, 40, 41, 58, 66, 70, 77, 80];
  let paid = 0;
  let sq = 0;
  for (let i = 0; i < rounds; i++) {
    const drawn = Keno.drawFor(server, "audit", i);
    if (new Set(drawn).size !== Keno.DRAWN || drawn.some((n) => n < 1 || n > Keno.NUMBERS)) {
      flag("BUG", "Keno", `draw ${i} isn't 20 different numbers from 1 to 80.`);
      break;
    }
    for (const n of drawn) seen[n]++;
    const win = Keno.winCents(5000, picks.length, Keno.hitsOf(picks, drawn).length) / 5000;
    paid += win;
    sq += win * win;
  }
  const exact10 = Array.from({ length: 11 }, (_, h) => Keno.chanceOf(10, h) * (Keno.winCents(5000, 10, h) / 5000)).reduce((a, b) => a + b, 0);
  checkSim("Keno", "10 picks, seeded draws", paid, rounds, sq, rounds, exact10);
  const per = (rounds * Keno.DRAWN) / Keno.NUMBERS;
  const chi = seen.slice(1).reduce((sum, c) => sum + (c - per) ** 2 / per, 0);
  console.log(`  every number drawn about as often: chi-square ${chi.toFixed(1)} on 79 degrees of freedom`);
  if (chi > 79 + 6 * Math.sqrt(158)) flag("BUG", "Keno", "some numbers are drawn more often than others.");
}

// ——— Plinko ———
section("Plinko");
{
  for (const rows of Plinko.ROWS) {
    for (const risk of Plinko.RISKS) {
      const table = Plinko.payTable(rows, risk);
      const exact = Plinko.bucketChances(rows).reduce((sum, chance, bucket) => sum + chance * (Plinko.winCents(5000, table[bucket]) / 5000), 0);
      console.log(`  ${String(rows).padStart(2)} rows ${risk.padEnd(6)}: exact payback ${pct(exact)}, top ${table[0]}×`);
      if (exact > 0.85 + 1e-6) flag("LEAK", "Plinko", `${rows} rows ${risk} pays back ${pct(exact)}.`);
    }
  }
  const draw = seeded(11);
  const balls = N(2_000_000);
  let paid = 0;
  let sq = 0;
  for (let i = 0; i < balls; i++) {
    const drop = Plinko.dropBall(16, "HIGH", draw);
    if (drop.bucket !== drop.path.reduce((a, b) => a + b, 0)) flag("BUG", "Plinko", "a ball's bucket doesn't match its path.");
    const win = Plinko.winCents(5000, drop.multiplier) / 5000;
    paid += win;
    sq += win * win;
  }
  const exact = Plinko.bucketChances(16).reduce((sum, chance, bucket) => sum + chance * (Plinko.winCents(5000, Plinko.payTable(16, "HIGH")[bucket]) / 5000), 0);
  checkSim("Plinko", "16 rows HIGH, simulated balls", paid, balls, sq, balls, exact);
}

// ——— Scratch ———
section("Scratch Cards");
{
  const exact = Scratch.payoutRate() / 100;
  console.log(`  exact payback ${pct(exact)}, a winning card ${Scratch.winChance().toFixed(2)}% of the time`);
  if (exact > 0.85 + 1e-9) flag("LEAK", "Scratch", `pays back ${pct(exact)}.`);
  const cards = N(400_000);
  const server = randomBytes(32).toString("hex");
  const prizeCount = new Map();
  let paid = 0;
  let sq = 0;
  for (let i = 0; i < cards; i++) {
    const card = Scratch.cardFor(server, "audit", i);
    const tally = new Map();
    for (const s of card.cells) tally.set(s, (tally.get(s) ?? 0) + 1);
    const triples = [...tally.entries()].filter(([, c]) => c >= 3).map(([s]) => s);
    if (card.cells.length !== 9) flag("BUG", "Scratch", `card ${i} has ${card.cells.length} boxes.`);
    if (card.symbol === null ? triples.length !== 0 : triples.length !== 1 || triples[0] !== card.symbol || tally.get(card.symbol) !== 3) {
      flag("BUG", "Scratch", `card ${i} shows ${JSON.stringify([...tally])} but pays ${card.symbol ?? "nothing"}.`);
      break;
    }
    prizeCount.set(card.symbol, (prizeCount.get(card.symbol) ?? 0) + 1);
    paid += card.multiplier;
    sq += card.multiplier ** 2;
  }
  checkSim("Scratch", "seeded cards", paid, cards, sq, cards, exact);
  for (const prize of Scratch.PRIZES) {
    const expectedCount = (cards * prize.odds) / Scratch.ODDS_OUT_OF;
    const got = prizeCount.get(prize.symbol) ?? 0;
    if (expectedCount > 50 && Math.abs(got - expectedCount) > 5 * Math.sqrt(expectedCount)) flag("BUG", "Scratch", `${prize.symbol} won ${got} times, expected about ${expectedCount.toFixed(0)}.`);
  }
}

// ——— Roulette ———
section("Roulette");
{
  let worst = 0;
  const chips = [50, 100, 250, 500, 1000, 2500];
  for (const [spot, numbers] of Roulette.SPOTS) {
    for (const chip of chips) {
      let back = 0;
      for (let number = 0; number <= 36; number++) back += Roulette.settle([{ spot, amount: chip }], number).win;
      const rtp = back / 37 / chip;
      worst = Math.max(worst, rtp);
      const fair = 36 / 37;
      if (Math.abs(rtp - fair) > 1e-9) flag("BUG", "Roulette", `${spot} (${numbers.length} numbers) with ${chip} ALL pays back ${pct(rtp)}, not 36/37.`);
    }
  }
  console.log(`  every spot (${Roulette.SPOTS.size}) with every chip: payback ${pct(worst)} (36/37 is ${pct(36 / 37)})`);
  // The wheel: every pocket once, and the table's numbers in order.
  if (new Set(Roulette.WHEEL).size !== 37) flag("BUG", "Roulette", "the wheel doesn't have 37 different pockets.");
  const reds = Roulette.RED_NUMBERS.length;
  if (reds !== 18) flag("BUG", "Roulette", `${reds} red numbers.`);
  // A full-table bet (many spots at once) adds up to the same rate.
  const all = [...Roulette.SPOTS.keys()].slice(0, Roulette.MAX_SPOTS).map((spot) => ({ spot, amount: 50 }));
  let back = 0;
  let staked = 0;
  for (let number = 0; number <= 36; number++) {
    const r = Roulette.settle(all, number);
    back += r.win;
    staked = r.staked;
  }
  console.log(`  ${all.length} spots covered at once: payback ${pct(back / 37 / staked)}`);
}

// ——— Mines ———
section("Mines");
{
  for (const mines of Mines.MINE_COUNTS) {
    const safe = Mines.TILES - mines;
    const rows = [];
    let survive = 1;
    let worst = { rtp: 0, opened: 0 };
    for (let opened = 1; opened <= safe; opened++) {
      survive *= (safe - (opened - 1)) / (Mines.TILES - (opened - 1));
      const rtp = (survive * Mines.payoutCents(5000, mines, opened)) / 5000;
      rows.push(`${opened}:${(rtp * 100).toFixed(1)}`);
      if (rtp > worst.rtp) worst = { rtp, opened };
    }
    console.log(`  ${String(mines).padStart(2)} mines: best cash-out pays back ${pct(worst.rtp)} (after ${worst.opened} tile${worst.opened > 1 ? "s" : ""}); by tiles ${rows.slice(0, 8).join(" ")}${rows.length > 8 ? " …" : ""}`);
    if (worst.rtp > 0.85 + 1e-6) flag("LEAK", "Mines", `${mines} mine${mines > 1 ? "s" : ""}: cashing out after ${worst.opened} tile${worst.opened > 1 ? "s" : ""} pays back ${pct(worst.rtp)}.`);
    // The multiplier never goes down as tiles open.
    for (let opened = 2; opened <= safe; opened++) {
      if (Mines.multiplierHundredths(mines, opened) < Mines.multiplierHundredths(mines, opened - 1)) flag("BUG", "Mines", `${mines} mines: the multiplier drops after tile ${opened}.`);
    }
  }
  // Played through the real rules: 5 mines, random tiles, cash out after 3.
  const draw = seeded(5);
  const rounds = N(500_000);
  let paid = 0;
  let sq = 0;
  for (let i = 0; i < rounds; i++) {
    let round = Mines.startRound(5000, 5, draw);
    if (new Set(round.mineTiles).size !== 5) flag("BUG", "Mines", "a field doesn't have 5 different mines.");
    const order = Array.from({ length: Mines.TILES }, (_, t) => t);
    for (let k = order.length - 1; k > 0; k--) {
      const j = draw(k + 1);
      [order[k], order[j]] = [order[j], order[k]];
    }
    for (let k = 0; k < 3 && round.phase === "PLAY"; k++) round = Mines.reveal(round, order[k]);
    if (round.phase === "PLAY") round = Mines.cashOut(round);
    const win = round.payout / 5000;
    paid += win;
    sq += win * win;
  }
  let survive = 1;
  for (let k = 0; k < 3; k++) survive *= (20 - k) / (25 - k);
  checkSim("Mines", "5 mines, cash out after 3 tiles", paid, rounds, sq, rounds, (survive * Mines.payoutCents(5000, 5, 3)) / 5000);
}

// ——— Penalty ———
section("Penalty");
{
  const rows = [];
  let worst = 0;
  for (let goals = 1; goals <= 25; goals++) {
    const rtp = ((2 / 3) ** goals * Penalty.payoutCents(5000, goals)) / 5000;
    worst = Math.max(worst, rtp);
    if (goals <= 8) rows.push(`${goals}:${(rtp * 100).toFixed(1)}`);
  }
  console.log(`  cash out after n goals: ${rows.join(" ")} …  best ${pct(worst)}`);
  if (worst > 0.85 + 1e-6) flag("LEAK", "Penalty", `a cash-out pays back ${pct(worst)}.`);
  const draw = seeded(9);
  const rounds = N(500_000);
  let paid = 0;
  let sq = 0;
  let dives = [0, 0, 0];
  for (let i = 0; i < rounds; i++) {
    let round = Penalty.startRound(5000);
    for (let k = 0; k < 2 && round.phase === "PLAY"; k++) {
      round = Penalty.kick(round, Penalty.DIRECTIONS[i % 3], (n) => {
        const d = draw(n);
        dives[d]++;
        return d;
      });
    }
    if (round.phase === "PLAY") round = Penalty.cashOut(round);
    paid += round.payout / 5000;
    sq += (round.payout / 5000) ** 2;
  }
  checkSim("Penalty", "cash out after 2 goals", paid, rounds, sq, rounds, ((2 / 3) ** 2 * Penalty.payoutCents(5000, 2)) / 5000);
}

// ——— Money Wheel ———
section("Money Wheel");
{
  for (const risk of Wheel.RISKS) {
    const segments = Wheel.WHEELS[risk];
    if (segments.length !== Wheel.SEGMENT_COUNT) flag("BUG", "Money Wheel", `${risk} has ${segments.length} segments.`);
    const exact = segments.reduce((sum, m) => sum + Wheel.winCents(5000, m) / 5000, 0) / segments.length;
    const hit = segments.filter((m) => m > 0).length / segments.length;
    console.log(`  ${risk.padEnd(6)}: exact payback ${pct(exact)}, wins ${pct(hit)} of spins, top ${Math.max(...segments) / 100}×`);
    if (exact > Wheel.PAYOUT_RATE / 100 + 1e-9) flag("LEAK", "Money Wheel", `${risk} pays back ${pct(exact)}.`);
  }
}

// ——— Baccarat ———
section("Baccarat");
{
  const draw = seeded(21);
  const hands = N(3_000_000);
  const wins = { PLAYER: 0, BANKER: 0, TIE: 0 };
  const paid = { PLAYER: 0, BANKER: 0, TIE: 0 };
  const sq = { PLAYER: 0, BANKER: 0, TIE: 0 };
  for (let i = 0; i < hands; i++) {
    const hand = Baccarat.deal(draw);
    wins[hand.winner]++;
    for (const side of Baccarat.SIDES) {
      const p = Baccarat.payoutCents(5000, side, hand.winner) / 5000;
      paid[side] += p;
      sq[side] += p * p;
    }
  }
  // The known chances for 8 decks under the standard drawing rules.
  const known = { PLAYER: 0.446247, BANKER: 0.458597, TIE: 0.095156 };
  for (const side of Baccarat.SIDES) {
    const share = wins[side] / hands;
    const z = (share - known[side]) / Math.sqrt((known[side] * (1 - known[side])) / hands);
    console.log(`  ${side.padEnd(6)} wins ${pct(share)} (8-deck standard ${pct(known[side])}, z ${z.toFixed(2)})`);
    if (Math.abs(z) > 5) flag("BUG", "Baccarat", `${side} wins ${pct(share)}, the standard rules give ${pct(known[side])}.`);
  }
  const exact = {
    PLAYER: known.PLAYER * (1 + Math.floor(5000 * 0.47) / 5000) + known.TIE,
    BANKER: known.BANKER * (1 + Math.floor(5000 * 0.43) / 5000) + known.TIE,
    TIE: known.TIE * 8,
  };
  for (const side of Baccarat.SIDES) {
    checkSim("Baccarat", `bet on ${side}`, paid[side], hands, sq[side], hands, exact[side]);
    if (exact[side] > 0.762) flag("LEAK", "Baccarat", `${side} pays back ${pct(exact[side])}.`);
  }
}

// ——— Hi-Lo ———
section("Hi-Lo");
{
  // Any way of playing pays back at most 75%: the 75% is taken once, at the cash-out, from the fair price.
  for (const [label, target] of [["cash out after 1 right guess", 1], ["after 3", 3], ["after 6", 6]]) {
    const draw = seeded(31 + target);
    const rounds = N(400_000);
    let paid = 0;
    let sq = 0;
    for (let i = 0; i < rounds; i++) {
      let round = Hilo.startRound(5000, draw);
      let rights = 0;
      while (round.phase === "PLAY" && rights < target) {
        const rank = round.steps[round.steps.length - 1].card.rank;
        // Skip a dead card (a guess that can't lose), else take the likelier side.
        const choice = rank === 7 ? "SKIP" : Hilo.winningRanks(rank, "HIGHER") >= Hilo.winningRanks(rank, "LOWER") ? "HIGHER" : "LOWER";
        if (round.steps.length > Hilo.MAX_GUESSES) break;
        round = Hilo.guess(round, choice, draw);
        if (choice !== "SKIP" && round.phase !== "LOST") rights++;
      }
      if (round.phase === "PLAY" && rights > 0) round = Hilo.cashOut(round);
      const win = round.payout / 5000;
      paid += win;
      sq += win * win;
    }
    const mean = paid / rounds;
    console.log(`  ${label.padEnd(30)} simulated ${pct(mean)}`);
    if (mean > 0.75 + 4 * Math.sqrt((sq / rounds - mean * mean) / rounds)) flag("LEAK", "Hi-Lo", `${label} pays back ${pct(mean)}.`);
  }
}

// ——— Tower ———
section("Tower");
{
  for (const level of Tower.LEVELS) {
    const { doors, traps } = Tower.LEVEL_SHAPE[level];
    const p = (doors - traps) / doors;
    const parts = [];
    let worst = 0;
    for (let floors = 1; floors <= Tower.FLOORS; floors++) {
      const rtp = (p ** floors * Math.floor((5000 * Tower.multiplierHundredths(level, floors)) / 100)) / 5000;
      worst = Math.max(worst, rtp);
      parts.push(`${floors}:${(rtp * 100).toFixed(1)}`);
    }
    console.log(`  ${level.padEnd(6)} cash out after n floors: ${parts.join(" ")}`);
    if (worst > 0.75 + 1e-9) flag("LEAK", "Tower", `${level} pays back ${pct(worst)}.`);
  }
  const draw = seeded(41);
  const rounds = N(400_000);
  let paid = 0;
  let sq = 0;
  for (let i = 0; i < rounds; i++) {
    let round = Tower.startRound(5000, "MEDIUM", draw);
    for (let f = 0; f < 4 && round.phase === "PLAY"; f++) round = Tower.climb(round, draw(3));
    if (round.phase === "PLAY") round = Tower.cashOut(round);
    paid += round.payout / 5000;
    sq += (round.payout / 5000) ** 2;
  }
  checkSim("Tower", "MEDIUM, cash out after 4 floors", paid, rounds, sq, rounds, ((2 / 3) ** 4 * Math.floor((5000 * Tower.multiplierHundredths("MEDIUM", 4)) / 100)) / 5000);
}

// ——— Crash ———
section("Crash");
{
  const TWO32 = 4294967296;
  /** The exact chance the crash point is above `hundredths`, from the 2^32 values of u. */
  const above = (hundredths) => {
    // crash > X  ⇔  floor(75/u) ≥ X+1 (or the cap)  ⇔  u ≤ 75/(X+1).
    const limit = Crash.PAYOUT_RATE / (hundredths + 1);
    return Math.min(1, Math.floor(limit * TWO32) / TWO32);
  };
  const parts = [];
  let worst = 0;
  for (const auto of [101, 110, 150, 200, 300, 500, 1000, 10000, 100000, 499999]) {
    const rtp = (above(auto) * Math.floor((5000 * auto) / 100)) / 5000;
    worst = Math.max(worst, rtp);
    parts.push(`${auto / 100}×:${(rtp * 100).toFixed(2)}`);
  }
  console.log(`  automatic cash-out at: ${parts.join(" ")}`);
  if (worst > 0.75 + 1e-9) flag("LEAK", "Crash", `an automatic cash-out pays back ${pct(worst)}.`);
  const instant = 1 - above(100);
  console.log(`  crashes at 1.00× straight away ${pct(instant)} of rounds`);
  // Simulated rounds through the real rules, timed: auto at 2.00×.
  const draw = seeded(51);
  const rounds = N(2_000_000);
  let paid = 0;
  let sq = 0;
  for (let i = 0; i < rounds; i++) {
    let round = Crash.startRound(5000, 200, draw, 0);
    round = Crash.advance(round, Crash.msToReach(200) + 1);
    if (round.phase === "PLAY") round = Crash.advance(round, 1e12);
    paid += round.payout / 5000;
    sq += (round.payout / 5000) ** 2;
  }
  checkSim("Crash", "automatic cash-out at 2.00×", paid, rounds, sq, rounds, (above(200) * 10000) / 5000);
}

// ——— Sizzling Hot: exact, over every stop of the five reels ———
section("Sizzling Hot (exact, every reel stop)");
{
  const strips = Slot.REEL_STRIPS;
  const pays = Slot.LINE_PAYS;
  /** One line's win in line bets, the way pokie counts it: the run of the first symbol from the left. */
  const lineWin = (symbols) => {
    const first = symbols[0];
    if (first === Slot.SCATTER) return 0;
    let count = 1;
    while (count < 5 && symbols[count] === first) count++;
    return count >= 2 ? pays[first][count - 2] : 0;
  };
  const evaluate = (grid, lines) => {
    let win = 0;
    for (const shape of Slot.shapesFor(lines)) win += lineWin(shape.map((row, reel) => grid[reel][row]));
    let stars = 0;
    for (const column of grid) for (const s of column) if (s === Slot.SCATTER) stars++;
    if (stars >= 3) win += Slot.SCATTER_PAYS[Math.min(stars, 5)] * lines;
    return win;
  };
  const fiveSevens = (grid, lines) => Slot.shapesFor(lines).some((shape) => shape.every((row, reel) => grid[reel][row] === "SEVEN"));
  // First: the evaluator agrees with the real game, spin for spin.
  const { SeededRandomNumberGenerator } = require("pokie");
  const rng = new SeededRandomNumberGenerator(7);
  let disagree = 0;
  for (let i = 0; i < 200_000; i++) {
    const round = Slot.playRound(rng, 10);
    if (evaluate(round.grid, 10) !== round.win) disagree++;
  }
  if (disagree) flag("BUG", "Sizzling Hot", `the audit's evaluator and the game disagree on ${disagree} of 200,000 spins (the audit can't be exact).`);
  else console.log("  the audit's evaluator matches the game on 200,000 spins");
  // Exact, reel by reel: every reel stops anywhere on its strip with the same chance, independently of the
  // others, so the symbol on any row of a reel follows that strip's makeup, and stars on a reel follow its stops.
  // (The game lands again on five sevens on a line, about 1 spin in 70,000 and paying nothing there: left in, it
  // moves the figure by under 0.002%.)
  const share = strips.map((strip) => {
    const m = new Map();
    for (const s of strip) m.set(s, (m.get(s) ?? 0) + 1 / strip.length);
    return m;
  });
  const p = (reel, symbol) => share[reel].get(symbol) ?? 0;
  let perLine = 0;
  for (const symbol of Object.keys(pays)) {
    for (let count = 2; count <= 5; count++) {
      let chance = 1;
      for (let reel = 0; reel < count; reel++) chance *= p(reel, symbol);
      if (count < 5) chance *= 1 - p(count, symbol);
      perLine += chance * pays[symbol][count - 2];
    }
  }
  // Stars: how many each reel shows (0 to 3) over its stops, then all five reels together.
  let stars = [1];
  for (const strip of strips) {
    const dist = [0, 0, 0, 0];
    for (let stop = 0; stop < strip.length; stop++) {
      let k = 0;
      for (let row = 0; row < 3; row++) if (strip[(stop + row) % strip.length] === Slot.SCATTER) k++;
      dist[k] += 1 / strip.length;
    }
    const next = new Array(stars.length + 3).fill(0);
    stars.forEach((a, i) => dist.forEach((b, j) => (next[i + j] += a * b)));
    stars = next;
  }
  let starPay = 0;
  stars.forEach((chance, k) => {
    if (k >= 3) starPay += chance * Slot.SCATTER_PAYS[Math.min(k, 5)];
  });
  for (const lines of Slot.LINE_CHOICES) {
    const rtp = perLine + starPay;
    console.log(`  ${lines} lines: exact payback ${pct(rtp)} (lines ${pct(perLine)}, stars ${pct(starPay)}); the game says ${Slot.PAYOUT_RATE}%`);
    if (Math.abs(rtp * 100 - Slot.PAYOUT_RATE) > 0.15) flag("NOTE", "Sizzling Hot", `${lines} lines pay back ${pct(rtp)}; the game says ${Slot.PAYOUT_RATE}%.`);
    if (rtp > 0.86) flag("LEAK", "Sizzling Hot", `${lines} lines pay back ${pct(rtp)}.`);
  }
}

section("Findings");
if (findings.length === 0) console.log("  none");
for (const f of findings) console.log(`  ${f.level.padEnd(4)} ${f.game}: ${f.text}`);
