/**
 * System bets for the slip: the systems that can be made from a number of
 * picks, how many lines each has and the most it can return. The same rules
 * as the API's bets/system.ts, which prices and names the bet that's placed.
 */

export const MIN_SYSTEM_PICKS = 3;
export const MAX_SYSTEM_PICKS = 8;
/** Smallest stake per line, in dollars. */
export const MIN_SYSTEM_LINE_STAKE = 0.1;

export type SystemOption = {
  /** The line sizes, e.g. [2, 3, 4]; also the option's key as "2,3,4". */
  sizes: number[];
  /** A named system ("Yankee"), or null for "{size} from {picks}". */
  name: string | null;
  lines: number;
};

const NAMED: Record<number, Array<[string, number[]]>> = {
  3: [["Trixie", [2, 3]], ["Patent", [1, 2, 3]]],
  4: [["Yankee", [2, 3, 4]], ["Lucky 15", [1, 2, 3, 4]]],
  5: [["Super Yankee", [2, 3, 4, 5]], ["Lucky 31", [1, 2, 3, 4, 5]]],
  6: [["Heinz", [2, 3, 4, 5, 6]], ["Lucky 63", [1, 2, 3, 4, 5, 6]]],
  7: [["Super Heinz", [2, 3, 4, 5, 6, 7]]],
  8: [["Goliath", [2, 3, 4, 5, 6, 7, 8]]],
};

function choose(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return Math.round(result);
}

/** The systems for this many picks: "2 from N" up to "N-1 from N", then the named full covers. */
export function systemOptions(picks: number): SystemOption[] {
  if (picks < MIN_SYSTEM_PICKS || picks > MAX_SYSTEM_PICKS) return [];
  const options: SystemOption[] = [];
  for (let size = 2; size < picks; size++) options.push({ sizes: [size], name: null, lines: choose(picks, size) });
  for (const [name, sizes] of NAMED[picks] ?? []) options.push({ sizes, name, lines: sizes.reduce((sum, size) => sum + choose(picks, size), 0) });
  return options;
}

/** Every combination of `size` of the picks. */
function combinations(picks: number, size: number): number[][] {
  const out: number[][] = [];
  const walk = (start: number, chosen: number[]) => {
    if (chosen.length === size) return void out.push(chosen);
    for (let i = start; i <= picks - (size - chosen.length); i++) walk(i + 1, [...chosen, i]);
  };
  walk(0, []);
  return out;
}

/** The most a system returns, every pick winning: each line's price rounded down to the cent, times its stake, rounded down, like the server. In cents, to stay exact. */
export function systemMaxReturn(odds: number[], sizes: number[], lineStake: number): number {
  const stakeCents = Math.round(lineStake * 100);
  let total = 0;
  for (const size of sizes) {
    for (const line of combinations(odds.length, size)) {
      // Prices in hundredths, multiplied exactly, then rounded down to the cent.
      let product = BigInt(1);
      let scale = BigInt(1);
      for (const i of line) {
        product *= BigInt(Math.round(odds[i] * 100));
        scale *= BigInt(100);
      }
      const price = Number((product * BigInt(100)) / scale); // hundredths
      total += Math.floor((stakeCents * price) / 100);
    }
  }
  return total / 100;
}
