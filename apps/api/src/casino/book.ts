import { randomInt } from "crypto";

/**
 * Book of Ra (the Deluxe rules): 5 reels, 3 rows, 10 lines. This file is
 * the game's whole definition, used as it is by the API, the tests and the
 * payout-rate script (scripts/book-rtp.mjs), so what's measured is what's
 * played. It's pure: no database, no money.
 *
 * - The book is wild (it stands in for any symbol on a line) and scatter:
 *   3, 4 or 5 anywhere pay 2, 20 or 200 times the bet and give 10 free spins.
 * - Before the free spins, one symbol is drawn to be special. In a free
 *   spin, once the line wins are paid, the special symbol on enough reels
 *   to pay (anywhere on them, the reels needn't be next to each other)
 *   fills those reels and pays again on all 10 lines.
 * - 3 or more books in a free spin give 10 more, with the same symbol.
 * - A spin, or a whole round of free spins with the spin that started it,
 *   never pays more than MAX_WIN times the bet.
 *
 * Amounts here are in line bets: a spin costs LINES of them.
 */

export const GAME_NAME = "Book of Ra";
export const REELS = 5;
export const ROWS = 3;
export const LINES = 10;
/** What a spin can cost, in dollars. A line bet is a tenth of it. */
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;
/** What spins pay back on average, in percent of what they cost, as measured by scripts/book-rtp.mjs. */
export const PAYOUT_RATE = 90.1;
export const FREE_SPINS = 10;
/** The most a spin, or a round of free spins with the spin that started it, pays: this many times the bet. */
export const MAX_WIN = 5000;

export const SYMBOLS = ["EXPLORER", "PHARAOH", "STATUE", "SCARAB", "ACE", "KING", "QUEEN", "JACK", "TEN", "BOOK"] as const;
export type BookSymbol = (typeof SYMBOLS)[number];
export const BOOK: BookSymbol = "BOOK";
type Paying = Exclude<BookSymbol, "BOOK">;
export const PAYING: Paying[] = SYMBOLS.filter((symbol): symbol is Paying => symbol !== BOOK);

/** Line wins in line bets for [2, 3, 4, 5] of a kind from the first reel; 0 doesn't pay. */
export const LINE_PAYS: Record<Paying, [number, number, number, number]> = {
  EXPLORER: [10, 100, 1000, 0],
  PHARAOH: [5, 40, 400, 2000],
  STATUE: [5, 30, 100, 750],
  SCARAB: [5, 30, 100, 750],
  ACE: [0, 5, 40, 150],
  KING: [0, 5, 40, 150],
  QUEEN: [0, 5, 25, 100],
  JACK: [0, 5, 25, 100],
  TEN: [0, 5, 25, 100],
};

/** Books anywhere, in times the whole bet: 3, 4 and 5. */
export const SCATTER_PAYS: Record<3 | 4 | 5, number> = { 3: 2, 4: 20, 5: 200 };

/** The 10 lines: for each reel, which row (0 top, 2 bottom) the line runs through. */
export const LINE_SHAPES: number[][] = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [1, 2, 2, 2, 1],
  [1, 0, 0, 0, 1],
  [2, 2, 1, 0, 0],
  [0, 0, 1, 2, 2],
  [2, 1, 1, 1, 0],
];

/** How many reels the special symbol must be on to pay: as many as its smallest line win. */
export const minToPay = (symbol: Paying) => LINE_PAYS[symbol].findIndex((pay) => pay > 0) + 2;

/**
 * How many of each symbol are on each reel. With the pays above, this sets
 * the payout rate (PAYOUT_RATE), measured by scripts/book-rtp.mjs over 10
 * million rounds with their free spins. Change a number, run it again, and
 * update PAYOUT_RATE.
 */
const OUTER = { EXPLORER: 1, PHARAOH: 2, STATUE: 3, SCARAB: 3, ACE: 5, KING: 5, QUEEN: 6, JACK: 5, TEN: 5, BOOK: 1 };
const INNER = { ...OUTER, JACK: 6 };
/** The last two reels carry fewer of the higher symbols and more tens, so lines started on the first reels are finished less often. */
const LAST = { ...OUTER, PHARAOH: 1, STATUE: 2, SCARAB: 2, KING: 4, TEN: 11 };
const REEL_MAKEUP: Array<Record<BookSymbol, number>> = [OUTER, INNER, INNER, LAST, LAST];

/** Lays a reel out from its makeup, spreading each symbol evenly so the same one rarely sits next to itself. Always the same order. */
export function layOut(makeup: Record<BookSymbol, number>): BookSymbol[] {
  const size = SYMBOLS.reduce((sum, symbol) => sum + makeup[symbol], 0);
  const slots: Array<{ at: number; symbol: BookSymbol }> = [];
  SYMBOLS.forEach((symbol, order) => {
    for (let i = 0; i < makeup[symbol]; i++) slots.push({ at: ((i + 0.5) * size) / makeup[symbol] + order / 100, symbol });
  });
  return slots.sort((a, b) => a.at - b.at).map((slot) => slot.symbol);
}

/** The reels as they're printed: each one's symbols in order, wrapping round. */
export const REEL_STRIPS: BookSymbol[][] = REEL_MAKEUP.map(layOut);

export type Draw = (below: number) => number;

