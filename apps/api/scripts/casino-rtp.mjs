// Plays the casino slot many times, exactly as the API does, and prints how
// much it pays back. Run after `nest build`:
//   node scripts/casino-rtp.mjs [rounds=10000000] [seed=1]
// Double or nothing isn't played here: it's an even 50/50, so it doesn't
// change what spins pay back on average.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SeededRandomNumberGenerator } = require("pokie");
const { LINES, playRound } = require("../dist/casino/game.js");

const rounds = Number(process.argv[2] ?? 10_000_000);
const rng = new SeededRandomNumberGenerator(Number(process.argv[3] ?? 1));

let won = 0;
let wonFromStars = 0;
let hits = 0;
let starWins = 0;
let biggest = 0;
const started = Date.now();

for (let i = 0; i < rounds; i++) {
  const round = playRound(rng);
  if (round.win > 0) hits++;
  if (round.scatter) {
    starWins++;
    wonFromStars += round.scatter.win;
  }
  won += round.win;
  biggest = Math.max(biggest, round.win);
}

const staked = rounds * LINES;
const pct = (value) => `${(value * 100).toFixed(2)}%`;
console.log(`Rounds played:        ${rounds.toLocaleString("en")} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
console.log(`Payout rate:          ${pct(won / staked)}`);
console.log(`  from stars:         ${pct(wonFromStars / staked)}`);
console.log(`Spins that win:       ${pct(hits / rounds)} (1 in ${(rounds / hits).toFixed(1)})`);
console.log(`Stars pay:            1 in ${Math.round(rounds / Math.max(starWins, 1))} spins`);
console.log(`Biggest single spin:  ${(biggest / LINES).toFixed(1)}x the bet`);
