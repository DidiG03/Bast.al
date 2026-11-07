import { randomInt } from "crypto";

/**
 * Candy Cascade, Shtatat.al's own cascading slot. This file is the game's
 * whole definition, used as it is by the API, the tests and the payout-rate
 * script (scripts/candy-rtp.mjs), so what's measured is what's played. It's
 * pure: no database, no money.
 *
 * - 6 columns of 5 candies. No lines: 8 or more of one candy anywhere pay.
 * - Winning candies burst; the rest fall down and new ones drop in from the
 *   top, and the board pays again, as long as it has a win (a tumble).
 * - The lollipop is the scatter: 4, 5 or 6 or more anywhere (counted once the
 *   tumbles are over) pay 3, 5 or 100 times the bet, and 4 or more give 10
 *   free spins. 3 or more in a free spin give 5 more.
 * - In free spins, multiplier candies (2× to 100×) drop in too and stay put.
 *   When a free spin's tumbles end with a win, the multipliers on the board
 *   add up and multiply that spin's candy wins.
 * - A paid spin, with all the free spins it gives, never pays more than
 *   MAX_WIN times the bet. The free spins are played out at once, on the
 *   server, with the spin that gave them: nothing is left to finish.
 *
 * Amounts here are in hundredths of the bet (100 = the bet back).
 */

export const GAME_NAME = "Candy Cascade";
export const COLUMNS = 6;
export const ROWS = 5;
export const CELLS = COLUMNS * ROWS;
/** What a spin can cost, in ALL, like every Casino game. The Player's max stake applies too. */
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;
/** What spins pay back on average, in percent of what they cost, as measured by scripts/candy-rtp.mjs. */
export const PAYOUT_RATE = 84.9;
/** The fewest of one candy that pay. */
export const MIN_COUNT = 8;
export const FREE_SPINS = 10;
export const MORE_FREE_SPINS = 5;
/** Lollipops for free spins: in a paid spin, and in a free one. */
export const SCATTERS_FOR_FREE = 4;
export const SCATTERS_FOR_MORE = 3;
/** The most free spins one paid spin can play, however many times they're won again. */
export const MAX_FREE_SPINS = 100;
/** The most a paid spin, with its free spins, pays: this many times the bet. */
export const MAX_WIN = 5000;

export const PAYING = ["HEART", "STAR", "MOON", "GEM", "ORANGE", "LEMON", "MINT", "GRAPE", "PEACH"] as const;
export type Paying = (typeof PAYING)[number];
export const SCATTER = "LOLLIPOP";
/** A multiplier candy is written "X" and its value: "X2" to "X100". */
export type Multiplier = `X${number}`;
export type Cell = Paying | typeof SCATTER | Multiplier;

/** What 8–9, 10–11 and 12 or more of a candy pay, in hundredths of the bet. */
export const PAYS: Record<Paying, [number, number, number]> = {
  HEART: [1000, 2500, 5000],
  STAR: [250, 1000, 2500],
  MOON: [200, 500, 1500],
  GEM: [150, 200, 1200],
  ORANGE: [100, 150, 1000],
  LEMON: [80, 120, 800],
  MINT: [50, 100, 500],
  GRAPE: [40, 90, 400],
  PEACH: [25, 75, 200],
};

/** Lollipops anywhere, in hundredths of the bet: 4, 5, and 6 or more. */
export const SCATTER_PAYS: Record<4 | 5 | 6, number> = { 4: 300, 5: 500, 6: 10000 };

/** The multiplier candies and how often each lands, relative to the others. */
export const MULTIPLIERS: Array<[value: number, weight: number]> = [
  [2, 160],
  [3, 100],
  [4, 60],
  [5, 40],
  [6, 24],
  [8, 20],
  [10, 16],
  [12, 12],
  [15, 8],
  [20, 8],
  [25, 4],
  [50, 2],
  [100, 1],
];

/**
 * How often each candy lands, relative to the others, in a paid spin and in a
 * free one (where "X" is a multiplier candy). With the pays above, these set
 * the payout rate (PAYOUT_RATE), measured by scripts/candy-rtp.mjs: change a
 * number, run it again, and update PAYOUT_RATE.
 */
