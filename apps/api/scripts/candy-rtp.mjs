// Candy Cascade's payout rate, by simulation: `node scripts/candy-rtp.mjs [rounds] [seed]`
// after `nest build` (it plays the rules in dist/casino/candy.js, exactly as the API does).
// Each round is a paid spin with every free spin it gives. Prints the payout rate with its
// standard error, how much of it the free spins make, how often they come, and the biggest win.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Candy = require(process.env.CANDY_JS ?? "../dist/casino/candy.js");

const rounds = Number(process.argv[2] ?? 2_000_000);
const seed = Number(process.argv[3] ?? 7);

/** A repeatable random draw (mulberry32). */
function seeded(start) {
  let a = start >>> 0;
  return (below) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
  };
}

const draw = seeded(seed);
let paid = 0;
let squares = 0;
let fromFree = 0;
let features = 0;
let freeSpins = 0;
let hits = 0;
let capped = 0;
let biggest = 0;
const started = Date.now();
for (let i = 0; i < rounds; i++) {
  const round = Candy.play(draw);
  const x = round.win / 100;
  paid += x;
  squares += x * x;
  if (round.win > 0) hits++;
  if (round.capped) capped++;
  if (x > biggest) biggest = x;
  if (round.spins.length > 1) {
    features++;
    freeSpins += round.spins.length - 1;
    // What the free spins added (the round's win less the paid spin's own), after the cap.
    fromFree += Math.max(0, x - round.spins[0].win / 100);
  }
}
const mean = paid / rounds;
const se = Math.sqrt((squares / rounds - mean * mean) / rounds);
const pct = (v) => `${(v * 100).toFixed(2)}%`;
console.log(`${rounds.toLocaleString()} rounds in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`payout rate ${pct(mean)} ± ${pct(se)} (1 standard error); the rules say ${Candy.PAYOUT_RATE}%`);
console.log(`  paid spins ${pct((paid - fromFree) / rounds)}, free spins ${pct(fromFree / rounds)}`);
console.log(`  a win in ${pct(hits / rounds)} of rounds; free spins 1 in ${(rounds / Math.max(1, features)).toFixed(0)}, ${(freeSpins / Math.max(1, features)).toFixed(1)} spins and ${(fromFree / Math.max(1, features)).toFixed(1)}× the bet on average`);
console.log(`  biggest round ${biggest.toFixed(2)}× the bet; ${capped} reached the ${Candy.MAX_WIN}× cap`);
