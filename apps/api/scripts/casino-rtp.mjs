// Plays the casino slot many times, exactly as the API does, and prints how
// much it pays back. Run after `nest build`:
//   node scripts/casino-rtp.mjs [rounds=10000000] [seed=1]
// A paid spin's free spins count towards that spin, so the payout rate is
// everything won divided by everything staked.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SeededRandomNumberGenerator } = require("pokie");
const { LINES, playRound } = require("../dist/casino/game.js");

const rounds = Number(process.argv[2] ?? 10_000_000);
const rng = new SeededRandomNumberGenerator(Number(process.argv[3] ?? 1));

let won = 0;
let wonInFreeSpins = 0;
let hits = 0;
let triggers = 0;
let freeSpinsPlayed = 0;
let biggest = 0;
const started = Date.now();

for (let i = 0; i < rounds; i++) {
  const paid = playRound(rng);
  let spinWin = paid.win;
  let freeSpins = paid.freeSpins;
  if (freeSpins > 0) triggers++;
  while (freeSpins > 0) {
    freeSpins--;
    freeSpinsPlayed++;
    const free = playRound(rng);
    spinWin += free.win;
    wonInFreeSpins += free.win;
    freeSpins += free.freeSpins;
  }
  if (paid.win > 0 || paid.freeSpins > 0) hits++;
  won += spinWin;
  biggest = Math.max(biggest, spinWin);
}

const staked = rounds * LINES;
const pct = (value) => `${(value * 100).toFixed(2)}%`;
console.log(`Rounds played:        ${rounds.toLocaleString("en")} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
console.log(`Payout rate:          ${pct(won / staked)}`);
console.log(`  from free spins:    ${pct(wonInFreeSpins / staked)}`);
console.log(`Spins that win:       ${pct(hits / rounds)} (1 in ${(rounds / hits).toFixed(1)})`);
console.log(`Free spins start:     1 in ${Math.round(rounds / Math.max(triggers, 1))} spins, ${(freeSpinsPlayed / Math.max(triggers, 1)).toFixed(1)} free spins on average`);
console.log(`Biggest single spin:  ${(biggest / LINES).toFixed(1)}x the bet`);