export const WEIGHTS: { base: Record<Paying | typeof SCATTER, number>; free: Record<Paying | typeof SCATTER | "X", number> } = {
  base: { HEART: 20, STAR: 30, MOON: 40, GEM: 50, ORANGE: 70, LEMON: 85, MINT: 100, GRAPE: 120, PEACH: 140, LOLLIPOP: 10 },
  // Free spins land the low candies a little more often, so they win more often, and the multiplier candies (X) on top.
  free: { HEART: 20, STAR: 30, MOON: 40, GEM: 50, ORANGE: 80, LEMON: 100, MINT: 130, GRAPE: 160, PEACH: 200, LOLLIPOP: 13, X: 57 },
};

export type Draw = (below: number) => number;

const checked = (draw: Draw, below: number) => {
  const value = draw(below);
  if (!Number.isInteger(value) || value < 0 || value >= below) throw new Error("The draw is out of range");
  return value;
};

/** Picks one entry of a weighted list. */
function pick<T>(entries: Array<[T, number]>, total: number, draw: Draw): T {
  let roll = checked(draw, total);
  for (const [value, weight] of entries) {
    if (roll < weight) return value;
    roll -= weight;
  }
  throw new Error("The weights don't add up");
}

type Table<T> = { entries: Array<[T, number]>; total: number };
const tableOf = <T>(entries: Array<[T, number]>): Table<T> => ({ entries, total: entries.reduce((sum, [, weight]) => sum + weight, 0) });
/** The weights as lists to draw from, made again only if the weights are replaced (the payout-rate script tries others). */
let tables: { from: [object, object, object]; base: Table<Cell>; free: Table<Cell | "X">; multipliers: Table<number> } | null = null;
function weightTables() {
  if (!tables || tables.from[0] !== WEIGHTS.base || tables.from[1] !== WEIGHTS.free || tables.from[2] !== MULTIPLIERS) {
    tables = {
      from: [WEIGHTS.base, WEIGHTS.free, MULTIPLIERS],
      base: tableOf(Object.entries(WEIGHTS.base) as Array<[Cell, number]>),
      free: tableOf(Object.entries(WEIGHTS.free) as Array<[Cell | "X", number]>),
      multipliers: tableOf(MULTIPLIERS),
    };
  }
  return tables;
}

/** One new candy dropping in. */
function dropOne(free: boolean, draw: Draw): Cell {
  const t = weightTables();
  if (!free) return pick(t.base.entries, t.base.total, draw);
  const cell = pick(t.free.entries, t.free.total, draw);
  return cell === "X" ? (`X${pick(t.multipliers.entries, t.multipliers.total, draw)}` as Multiplier) : cell;
}

export const isMultiplier = (cell: Cell): cell is Multiplier => cell.startsWith("X");
export const multiplierOf = (cell: Cell) => (isMultiplier(cell) ? Number(cell.slice(1)) : 0);

/** The board, column by column, top to bottom: cell (column, row) is at column * ROWS + row. */
export type Board = Cell[];
export const at = (column: number, row: number) => column * ROWS + row;

export type Win = {
  symbol: Paying;
  count: number;
  /** Where the winning candies are on the board. */
  cells: number[];
  /** In hundredths of the bet. */
  pay: number;
};

/** One look at the board: the candies that win on it (none on the last one). */
export type Step = { board: Board; wins: Win[] };

export type SpinResult = {
  free: boolean;
  /** The board as it landed, then after each tumble; every step but the last has wins. */
  steps: Step[];
  /** Lollipops on the final board. */
  scatters: number;
  scatterPay: number;
  /** The candy wins of all the tumbles, before any multiplier. */
  tumbleWin: number;
  /** In a free spin that won: the multipliers on the final board, added up. Otherwise 1. */
  multiplier: number;
  /** Everything this spin pays, in hundredths of the bet, before the MAX_WIN cap. */
  win: number;
  freeSpinsWon: number;
};

/** What a candy's count pays, in hundredths of the bet. */
export function payFor(symbol: Paying, count: number): number {
  if (count < MIN_COUNT) return 0;
  const band = count >= 12 ? 2 : count >= 10 ? 1 : 0;
  return PAYS[symbol][band];
}

/** The wins on a board: every candy with MIN_COUNT or more anywhere. */
export function winsOn(board: Board): Win[] {
  const cells = new Map<Paying, number[]>();
  board.forEach((cell, index) => {
    if ((PAYING as readonly string[]).includes(cell)) {
      const list = cells.get(cell as Paying) ?? [];
      list.push(index);
      cells.set(cell as Paying, list);
    }
  });
  const wins: Win[] = [];
  for (const symbol of PAYING) {
    const list = cells.get(symbol) ?? [];
    if (list.length >= MIN_COUNT) wins.push({ symbol, count: list.length, cells: list, pay: payFor(symbol, list.length) });
  }
  return wins;
}

