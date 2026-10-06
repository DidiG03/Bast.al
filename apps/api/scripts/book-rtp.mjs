// Plays Book of Ra many times, exactly as the API does (each paid spin
// with the free spins it starts), and prints how much it pays back. Run
// after `nest build`:
//   node scripts/book-rtp.mjs [rounds=10000000] [seed=1]
// Double or nothing isn't played here: it's an even 50/50, so it doesn't
// change what spins pay back on average.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LINES, MAX_WIN, drawSpecial, roomLeft, spin } = require("../dist/casino/book.js");

const rounds = Number(process.argv[2] ?? 10_000_000);

/** A seeded draw (mulberry32), so a run can be repeated. */
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
const draw = seeded(Number(process.argv[3] ?? 1));

let won = 0;
let wonInFeature = 0;
let hits = 0;
let features = 0;
let retriggers = 0;
let capped = 0;
let biggest = 0;
const started = Date.now();

for (let i = 0; i < rounds; i++) {
  const first = spin(null, draw);
  let round = Math.min(first.win, roomLeft(0));
  if (first.win > 0) hits++;
  if (first.freeSpinsWon > 0) {
    features++;
    const special = drawSpecial(draw);
    let left = first.freeSpinsWon;
    while (left > 0 && roomLeft(round) > 0) {
      left--;
      const free = spin(special, draw);
      const paid = Math.min(free.win, roomLeft(round));
      round += paid;
      wonInFeature += paid;
      if (free.freeSpinsWon > 0) {
        left += free.freeSpinsWon;
        retriggers++;
      }
    }
    if (roomLeft(round) === 0) capped++;
  }
  won += round;
  biggest = Math.max(biggest, round);
}

const staked = rounds * LINES;
const pct = (value) => `${(value * 100).toFixed(2)}%`;
console.log(`Rounds played:          ${rounds.toLocaleString("en")} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
console.log(`Payout rate:            ${pct(won / staked)}`);
console.log(`  from free spins:      ${pct(wonInFeature / staked)}`);
console.log(`Spins that win:         ${pct(hits / rounds)} (1 in ${(rounds / hits).toFixed(1)})`);
console.log(`Free spins start:       1 in ${Math.round(rounds / Math.max(features, 1))} spins`);
console.log(`  retriggered:          ${retriggers.toLocaleString("en")} times`);
console.log(`  reached the ${MAX_WIN}x cap: ${capped.toLocaleString("en")} times`);
console.log(`Biggest round:          ${(biggest / LINES).toFixed(1)}x the bet`);
