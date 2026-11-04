/**
 * Shtatat.al's Hi-Lo. A card is turned; the Player guesses whether the next
 * one is higher or the same, or lower or the same. Each right guess raises
 * the multiplier by the guess's odds; a wrong one loses the stake. The Player
 * can cash out after any right guess, or skip a card for free.
 *
 * Cards are drawn as from an endless deck: each of the 13 ranks (ace low,
 * king high) as likely every time. On rank r, "higher or same" wins with
 * (14 − r)/13, "lower or same" with r/13. The multiplier is 85% of the fair
 * price of every right guess so far, floored to the cent, so cashing out pays
 * back 85% on average whatever the Player does; a sure guess (higher or same
 * on an ace) adds nothing. A round pays at most 5,000 times the stake. This
 * file is the game's whole definition, used by the API and the tests.
 */

export const GAME_NAME = "Hi-Lo";
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;
export const PAYOUT_RATE = 85;
export const MAX_WIN = 5000;
/** A round has at most this many guesses. */
export const MAX_GUESSES = 30;

export const GUESSES = ["HIGHER", "LOWER", "SKIP"] as const;
export type Guess = (typeof GUESSES)[number];
export type Card = { rank: number; suit: number };
export type Phase = "PLAY" | "WON" | "LOST";
export type Step = { card: Card; guess: Guess | null; correct: boolean | null };

export type Round = {
  bet: number;
  phase: Phase;
  /** Every card turned, the first one included, with the guess made on the card before it. */
  steps: Step[];
  /** The fair price of the right guesses so far, as numerator/denominator (13^k over the product of winning ranks), exact, in decimal strings. */
  num: string;
  den: string;
  payout: number;
};

export class HiloError extends Error {}

/** In how many of the 13 ranks the guess wins, on rank r. */
export const winningRanks = (rank: number, guess: Exclude<Guess, "SKIP">) => (guess === "HIGHER" ? 14 - rank : rank);

/** The multiplier, in hundredths, for a fair price num/den: 85% of it, floored, at most MAX_WIN. */
export function multiplierHundredths(num: string | bigint, den: string | bigint): number {
  const value = (BigInt(num) * BigInt(PAYOUT_RATE)) / BigInt(den);
  return value >= BigInt(MAX_WIN * 100) ? MAX_WIN * 100 : Number(value);
}

export const drawCard = (draw: (below: number) => number): Card => ({ rank: draw(13) + 1, suit: draw(4) });

export function startRound(betCents: number, draw: (below: number) => number): Round {
  return { bet: betCents, phase: "PLAY", steps: [{ card: drawCard(draw), guess: null, correct: null }], num: "1", den: "1", payout: 0 };
}

const rightGuesses = (round: Round) => round.steps.filter((step) => step.correct === true && step.guess !== "SKIP").length;

/** One guess (or a skip) on the card showing. */
export function guess(round: Round, choice: Guess, draw: (below: number) => number): Round {
  if (round.phase !== "PLAY") throw new HiloError("This round is over. Start a new one.");
  if (round.steps.length > MAX_GUESSES) throw new HiloError("This round has had its guesses. Cash out.");
  const current = round.steps[round.steps.length - 1].card;
  const card = drawCard(draw);
  if (choice === "SKIP") return { ...round, steps: [...round.steps, { card, guess: "SKIP", correct: null }] };
  const wins = winningRanks(current.rank, choice);
  const correct = choice === "HIGHER" ? card.rank >= current.rank : card.rank <= current.rank;
  const steps = [...round.steps, { card, guess: choice, correct }];
  if (!correct) return { ...round, steps, phase: "LOST", payout: 0 };
  // Kept exact (13^30 is past a float's whole numbers), reduced by the common factor each time.
  let num = BigInt(round.num) * 13n;
  let den = BigInt(round.den) * BigInt(wins);
  const g = gcd(num, den);
  num /= g;
  den /= g;
  const next = { ...round, steps, num: num.toString(), den: den.toString() };
  // At the cap, the round ends paid: nothing more can be won.
  if (multiplierHundredths(num, den) >= MAX_WIN * 100) return cashOut(next);
  return next;
}

/** Cashes out: the stake times the multiplier, after at least one right guess. */
export function cashOut(round: Round): Round {
  if (round.phase !== "PLAY") throw new HiloError("This round is over. Start a new one.");
  if (rightGuesses(round) === 0) throw new HiloError("Make a right guess before you cash out.");
  return { ...round, phase: "WON", payout: Math.floor((round.bet * multiplierHundredths(round.num, round.den)) / 100) };
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

/** The round as the Player sees it (nothing is hidden: the next card isn't drawn until they guess). */
export function publicView(round: Round) {
  const current = round.steps[round.steps.length - 1].card;
  const multiplier = multiplierHundredths(round.num, round.den) / 100;
  const odds = (g: "HIGHER" | "LOWER") => {
    const wins = winningRanks(current.rank, g);
    return { chance: Math.round((wins / 13) * 10000) / 100, multiplier: multiplierHundredths(BigInt(round.num) * 13n, BigInt(round.den) * BigInt(wins)) / 100 };
  };
  return {
    bet: round.bet / 100,
    phase: round.phase,
    steps: round.steps,
    multiplier,
    canCashOut: round.phase === "PLAY" && rightGuesses(round) > 0,
    cashOutNow: Math.floor((round.bet * multiplierHundredths(round.num, round.den)) / 100) / 100,
    higher: odds("HIGHER"),
    lower: odds("LOWER"),
    payout: round.payout / 100,
  };
}
