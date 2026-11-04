/**
 * Shtatat.al's Money Wheel. The Player picks a risk and spins a wheel of 30
 * segments, each with a multiplier; the stake times the multiplier it stops
 * on is paid. Every risk's multipliers add up to 22.5 over 30 segments, so a
 * spin pays back 75% of the stake on average whatever the risk: low risk wins
 * small and often, high risk rarely and big. This file is the game's whole
 * definition, used as it is by the API and the tests.
 */

export const GAME_NAME = "Money Wheel";

export const RISKS = ["LOW", "MEDIUM", "HIGH"] as const;
export type Risk = (typeof RISKS)[number];

/** What a spin can cost, in ALL, like every Casino game. The Player's max stake applies too. */
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;
export const PAYOUT_RATE = 75;
export const SEGMENT_COUNT = 30;

/** The wheel for each risk, in hundredths of the stake, laid out so equal values are spread around it. */
const LOW = [120, 0, 120, 150, 120, 0, 120, 120, 0, 0, 120, 0, 120, 120, 0, 150, 120, 0, 120, 120, 0, 0, 120, 0, 120, 120, 0, 150, 0, 120];
const MEDIUM = [0, 150, 0, 200, 0, 300, 0, 150, 0, 200, 0, 0, 200, 0, 150, 0, 200, 0, 0, 0, 150, 0, 200, 0, 0, 150, 0, 200, 0, 0];
const HIGH = [0, 0, 0, 0, 0, 0, 0, 1500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 750, 0, 0, 0, 0, 0, 0, 0, 0];
export const WHEELS: Record<Risk, readonly number[]> = { LOW, MEDIUM, HIGH };

/** What the segment pays, in cents, for a stake in cents, rounded down to the cent. */
export const winCents = (stakeCents: number, multiplierHundredths: number) => Math.floor((stakeCents * multiplierHundredths) / 100);

/** The segment the wheel stops on, from a draw below SEGMENT_COUNT. */
export function spin(risk: Risk, draw: (below: number) => number): { segment: number; multiplier: number } {
  const segment = draw(SEGMENT_COUNT);
  return { segment, multiplier: WHEELS[risk][segment] };
}