export type WinningLine = {
  /** Index into LINE_SHAPES. */
  line: number;
  symbol: Paying;
  /** How many in a row, from the first reel, books included. */
  count: number;
  /** [reel, row] of each symbol that counts. */
  cells: Array<[number, number]>;
  win: number;
};

export type Expansion = {
  symbol: Paying;
  /** The reels it fills. */
  reels: number[];
  /** It pays this on every line, LINES times in all. */
  perLine: number;
  win: number;
};

export type Spin = {
  /** grid[reel][row], top row first. */
  grid: BookSymbol[][];
  /** Where each reel stopped on its strip, so a spin can be checked later. */
  stops: number[];
  lines: WinningLine[];
  /** Books anywhere, when there are 3 or more. */
  scatter: { count: number; cells: Array<[number, number]>; win: number } | null;
  /** In a free spin: the special symbol filling its reels. */
  expansion: Expansion | null;
  /** Free spins this spin gives: FREE_SPINS for 3 books or more, else 0. */
  freeSpinsWon: number;
  /** Everything it pays, in line bets, before the MAX_WIN cap. */
  win: number;
};

const checked = (draw: Draw, below: number) => {
  const value = draw(below);
  if (!Number.isInteger(value) || value < 0 || value >= below) throw new Error("The draw is out of range");
  return value;
};

/** Lands the reels: each one stops at a random place on its strip. */
export function land(draw: Draw = randomInt): { grid: BookSymbol[][]; stops: number[] } {
  const stops = REEL_STRIPS.map((strip) => checked(draw, strip.length));
  const grid = REEL_STRIPS.map((strip, reel) => Array.from({ length: ROWS }, (_, row) => strip[(stops[reel] + row) % strip.length]));
  return { grid, stops };
}

/** One line's win: the first symbol that isn't a book, with the books standing in for it, from the first reel on. */
function lineWin(grid: BookSymbol[][], line: number): WinningLine | null {
  const shape = LINE_SHAPES[line];
  const symbols = shape.map((row, reel) => grid[reel][row]);
  const target = symbols.find((symbol) => symbol !== BOOK) as Paying | undefined;
  // All books: they pay as a scatter, not on the line.
  if (!target) return null;
  let count = 0;
  while (count < REELS && (symbols[count] === target || symbols[count] === BOOK)) count++;
  const win = count >= 2 ? LINE_PAYS[target][count - 2] : 0;
  if (win <= 0) return null;
  return { line, symbol: target, count, cells: shape.slice(0, count).map((row, reel) => [reel, row]), win };
}

/** The special symbol on enough reels to pay fills them, and pays on every line. */
export function expand(grid: BookSymbol[][], special: Paying): Expansion | null {
  const reels = grid.map((column, reel) => (column.includes(special) ? reel : -1)).filter((reel) => reel >= 0);
  if (reels.length < minToPay(special)) return null;
  const perLine = LINE_PAYS[special][reels.length - 2];
  return { symbol: special, reels, perLine, win: perLine * LINES };
}

/** Works out what a landed grid pays: lines, books, and in a free spin (`special` set) the expanding symbol. */
export function evaluate(grid: BookSymbol[][], special: Paying | null = null): Omit<Spin, "stops"> {
  const lines = LINE_SHAPES.map((_, line) => lineWin(grid, line)).filter((won): won is WinningLine => won !== null);
  const cells: Array<[number, number]> = [];
  grid.forEach((column, reel) => column.forEach((symbol, row) => symbol === BOOK && cells.push([reel, row])));
  const books = Math.min(cells.length, 5) as 3 | 4 | 5;
  const scatter = cells.length >= 3 ? { count: cells.length, cells, win: SCATTER_PAYS[books] * LINES } : null;
  const expansion = special ? expand(grid, special) : null;
  const win = lines.reduce((sum, line) => sum + line.win, 0) + (scatter?.win ?? 0) + (expansion?.win ?? 0);
  return { grid, lines, scatter, expansion, freeSpinsWon: scatter ? FREE_SPINS : 0, win };
}

/** How many times the reels may land again before a spin is given up. */
const LANDINGS = 1000;

/** Five explorers on a line (books standing in), or in a free spin the explorer on all 5 reels: the reels never stop that way. */
function fiveExplorers(grid: BookSymbol[][], special: Paying | null): boolean {
  const onLine = LINE_SHAPES.some((shape) => {
    const symbols = shape.map((row, reel) => grid[reel][row]);
    return symbols.includes("EXPLORER") && symbols.every((symbol) => symbol === "EXPLORER" || symbol === BOOK);
  });
  return onLine || (special === "EXPLORER" && grid.every((column) => column.includes("EXPLORER")));
}

/** One spin: a paid one, or (with `special`) a free one. crypto.randomInt unless a test or the simulation passes its own draw. */
export function spin(special: Paying | null = null, draw: Draw = randomInt): Spin {
  let landed = land(draw);
  for (let landing = 1; fiveExplorers(landed.grid, special); landing++) {
    if (landing >= LANDINGS) throw new Error("The reels couldn't land");
    landed = land(draw);
  }
  return { ...evaluate(landed.grid, special), stops: landed.stops };
}

/** Draws the special symbol for a round of free spins: any symbol but the book, each as likely. */
export function drawSpecial(draw: Draw = randomInt): Paying {
  return PAYING[checked(draw, PAYING.length)];
}

/** What can still be paid this round, in line bets, given what it has paid so far. */
export const roomLeft = (paidSoFar: number) => Math.max(0, MAX_WIN * LINES - paidSoFar);
