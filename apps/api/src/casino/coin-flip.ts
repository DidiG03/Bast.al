import { createHmac } from "crypto";

/**
 * Bast.al's Coin Flip: the Player calls heads or tails, and the coin is
 * flipped. A right call pays 1.8 times the stake. Each side comes up half
 * the time, so a flip pays back 90% of the stake on average. This file is
 * the game's whole definition, used as it is by the API and the tests, so
 * what's tested is what's played.
 *
 * Flips are provably fair, with the same seed pair as Dice and Keno. A flip
 * is the HMAC-SHA256 of the server seed and "clientSeed:nonce", its first 4
 * bytes read as a fraction of 1: below 0.5 is heads, otherwise tails.
 */

export const GAME_NAME = "Coin Flip";

export const SIDES = ["HEADS", "TAILS"] as const;
export type Side = (typeof SIDES)[number];

/** What a flip can cost, in ALL, like every Casino game. The Player's max stake applies too. */
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;

/** What a right call pays, in times the stake. */
export const MULTIPLIER = 1.8;
/** What a flip pays back on average, in percent of the stake: half the flips pay MULTIPLIER. */
export const PAYOUT_RATE = (MULTIPLIER / 2) * 100;

/** What a right call pays, in cents, for a stake in cents, rounded down to the cent. */
export function winCents(stakeCents: number): number {
  return Math.floor((stakeCents * Math.round(MULTIPLIER * 10)) / 10);
}

/** The side that comes up for a server seed, a client seed and a nonce. */
export function flipFor(serverSeed: string, clientSeed: string, nonce: number): Side {
  const bytes = createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}`).digest();
  const fraction = bytes[0] / 256 + bytes[1] / 256 ** 2 + bytes[2] / 256 ** 3 + bytes[3] / 256 ** 4;
  return fraction < 0.5 ? "HEADS" : "TAILS";
}
