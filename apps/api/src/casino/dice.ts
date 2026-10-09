import { createHash, createHmac, randomBytes } from "crypto";

/**
 * Bast.al's Dice. A roll is a number from 0.00 to 99.99, every one as
 * likely. The Player picks a target and a side: "under 50.00" wins on 0.00
 * to 49.99, "over 50.00" on 50.01 to 99.99. The fewer numbers win, the more
 * a win pays: the multiplier is 97% divided by the chance of winning,
 * rounded down to 4 decimals, so every roll pays back at most 97% on
 * average, whatever the target. This file is the game's whole definition,
 * used as it is by the API and the tests, so what's tested is what's played.
 *
 * Rolls are provably fair. A roll is the HMAC-SHA256 of the server seed and
 * "clientSeed:nonce"; the first 4 bytes, read as a fraction of 1, times
 * 10,000 and rounded down, give the roll in hundredths. Before a roll the
 * Player sees only the server seed's SHA-256 hash, and chooses the client
 * seed; once they change seeds, the server seed is shown, so anyone can
 * check every roll it made.
 */

export const GAME_NAME = "Dice";

/** Every roll is one of 10,000 numbers, 0.00 to 99.99, kept in hundredths. */
export const OUTCOMES = 10_000;
/** What a roll pays back on average, in percent of the stake, at most. */
export const PAYOUT_RATE = 97;
/** The chance of winning can be set from 1% to 95%: 100 to 9,500 winning numbers. */
export const MIN_WINNING = 100;
export const MAX_WINNING = 9_500;
/** What a roll can cost, in ALL, like every Casino game. The Player's max stake applies too. */
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;
export const MIN_BET = BETS[0];
export const MAX_BET = BETS[BETS.length - 1];

export const DIRECTIONS = ["UNDER", "OVER"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** How many of the 10,000 numbers win with this target (in hundredths) and side. */
export function winningNumbers(target: number, direction: Direction): number {
  return direction === "UNDER" ? target : OUTCOMES - 1 - target;
}

/** Whether `roll` wins against the target. Both in hundredths. */
export function wins(roll: number, target: number, direction: Direction): boolean {
  return direction === "UNDER" ? roll < target : roll > target;
}

/** The multiplier for this many winning numbers, in ten-thousandths: 97% over the chance, rounded down. */
export function multiplierUnits(winning: number): number {
  return Math.floor((PAYOUT_RATE * OUTCOMES * 100) / winning);
}

export const multiplierOf = (winning: number) => multiplierUnits(winning) / 10_000;

/** What a win pays, in cents, for a stake in cents: the stake times the multiplier, rounded down to the cent. */
export function winCents(stakeCents: number, winning: number): number {
  return Math.floor((stakeCents * multiplierUnits(winning)) / 10_000);
}

/** The target in hundredths for a target in points (50.5 → 5050), or null if it isn't a whole hundredth. */
export function targetUnits(target: number): number | null {
  if (!Number.isFinite(target)) return null;
  const units = Math.round(target * 100);
  return Math.abs(units - target * 100) < 1e-6 ? units : null;
}

/** Why this target and side can't be played, or null if they can. The target is in hundredths. */
export function invalidTarget(target: number, direction: Direction): string | null {
  if (!Number.isInteger(target) || target < 0 || target >= OUTCOMES) return "The target is a number from 0.00 to 99.99.";
  const winning = winningNumbers(target, direction);
  if (winning < MIN_WINNING || winning > MAX_WINNING) return "Set a target that wins 1% to 95% of the time.";
  return null;
}

/** The roll, 0 to 9,999 in hundredths, for a server seed, a client seed and a nonce. */
export function rollFor(serverSeed: string, clientSeed: string, nonce: number): number {
  const bytes = createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}`).digest();
  const fraction = bytes[0] / 256 + bytes[1] / 256 ** 2 + bytes[2] / 256 ** 3 + bytes[3] / 256 ** 4;
  return Math.floor(fraction * OUTCOMES);
}

export const hashSeed = (serverSeed: string) => createHash("sha256").update(serverSeed).digest("hex");

/** A new secret server seed: 32 random bytes, in hex. */
export const newServerSeed = () => randomBytes(32).toString("hex");
/** A client seed for a Player who hasn't chosen one. */
export const newClientSeed = () => randomBytes(8).toString("hex");

/** A client seed the Player may choose: 1 to 32 letters, digits, dashes or underscores. */
export const isClientSeed = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value);

/** The roll in points, as shown: 4273 → "42.73". */
export const label = (hundredths: number) => (hundredths / 100).toFixed(2);
