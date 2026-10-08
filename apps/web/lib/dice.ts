/**
 * Dice in the browser: the same sums as the API's (apps/api/src/casino/dice.ts),
 * so the table can show the multiplier, the chance and the profit while the
 * Player moves the slider. The API checks every roll again and decides it;
 * this file never rolls. It also checks a roll from its seeds, the way any
 * Player can once the server seed is shown.
 *
 * Targets and rolls are kept in hundredths: 5000 is 50.00.
 */

export type DiceDirection = "UNDER" | "OVER";

export const OUTCOMES = 10_000;
export const PAYOUT_RATE = 97;
/** 1% to 95% of the numbers can win. */
export const MIN_WINNING = 100;
export const MAX_WINNING = 9_500;

/** How many of the 10,000 numbers win with this target and side. */
export const winningNumbers = (target: number, direction: DiceDirection) => (direction === "UNDER" ? target : OUTCOMES - 1 - target);

/** The target that leaves `winning` numbers winning on this side. */
export const targetFor = (winning: number, direction: DiceDirection) => (direction === "UNDER" ? winning : OUTCOMES - 1 - winning);

/** The legal targets on each side, in hundredths. */
export const targetRange = (direction: DiceDirection) => (direction === "UNDER" ? [MIN_WINNING, MAX_WINNING] : [OUTCOMES - 1 - MAX_WINNING, OUTCOMES - 1 - MIN_WINNING]) as [number, number];

export const clampWinning = (winning: number) => Math.min(MAX_WINNING, Math.max(MIN_WINNING, Math.round(winning)));

/** The multiplier: 97% over the chance, rounded down to 4 decimals. */
export const multiplierOf = (winning: number) => Math.floor((PAYOUT_RATE * OUTCOMES * 100) / winning) / 10_000;

/** The number of winning numbers closest to a multiplier the Player typed. */
export const winningForMultiplier = (multiplier: number) => clampWinning((PAYOUT_RATE * 100) / multiplier);

/** What a win pays, in dollars, rounded down to the cent. */
export const payoutOf = (stake: number, winning: number) => Math.floor((Math.round(stake * 100) * Math.floor((PAYOUT_RATE * OUTCOMES * 100) / winning)) / 10_000) / 100;

/** Flipping the side keeps the chance: under 50.00 and over 49.99 both win on 5,000 numbers. */
export const flip = (target: number, direction: DiceDirection) => ({ target: OUTCOMES - 1 - target, direction: (direction === "UNDER" ? "OVER" : "UNDER") as DiceDirection });

export const points = (hundredths: number) => (hundredths / 100).toFixed(2);

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The SHA-256 of a server seed, as the table shows it before the seed is revealed. */
export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** The roll (in hundredths) these seeds and this nonce make: HMAC-SHA256(serverSeed, "clientSeed:nonce"), first 4 bytes as a fraction, times 10,000. */
export async function rollFromSeeds(serverSeed: string, clientSeed: string, nonce: number): Promise<number> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(serverSeed), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${clientSeed}:${nonce}`)));
  const fraction = bytes[0] / 256 + bytes[1] / 256 ** 2 + bytes[2] / 256 ** 3 + bytes[3] / 256 ** 4;
  return Math.floor(fraction * OUTCOMES);
}
