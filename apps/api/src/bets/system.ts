import { Prisma, SelectionResult } from "@prisma/client";

/**
 * System bets: the same picks (from different matches) turned into every
 * combination of the chosen sizes, each one a small accumulator for the same
 * stake. A Yankee is 4 picks as every double, treble and the fourfold (11
 * bets); "2 from 4" is just the 6 doubles. A lost pick only loses the lines
 * it's in, and a void pick counts as 1.00 in its lines.
 *
 * Pure: no database. bets.service.ts places them, settlement.service.ts
 * settles them with systemOutcome.
 */

/** Fewest and most picks in a system. */
export const MIN_SYSTEM_PICKS = 3;
export const MAX_SYSTEM_PICKS = 8;
/** Smallest stake per line, in dollars. */
export const MIN_SYSTEM_LINE_STAKE = 0.1;

/** The named systems: how many picks, and the sizes of line they're made of (1 is the singles). */
const NAMED: Array<{ name: string; picks: number; sizes: number[] }> = [
  { name: "Trixie", picks: 3, sizes: [2, 3] },
  { name: "Patent", picks: 3, sizes: [1, 2, 3] },
  { name: "Yankee", picks: 4, sizes: [2, 3, 4] },
  { name: "Lucky 15", picks: 4, sizes: [1, 2, 3, 4] },
  { name: "Super Yankee", picks: 5, sizes: [2, 3, 4, 5] },
  { name: "Lucky 31", picks: 5, sizes: [1, 2, 3, 4, 5] },
  { name: "Heinz", picks: 6, sizes: [2, 3, 4, 5, 6] },
  { name: "Lucky 63", picks: 6, sizes: [1, 2, 3, 4, 5, 6] },
  { name: "Super Heinz", picks: 7, sizes: [2, 3, 4, 5, 6, 7] },
  { name: "Goliath", picks: 8, sizes: [2, 3, 4, 5, 6, 7, 8] },
];

const sameSizes = (a: number[], b: number[]) => a.length === b.length && a.every((size, i) => size === b[i]);

/** The sizes in order without repeats, or null if any can't be made from these picks (or there's only the full accumulator). */
export function normalSizes(picks: number, sizes: number[]): number[] | null {
  const sorted = [...new Set(sizes)].sort((a, b) => a - b);
  if (sorted.length === 0 || sorted.some((size) => !Number.isInteger(size) || size < 1 || size > picks)) return null;
  // Only the singles, or only the full accumulator, aren't systems.
  if (sameSizes(sorted, [1]) || sameSizes(sorted, [picks])) return null;
  return sorted;
}

/** A system's name: "Yankee", "2 from 4", or "2/3 from 5" for any other set of sizes. */
export function systemName(picks: number, sizes: number[]): string {
  const named = NAMED.find((system) => system.picks === picks && sameSizes(system.sizes, sizes));
  if (named) return named.name;
  return `${sizes.join("/")} from ${picks}`;
}

/** Every combination of `size` of the picks 0..picks-1, in order. */
export function combinations(picks: number, size: number): number[][] {
  const out: number[][] = [];
  const walk = (start: number, chosen: number[]) => {
    if (chosen.length === size) {
      out.push(chosen);
      return;
    }
    for (let i = start; i <= picks - (size - chosen.length); i++) walk(i + 1, [...chosen, i]);
  };
  walk(0, []);
  return out;
}

/** Every line of the system: which picks each one joins. */
export function systemLines(picks: number, sizes: number[]): number[][] {
  return sizes.flatMap((size) => combinations(picks, size));
}

/** One line's return at these prices, stake included, rounded down to the cent like any accumulator. */
function lineReturn(stake: Prisma.Decimal, odds: Prisma.Decimal[]): Prisma.Decimal {
  const price = odds.reduce((product, value) => product.mul(value), new Prisma.Decimal(1)).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  return stake.mul(price).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
}

/** The most a system can return, every pick winning, and its biggest line's price (for the accumulator cap). */
export function systemMaxReturn(odds: Prisma.Decimal[], sizes: number[], lineStake: Prisma.Decimal): { payout: Prisma.Decimal; topOdds: Prisma.Decimal } {
  const lines = systemLines(odds.length, sizes);
  const payout = lines.reduce((total, line) => total.add(lineReturn(lineStake, line.map((i) => odds[i]))), new Prisma.Decimal(0));
  const top = lines.reduce((best, line) => {
    const price = line.reduce((product, i) => product.mul(odds[i]), new Prisma.Decimal(1));
    return price.greaterThan(best) ? price : best;
  }, new Prisma.Decimal(0));
  return { payout, topOdds: top.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN) };
}

/**
 * Where a system stands from its picks: open while any pick is undecided
 * (unless every line has already lost), void when every pick is void,
 * otherwise what its winning lines pay. Won when that's more than nothing,
 * even if less than the stake; lost when it's nothing. `lines` says how many
 * lines won and how many there are, for the Player's bet card.
 */
export function systemOutcome(
  legs: Array<{ odds: Prisma.Decimal; result: SelectionResult | null }>,
  sizes: number[],
  lineStake: Prisma.Decimal,
): { status: "OPEN" | "WON" | "LOST" | "VOID"; payout: Prisma.Decimal; won: number; lines: number } {
  const lines = systemLines(legs.length, sizes);
  const zero = new Prisma.Decimal(0);
  const lost = (line: number[]) => line.some((i) => legs[i].result === SelectionResult.LOST);
  if (legs.some((leg) => leg.result === null)) {
    return { status: lines.every(lost) ? "LOST" : "OPEN", payout: zero, won: 0, lines: lines.length };
  }
  if (legs.every((leg) => leg.result === SelectionResult.VOID)) return { status: "VOID", payout: lineStake.mul(lines.length), won: 0, lines: lines.length };
  let payout = zero;
  let won = 0;
  for (const line of lines) {
    if (lost(line)) continue;
    won++;
    payout = payout.add(lineReturn(lineStake, line.map((i) => (legs[i].result === SelectionResult.VOID ? new Prisma.Decimal(1) : legs[i].odds))));
  }
  return { status: payout.greaterThan(0) ? "WON" : "LOST", payout, won, lines: lines.length };
}
