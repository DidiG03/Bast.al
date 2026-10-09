import { randomInt } from "crypto";

/**
 * Bast.al's roulette: European, with 37 pockets (0 to 36, one zero). This
 * file is the game's whole definition, used as it is by the API and the
 * tests, so what's tested is what's played.
 *
 * Every bet is a set of numbers, and pays so that a hit returns 36 divided
 * by how many numbers it covers (the stake included): a single number pays
 * 35 to 1, red pays 1 to 1. With 37 pockets every bet pays back 36/37 of
 * what it costs on average, 97.30%.
 *
 * Bets are named by their spot on the table: inside bets by their numbers
 * ("17", "0-1", "0-1-2-3", "1-2-4-5"), outside bets by name ("RED", "COL1", "1-18").
 */

export const GAME_NAME = "Roulette";

/** The pockets in order round the wheel, clockwise from 0. */
export const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26] as const;

export const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36] as const;

/** What a round pays back on average, in percent of what it costs: 36/37. */
export const PAYOUT_RATE = 97.3;

/** The chips, in ALL. Every amount on the table is a sum of them, so a multiple of the smallest. */
export const CHIPS = [50, 100, 250, 500, 1000, 2500] as const;
export const MIN_CHIP = CHIPS[0];
/** The most a round can stake in all when the Player has no max stake set. With one, that's the most. */
export const TABLE_MAX = 2500;
/** The most spots one round can cover. */
export const MAX_SPOTS = 150;

export type Color = "RED" | "BLACK" | "GREEN";

export const label = (number: number) => String(number);
export const colorOf = (number: number): Color => (number === 0 ? "GREEN" : (RED_NUMBERS as readonly number[]).includes(number) ? "RED" : "BLACK");

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
/** An inside spot's name: its numbers, smallest first. */
const inside = (numbers: number[]) => [...numbers].sort((a, b) => a - b).map(label).join("-");

/** Every spot on the table and the numbers it covers. */
function buildSpots(): Map<string, number[]> {
  const spots = new Map<string, number[]>();
  const add = (numbers: number[], name = inside(numbers)) => spots.set(name, numbers);

  // Straight up: one number.
  for (const number of range(0, 36)) add([number]);
  // Splits: two numbers side by side on the table, across (1-2) or down (1-4), and 0 with 1, 2 or 3.
  for (const n of range(1, 36)) {
    if (n % 3 !== 0) add([n, n + 1]);
    if (n <= 33) add([n, n + 3]);
  }
  for (const pair of [[0, 1], [0, 2], [0, 3]]) add(pair);
  // Streets: a row of three, and the two trios with 0.
  for (let n = 1; n <= 34; n += 3) add([n, n + 1, n + 2]);
  for (const trio of [[0, 1, 2], [0, 2, 3]]) add(trio);
  // Corners: four numbers meeting at a point.
  for (const n of range(1, 32)) if (n % 3 !== 0) add([n, n + 1, n + 3, n + 4]);
  // The first four: 0, 1, 2 and 3.
  add([0, 1, 2, 3]);
  // Six lines: two rows.
  for (let n = 1; n <= 31; n += 3) add(range(n, n + 5));

  // Outside bets.
  add(range(1, 12), "1ST12");
  add(range(13, 24), "2ND12");
  add(range(25, 36), "3RD12");
  for (const column of [1, 2, 3]) add(range(1, 36).filter((n) => n % 3 === column % 3), `COL${column}`);
  add(range(1, 18), "1-18");
  add(range(19, 36), "19-36");
  add(range(1, 36).filter((n) => n % 2 === 0), "EVEN");
  add(range(1, 36).filter((n) => n % 2 === 1), "ODD");
  add([...RED_NUMBERS], "RED");
  add(range(1, 36).filter((n) => colorOf(n) === "BLACK"), "BLACK");
  return spots;
}

/** Every spot a bet can go on, by name. */
export const SPOTS: ReadonlyMap<string, readonly number[]> = buildSpots();

/** How many times its stake a winning bet on `numbers` pays, besides the stake: 35 for one number, 1 for 18. */
export const payoutFor = (count: number) => 36 / count - 1;

export type PlacedBet = { spot: string; amount: number };
export type SettledBet = PlacedBet & { numbers: number[]; win: number };

/** Why these bets can't be played, or null if they can. Amounts in dollars. */
export function invalidBets(bets: PlacedBet[]): string | null {
  if (bets.length === 0) return "Place at least one chip.";
  if (bets.length > MAX_SPOTS) return `Bets can cover at most ${MAX_SPOTS} spots in one spin.`;
  const seen = new Set<string>();
  for (const bet of bets) {
    if (!SPOTS.has(bet.spot)) return `There's no "${bet.spot}" on the table.`;
    if (seen.has(bet.spot)) return `"${bet.spot}" is listed twice.`;
    seen.add(bet.spot);
    // Whole chips only: a multiple of the smallest one, worked out in cents to stay exact.
    const cents = Math.round(bet.amount * 100);
    if (!Number.isFinite(bet.amount) || Math.abs(cents - bet.amount * 100) > 1e-6 || cents <= 0 || cents % Math.round(MIN_CHIP * 100) !== 0) {
      return `Bets are made in chips of ${MIN_CHIP.toFixed(2)} ALL and up.`;
    }
  }
  return null;
}

/** What each bet pays when the ball lands on `number`, in dollars (stake included for a winner, 0 for a loser). */
export function settle(bets: PlacedBet[], number: number): { bets: SettledBet[]; staked: number; win: number } {
  const settled = bets.map((bet) => {
    const numbers = [...SPOTS.get(bet.spot)!];
    const cents = Math.round(bet.amount * 100);
    const win = numbers.includes(number) ? (cents * 36) / numbers.length / 100 : 0;
    return { ...bet, numbers, win };
  });
  const cents = (values: number[]) => values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
  return { bets: settled, staked: cents(bets.map((bet) => bet.amount)), win: cents(settled.map((bet) => bet.win)) };
}

/** Spins the wheel: where it stops (an index into WHEEL) and the number there. crypto.randomInt unless a test passes its own. */
export function spinWheel(draw: (pockets: number) => number = randomInt): { stop: number; number: number } {
  const stop = draw(WHEEL.length);
  if (!Number.isInteger(stop) || stop < 0 || stop >= WHEEL.length) throw new Error("The wheel stopped off the wheel");
  return { stop, number: WHEEL[stop] };
}