/** The winning candies burst; in each column the rest fall to the bottom and new ones drop in above them. */
export function tumble(board: Board, wins: Win[], free: boolean, draw: Draw): Board {
  const gone = new Set(wins.flatMap((win) => win.cells));
  const next: Board = [];
  for (let column = 0; column < COLUMNS; column++) {
    const kept: Cell[] = [];
    for (let row = 0; row < ROWS; row++) if (!gone.has(at(column, row))) kept.push(board[at(column, row)]);
    const fresh = Array.from({ length: ROWS - kept.length }, () => dropOne(free, draw));
    next.push(...fresh, ...kept);
  }
  return next;
}

/** A fresh board. */
export function land(free: boolean, draw: Draw = randomInt): Board {
  return Array.from({ length: CELLS }, () => dropOne(free, draw));
}

/** What a finished spin's lollipops pay. */
export function scatterPayFor(count: number): number {
  if (count < 4) return 0;
  return SCATTER_PAYS[Math.min(count, 6) as 4 | 5 | 6];
}

/** One spin, paid or free, with all its tumbles. crypto.randomInt unless a test or the simulation passes its own draw. */
export function spinOnce(free: boolean, draw: Draw = randomInt, start?: Board): SpinResult {
  let board = start ?? land(free, draw);
  const steps: Step[] = [];
  let tumbleWin = 0;
  // A board always has 30 candies and every tumble takes 8 or more away, but new ones can win again: bounded all the same.
  for (let guard = 0; guard < 1000; guard++) {
    const wins = winsOn(board);
    steps.push({ board, wins });
    if (wins.length === 0) break;
    tumbleWin += wins.reduce((sum, win) => sum + win.pay, 0);
    board = tumble(board, wins, free, draw);
  }
  const final = steps[steps.length - 1].board;
  const scatters = final.filter((cell) => cell === SCATTER).length;
  const scatterPay = scatterPayFor(scatters);
  const sum = free ? final.reduce((total, cell) => total + multiplierOf(cell), 0) : 0;
  const multiplier = free && tumbleWin > 0 && sum > 0 ? sum : 1;
  const freeSpinsWon = free ? (scatters >= SCATTERS_FOR_MORE ? MORE_FREE_SPINS : 0) : scatters >= SCATTERS_FOR_FREE ? FREE_SPINS : 0;
  return { free, steps, scatters, scatterPay, tumbleWin, multiplier, win: tumbleWin * multiplier + scatterPay, freeSpinsWon };
}

export type Round = {
  /** The paid spin, then each free spin it gave, in order. */
  spins: SpinResult[];
  /** What the whole round pays, in hundredths of the bet, after the MAX_WIN cap. */
  win: number;
  /** Whether the cap was reached (the free spins stop there). */
  capped: boolean;
};

/** A paid spin and every free spin it gives, played out. */
export function play(draw: Draw = randomInt): Round {
  const cap = MAX_WIN * 100;
  const first = spinOnce(false, draw);
  const spins = [first];
  let total = first.win;
  let remaining = first.freeSpinsWon;
  let played = 0;
  while (remaining > 0 && total < cap && played < MAX_FREE_SPINS) {
    const next = spinOnce(true, draw);
    spins.push(next);
    total += next.win;
    played += 1;
    remaining += next.freeSpinsWon - 1;
  }
  return { spins, win: Math.min(total, cap), capped: total >= cap };
}

/** What a round pays in cents, for a stake in cents, rounded down to the cent. */
export const winCents = (stakeCents: number, winHundredths: number) => Math.floor((stakeCents * winHundredths) / 100);

/** A round as stored and shown: the boards as short strings, to keep it small. */
export function record(round: Round) {
  return {
    win: round.win / 100,
    capped: round.capped,
    freeSpins: round.spins.length - 1,
    spins: round.spins.map((spin) => ({
      free: spin.free,
      steps: spin.steps.map((step) => ({ board: step.board, wins: step.wins.map((win) => ({ symbol: win.symbol, count: win.count, cells: win.cells, pay: win.pay / 100 })) })),
      scatters: spin.scatters,
      scatterPay: spin.scatterPay / 100,
      tumbleWin: spin.tumbleWin / 100,
      multiplier: spin.multiplier,
      win: spin.win / 100,
      freeSpinsWon: spin.freeSpinsWon,
    })),
  };
}
