/**
 * The roulette table in the browser: which spots exist, what they cover, and
 * where they sit on the drawn table. The names match the API's
 * (apps/api/src/casino/roulette.ts), which checks every bet again and decides
 * the number; this file only lays the table out.
 *
 * European roulette: numbers 0 to 36, one zero.
 */

/** The wheel's pockets clockwise from 0, as the API's WHEEL. The game itself gets it from the API; the lobby tile draws from this. */
export const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26] as const;

export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export type PocketColor = "RED" | "BLACK" | "GREEN";
export const label = (number: number) => String(number);
export const colorOf = (number: number): PocketColor => (number === 0 ? "GREEN" : RED.has(number) ? "RED" : "BLACK");

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const inside = (numbers: number[]) => [...numbers].sort((a, b) => a - b).map(label).join("-");

/** The outside bets, as the table prints them. */
export const OUTSIDE = ["1ST12", "2ND12", "3RD12", "COL1", "COL2", "COL3", "1-18", "19-36", "EVEN", "ODD", "RED", "BLACK"] as const;

function buildSpots(): Map<string, number[]> {
  const spots = new Map<string, number[]>();
  const add = (numbers: number[], name = inside(numbers)) => spots.set(name, numbers);
  for (const number of range(0, 36)) add([number]);
  for (const n of range(1, 36)) {
    if (n % 3 !== 0) add([n, n + 1]);
    if (n <= 33) add([n, n + 3]);
  }
  for (const pair of [[0, 1], [0, 2], [0, 3]]) add(pair);
  for (let n = 1; n <= 34; n += 3) add([n, n + 1, n + 2]);
  for (const trio of [[0, 1, 2], [0, 2, 3]]) add(trio);
  for (const n of range(1, 32)) if (n % 3 !== 0) add([n, n + 1, n + 3, n + 4]);
  add([0, 1, 2, 3]);
  for (let n = 1; n <= 31; n += 3) add(range(n, n + 5));
  add(range(1, 12), "1ST12");
  add(range(13, 24), "2ND12");
  add(range(25, 36), "3RD12");
  for (const column of [1, 2, 3]) add(range(1, 36).filter((n) => n % 3 === column % 3), `COL${column}`);
  add(range(1, 18), "1-18");
  add(range(19, 36), "19-36");
  add(range(1, 36).filter((n) => n % 2 === 0), "EVEN");
  add(range(1, 36).filter((n) => n % 2 === 1), "ODD");
  add(Array.from(RED), "RED");
  add(range(1, 36).filter((n) => colorOf(n) === "BLACK"), "BLACK");
  return spots;
}

/** Every spot a chip can go on, by name, and the numbers it covers. */
export const SPOTS: ReadonlyMap<string, readonly number[]> = buildSpots();

/** What a winning chip on this spot pays, besides itself: 35 for one number, 1 for 18. */
export const payoutFor = (spot: string) => 36 / (SPOTS.get(spot)?.length ?? 36) - 1;

/*
 * The table, laid out sideways as on a real one: 0 on the left, the
 * numbers in 12 columns of 3 (3 on top, 1 at the bottom), "2 to 1" for each
 * row on the right, then the dozens and the even-money bets underneath.
 * Units are the drawing's; one number is CELL wide.
 */
export const CELL = 60;
export const ZERO_W = 54;
export const COLUMN_W = 60;
export const DOZEN_H = 46;
export const EVEN_H = 46;
export const TABLE_W = ZERO_W + 12 * CELL + COLUMN_W;
export const NUMBERS_H = 3 * CELL;
export const TABLE_H = NUMBERS_H + DOZEN_H + EVEN_H;

type Box = { x: number; y: number; w: number; h: number };

/** A number's box on the table. */
export function numberBox(number: number): Box {
  if (number === 0) return { x: 0, y: 0, w: ZERO_W, h: NUMBERS_H };
  const column = Math.floor((number - 1) / 3);
  const row = 2 - ((number - 1) % 3);
  return { x: ZERO_W + column * CELL, y: row * CELL, w: CELL, h: CELL };
}

