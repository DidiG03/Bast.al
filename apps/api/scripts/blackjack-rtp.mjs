// Run with `npm run blackjack:rtp --workspace apps/api [hands]` (builds first).
// Plays blackjack's own rules (src/casino/blackjack.ts) with perfect basic
// strategy for the game's rules (RULES; no dealer blackjack check until the
// Player has played, one split, one double per round, no insurance), and prints what it paid back. That's the best a
// Player can do; real Players do a little worse.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RULES, act, allowed, cardValue, deal, handTotal, newShoe, paidOut, staked } = require("../dist/casino/blackjack.js");

const hands = Number(process.argv[2]) || 2_000_000;
// Other rules to measure, as JSON over the game's own: '{"dealerHitsSoft17":true}'.
if (process.argv[3]) Object.assign(RULES, JSON.parse(process.argv[3]));
const draw = (below) => Math.floor(Math.random() * below);

/** Basic strategy: the move for this hand against the dealer's up card (2 to 11 for an ace). */
function strategy(cards, up, moves) {
  const can = (move) => moves.includes(move);
  const { total, soft } = handTotal(cards);
  const pair = cards.length === 2 && cardValue(cards[0]) === cardValue(cards[1]) ? cardValue(cards[0]) : null;
  if (pair && can("split")) {
    // The dealer doesn't check for blackjack first, so a ten or an ace showing makes splits and doubles riskier.
    const splitOn = { 1: (d) => d !== 11, 8: (d) => d < 10, 9: (d) => d !== 7 && d < 10, 7: (d) => d <= 7, 6: (d) => d <= 6, 4: (d) => d === 5 || d === 6, 3: (d) => d <= 7, 2: (d) => d <= 7 };
    if (splitOn[pair]?.(up)) return "split";
  }
  const double = (fallback) => (can("double") ? "double" : fallback);
  if (soft) {
    if (total >= 20) return "stand";
    if (total === 19) return up === 6 && RULES.dealerHitsSoft17 ? double("stand") : "stand";
    if (total === 18) return up >= (RULES.dealerHitsSoft17 ? 2 : 3) && up <= 6 ? double("stand") : up <= 8 ? "stand" : "hit";
    if (total === 17) return up >= 3 && up <= 6 ? double("hit") : "hit";
    if (total >= 15) return up >= 4 && up <= 6 ? double("hit") : "hit";
    return up >= 5 && up <= 6 ? double("hit") : "hit";
  }
  if (total >= 17) return "stand";
  if (total >= 13) return up <= 6 ? "stand" : "hit";
  if (total === 12) return up >= 4 && up <= 6 ? "stand" : "hit";
  if (total === 11) return up <= 9 ? double("hit") : "hit";
  if (total === 10) return up <= 9 ? double("hit") : "hit";
  if (total === 9) return up >= 3 && up <= 6 ? double("hit") : "hit";
  return "hit";
}

let stakes = 0;
let returns = 0;
let wins = 0;
let blackjacks = 0;
const started = Date.now();
for (let i = 0; i < hands; i++) {
  let round = deal(100, newShoe(draw));
  const up = cardValue(round.dealer[0]) === 1 ? 11 : cardValue(round.dealer[0]);
  while (round.phase !== "DONE") {
    if (round.phase === "INSURANCE") {
      round = act(round, "noInsurance");
      continue;
    }
    round = act(round, strategy(round.hands[round.active].cards, up, allowed(round)));
  }
  stakes += staked(round);
  returns += paidOut(round);
  if (paidOut(round) > staked(round)) wins++;
  if (round.hands[0].result === "BLACKJACK") blackjacks++;
}
const rate = (returns / stakes) * 100;
// The standard error of the rate, from a blackjack hand's spread (about 1.15 bets).
const error = (1.15 / Math.sqrt(hands)) * 100;
console.log(`${hands.toLocaleString()} hands in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`Paid back: ${rate.toFixed(2)}% (± ${(2 * error).toFixed(2)}%), house edge ${(100 - rate).toFixed(2)}%`);
console.log(`Rounds won: ${((wins / hands) * 100).toFixed(1)}%, blackjacks: 1 in ${(hands / blackjacks).toFixed(1)}`);
