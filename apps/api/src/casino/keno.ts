import { createHmac } from "crypto";

/**
 * Bast.al's Keno, played like the Kino in betting shops: the Player picks 1
 * to 10 numbers from 1 to 80, and 20 of the 80 are drawn. What a round pays
 * depends on how many numbers were picked and how many of them were drawn
 * (PAYS). This file is the game's whole definition, used as it is by the API
 * and the tests, so what's tested is what's played.
 *
 * Draws are provably fair, with the same seed pair as Dice. The draw takes
 * the numbers one at a time from those still in the pot: the i-th (from 0)
 * is HMAC-SHA256 of the server seed and "clientSeed:nonce:i", its first 4
 * bytes read as a fraction of 1, times the numbers left, rounded down: an
 * index into the pot, kept in order from 1 to 80.
 */

export const GAME_NAME = "Keno";

/** The numbers on the board, 1 to 80. */
export const NUMBERS = 80;
/** How many of them each round draws. */
export const DRAWN = 20;
/** The fewest and the most numbers a Player can pick. */
export const MIN_PICKS = 1;
export const MAX_PICKS = 10;
/** What a round can cost, in ALL. The Player's max stake applies too. */
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;

/**
 * What a round pays, in times the stake: PAYS[picks][hits]. Every row pays
 * back about 90% on average (see payoutRate), worked out exactly from the
 * odds, so it doesn't matter how many numbers a Player picks.
 */
export const PAYS: Record<number, number[]> = {
  1: [0, 3.6],
  2: [0, 1, 8.5],
  3: [0, 0, 2, 45],
  4: [0, 0, 1, 7, 125],
  5: [0, 0, 0, 4, 25, 400],
  6: [0, 0, 0, 2, 9, 60, 1500],
  7: [0, 0, 0, 1, 6, 28, 160, 2000],
  8: [0, 0, 0, 1, 3, 13, 55, 400, 2000],
  9: [0, 0, 0, 0.5, 2, 8, 28, 150, 1000, 2000],
  10: [2, 0, 0, 0.5, 1, 3, 15, 80, 500, 1000, 2000],
};

/** The most a round can pay, in times the stake. */
export const MAX_MULTIPLIER = Math.max(...Object.values(PAYS).flat());

/** n choose k. */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

/** The chance that `hits` of `picks` numbers are among the 20 drawn. */
export function chanceOf(picks: number, hits: number): number {
  return (choose(DRAWN, hits) * choose(NUMBERS - DRAWN, picks - hits)) / choose(NUMBERS, picks);
}

/** What a round with this many picks pays back on average, in percent of the stake: exact, from the odds. */
export function payoutRate(picks: number): number {
  return PAYS[picks].reduce((sum, pay, hits) => sum + chanceOf(picks, hits) * pay, 0) * 100;
}

/** What a round pays, in cents, for a stake in cents: the stake times the pay, rounded down to the cent. */
export function winCents(stakeCents: number, picks: number, hits: number): number {
  return Math.floor((stakeCents * Math.round(PAYS[picks][hits] * 10)) / 10);
}

/** Why these picks can't be played, or null if they can: 1 to 10 different whole numbers from 1 to 80. */
export function invalidPicks(picks: unknown): string | null {
  if (!Array.isArray(picks) || picks.length < MIN_PICKS || picks.length > MAX_PICKS) return `Pick ${MIN_PICKS} to ${MAX_PICKS} numbers.`;
  if (!picks.every((pick) => Number.isInteger(pick) && pick >= 1 && pick <= NUMBERS)) return `Pick numbers from 1 to ${NUMBERS}.`;
  if (new Set(picks).size !== picks.length) return "Pick each number once.";
  return null;
}

/** The 20 numbers drawn for a server seed, a client seed and a nonce, in the order they came out. */
export function drawFor(serverSeed: string, clientSeed: string, nonce: number): number[] {
  const pot = Array.from({ length: NUMBERS }, (_, index) => index + 1);
  const drawn: number[] = [];
  for (let i = 0; i < DRAWN; i++) {
    const bytes = createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}:${i}`).digest();
    const fraction = bytes[0] / 256 + bytes[1] / 256 ** 2 + bytes[2] / 256 ** 3 + bytes[3] / 256 ** 4;
    drawn.push(pot.splice(Math.floor(fraction * pot.length), 1)[0]);
  }
  return drawn;
}

/** The picks that were drawn. */
export const hitsOf = (picks: number[], drawn: number[]) => picks.filter((pick) => drawn.includes(pick));