/** An outside bet's box on the table. */
export function outsideBox(spot: (typeof OUTSIDE)[number]): Box {
  const right = ZERO_W + 12 * CELL;
  switch (spot) {
    case "COL3":
      return { x: right, y: 0, w: COLUMN_W, h: CELL };
    case "COL2":
      return { x: right, y: CELL, w: COLUMN_W, h: CELL };
    case "COL1":
      return { x: right, y: 2 * CELL, w: COLUMN_W, h: CELL };
    case "1ST12":
    case "2ND12":
    case "3RD12":
      return { x: ZERO_W + ["1ST12", "2ND12", "3RD12"].indexOf(spot) * 4 * CELL, y: NUMBERS_H, w: 4 * CELL, h: DOZEN_H };
    default:
      return { x: ZERO_W + ["1-18", "EVEN", "RED", "BLACK", "ODD", "19-36"].indexOf(spot) * 2 * CELL, y: NUMBERS_H + DOZEN_H, w: 2 * CELL, h: EVEN_H };
  }
}

const centreOf = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

/** Where the bets with 0 sit: on the line between 0 and the numbers, and the first four at its bottom corner. */
const ZERO_SPOTS: Record<string, { x: number; y: number }> = {
  "0-3": { x: ZERO_W, y: CELL / 2 },
  "0-2-3": { x: ZERO_W, y: CELL },
  "0-2": { x: ZERO_W, y: CELL * 1.5 },
  "0-1-2": { x: ZERO_W, y: CELL * 2 },
  "0-1": { x: ZERO_W, y: CELL * 2.5 },
  "0-1-2-3": { x: ZERO_W, y: NUMBERS_H },
};

/** Where a chip on this spot sits on the table. */
export function spotCentre(spot: string): { x: number; y: number } {
  if ((OUTSIDE as readonly string[]).includes(spot)) return centreOf(outsideBox(spot as (typeof OUTSIDE)[number]));
  if (ZERO_SPOTS[spot]) return ZERO_SPOTS[spot];
  const numbers = SPOTS.get(spot) ?? [];
  if (numbers.length === 1) return centreOf(numberBox(numbers[0]));
  // Streets and six lines sit on the table's bottom edge, under their rows.
  if (numbers.length === 3 || numbers.length === 6) {
    const xs = numbers.map((n) => centreOf(numberBox(n)).x);
    return { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: NUMBERS_H };
  }
  // Splits and corners: on the line or the point between their numbers.
  const centres = numbers.map((n) => centreOf(numberBox(n)));
  return { x: centres.reduce((sum, c) => sum + c.x, 0) / centres.length, y: centres.reduce((sum, c) => sum + c.y, 0) / centres.length };
}

/** How close (in table units) a tap must be to a line or corner to bet on it rather than the number. */
const EDGE = 13;
const EDGE_SPOTS = Array.from(SPOTS.keys()).filter((spot) => !(OUTSIDE as readonly string[]).includes(spot) && (SPOTS.get(spot)?.length ?? 0) > 1);

/** The spot under a tap at (x, y) on the table, or null off the table. */
export function spotAt(x: number, y: number): string | null {
  if (x < 0 || y < 0 || x > TABLE_W || y > TABLE_H) return null;
  // A line or corner close by: splits, streets, corners, six lines and the bets with 0.
  if (y <= NUMBERS_H + EDGE && x <= ZERO_W + 12 * CELL + 2) {
    let best: string | null = null;
    let bestDistance = EDGE;
    for (const spot of EDGE_SPOTS) {
      const centre = spotCentre(spot);
      const distance = Math.hypot(centre.x - x, centre.y - y);
      if (distance < bestDistance) {
        best = spot;
        bestDistance = distance;
      }
    }
    if (best) return best;
  }
  if (y < NUMBERS_H) {
    if (x < ZERO_W) return "0";
    if (x < ZERO_W + 12 * CELL) {
      const column = Math.floor((x - ZERO_W) / CELL);
      const row = Math.floor(y / CELL);
      return String(column * 3 + (3 - row));
    }
  }
  for (const spot of OUTSIDE) {
    const box = outsideBox(spot);
    if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) return spot;
  }
  return null;
}
