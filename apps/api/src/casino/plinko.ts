import { randomInt } from "crypto";

/**
 * Bast.al's Plinko. A ball drops through a triangle of pegs: at every row it
 * goes left or right, each with an even chance, and lands in one of the
 * buckets along the bottom. The Player picks how many rows (8, 12 or 16)
 * and the risk; each choice has its own pay table, highest at the edges.
 * This file is the game's whole definition, used as it is by the API and
 * the tests, so what's tested is what's played.
 *
 * With `rows` rows the ball lands in bucket k (k rights) with chance
 * C(rows, k) / 2^rows. Every pay table is set so a ball pays back about 97%
 * of its stake on average (payoutRate() works it out exactly, and the tests
 * hold every table to 96.8% to 97.2%).
 */

export const GAME_NAME = "Plinko";

/** How many rows of pegs a board can have. */
export const ROWS = [8, 12, 16] as const;
export type Rows = (typeof ROWS)[number];

export const RISKS = ["LOW", "MEDIUM", "HIGH"] as const;
export type Risk = (typeof RISKS)[number];

/** What a ball can cost, in dollars. All multiples of 10 cents, so every pay comes out in whole cents. */
export const BETS = [0.2, 0.5, 1, 2, 5, 10] as const;

/** What a ball pays back on average, in percent of the stake, to the nearest whole percent. */
export const PAYOUT_RATE = 97;

/**
 * Times the stake each bucket pays, from the left edge to the middle. The
 * right half mirrors the left, so a board of `rows` rows has rows + 1
 * buckets. Every value is in tenths, so a stake in tens of cents pays whole cents.
 */
const HALF_TABLES: Record<Rows, Record<Risk, readonly number[]>> = {
  8: {
    LOW: [5.6, 1.8, 1.1, 1, 0.5],
    MEDIUM: [13.4, 3, 1.2, 0.7, 0.4],
    HIGH: [29, 4, 1.4, 0.3, 0.2],
  },
  12: {
    LOW: [10, 2.6, 1.4, 1.3, 1.1, 1, 0.5],
    MEDIUM: [35, 11, 4.1, 2, 1, 0.6, 0.3],
    HIGH: [168, 24, 7.8, 1.9, 0.7, 0.2, 0.2],
  },
  16: {
    LOW: [16, 9, 1.7, 1.4, 1.3, 1.1, 1.1, 1, 0.5],
    MEDIUM: [110, 45, 10, 5, 3.1, 1.3, 1, 0.5, 0.3],
    HIGH: [1000, 130, 26, 9.1, 4.1, 1.8, 0.2, 0.2, 0.2],
  },
};

/** Every bucket's multiplier, left to right. */
export function payTable(rows: Rows, risk: Risk): number[] {
  const half = HALF_TABLES[rows][risk];
  return [...half, ...half.slice(0, -1).reverse()];
}

/** Every board's pay table, by rows and then risk. */
export const PAY_TABLES = Object.fromEntries(ROWS.map((rows) => [rows, Object.fromEntries(RISKS.map((risk) => [risk, payTable(rows, risk)]))])) as Record<Rows, Record<Risk, number[]>>;

/** The most a ball can pay, in times the stake: the edge of 16 rows on high risk. */
export const MAX_MULTIPLIER = Math.max(...ROWS.flatMap((rows) => RISKS.map((risk) => HALF_TABLES[rows][risk][0])));

/** The chance of landing in each bucket, left to right. */
export function bucketChances(rows: Rows): number[] {
  const chances: number[] = [];
  let ways = 1;
  for (let k = 0; k <= rows; k += 1) {
    chances.push(ways / 2 ** rows);
    ways = (ways * (rows - k)) / (k + 1);
  }
  return chances;
}

/** What one board pays back on average, in percent of the stake, to two decimals. */
export function payoutRate(rows: Rows, risk: Risk): number {
  const table = payTable(rows, risk);
  const expected = bucketChances(rows).reduce((sum, chance, bucket) => sum + chance * table[bucket], 0);
  return Math.round(expected * 10000) / 100;
}

export const isRows = (value: unknown): value is Rows => (ROWS as readonly unknown[]).includes(value);
export const isRisk = (value: unknown): value is Risk => (RISKS as readonly unknown[]).includes(value);

/** A dropped ball: each row's bounce (0 left, 1 right), the bucket it lands in, and what that pays. */
export type Drop = { path: number[]; bucket: number; multiplier: number };

/** Drops a ball. crypto.randomInt unless a test passes its own (it must return 0 or 1). */
export function dropBall(rows: Rows, risk: Risk, draw: (sides: number) => number = randomInt): Drop {
  const path = Array.from({ length: rows }, (): number => {
    const side = draw(2);
    if (side !== 0 && side !== 1) throw new Error("The ball bounced off the board");
    return side;
  });
  const bucket = path.reduce((sum, side) => sum + side, 0);
  return { path, bucket, multiplier: payTable(rows, risk)[bucket] };
}

/** What a ball pays, in cents, for a stake in cents: the stake times the multiplier, rounded down to the cent. */
export function winCents(stakeCents: number, multiplier: number): number {
  return Math.floor((stakeCents * Math.round(multiplier * 10)) / 10);
}
