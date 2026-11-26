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
 * - Special bets (each paid spin costs more): Ante bet 1 lands lollipops more
 *   often; Ante bet 2 lands them more often still, and its free spins are super
 *   free spins 1. Super spins 1 and 2 have no lollipops, but every spin lands
 *   at least one multiplier candy (in super spins 2, 25x or more), and a spin
 *   that wins is multiplied by the multipliers on its final board.
 * - Super free spins 2 (bought): the multipliers of every free spin that
 *   wins add to a total that stays for the rest of the free spins, and each
 *   win is multiplied by that total.
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
export const PAYOUT_RATE = 84.7;
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

/**
 * How a round is played, and what it costs in times the bet:
 * - NORMAL: a paid spin (free spins if it lands 4 lollipops).
 * - ANTE1, ANTE2, SPINS1, SPINS2: the special bets, a paid spin that costs more (see the file's top).
 * - BUY: free spins bought outright, without the paid spin.
 * - SUPER1: super free spins 1 bought outright: no multiplier candy below 20x.
 * - SUPER2: super free spins 2 bought outright: no multiplier candy below 10x, and the
 *   multipliers of the spins that win add up to a total that multiplies every win after.
 * (Older rounds may say "SUPER": super free spins, never below 5x; or "ANTE": the old Special Bet, 25% more for
 * about twice the free spins.)
 */
export const MODES = ["NORMAL", "ANTE1", "ANTE2", "SPINS1", "SPINS2", "BUY", "SUPER1", "SUPER2"] as const;
export type Mode = (typeof MODES)[number];
export const COST: Record<Mode, number> = { NORMAL: 1, ANTE1: 2.5, ANTE2: 12, SPINS1: 20, SPINS2: 250, BUY: 100, SUPER1: 500, SUPER2: 1000 };
/** The special bets, from the Special Bets menu: each spin costs more while one is on. */
export const SPECIAL_MODES: readonly Mode[] = ["ANTE1", "ANTE2", "SPINS1", "SPINS2"];
/**
 * How many times as often the ante bets give free spins as a normal spin does, rounded, as measured by
 * scripts/candy-rtp.mjs (a normal spin: about 1 in 370; ante bet 1: 1 in 62; ante bet 2: 1 in 44). Shown in the menu.
 */
export const ANTE_CHANCE = { ANTE1: 6, ANTE2: 8 } as const;
/** The ways to buy free spins, from the Buy Feature menu. */
export const BOUGHT_MODES: readonly Mode[] = ["BUY", "SUPER1", "SUPER2"];
export const isBoughtMode = (mode: Mode) => BOUGHT_MODES.includes(mode);
/** Free spins can be bought only at a bet up to this, in ALL (so a purchase costs at most COST.SUPER2 times it). */
export const MAX_BUY_BET = 500;
/** The modes held to MAX_BUY_BET: the purchases, and the special bets that cost 10 times the bet or more. */
export const isLimitedMode = (mode: Mode) => COST[mode] >= 10;

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

/** In super free spins 1: no multiplier candy below 20x. */
export const SUPER1_MULTIPLIERS: Array<[value: number, weight: number]> = [
  [20, 100],
  [25, 50],
  [30, 30],
  [40, 16],
  [50, 10],
  [100, 3],
];

/** In super free spins 2: no multiplier candy below 10x (and they add up to a total that stays). */
export const SUPER2_MULTIPLIERS: Array<[value: number, weight: number]> = [
  [10, 100],
  [12, 60],
  [15, 40],
  [20, 24],
  [25, 12],
  [50, 4],
  [100, 1],
];

/** In super spins 1: the multiplier candies. */
export const SPINS1_MULTIPLIERS: Array<[value: number, weight: number]> = [
  [5, 100],
  [10, 80],
  [15, 50],
  [20, 30],
  [25, 20],
  [50, 8],
  [100, 3],
];

/** In super spins 2: the multiplier candy every spin is sure to land is 25x or more. */
export const SPINS2_MULTIPLIERS: Array<[value: number, weight: number]> = [
  [25, 31],
  [50, 51],
  [100, 70],
  [250, 29],
  [500, 10],
];

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
type Candies = Record<Paying | typeof SCATTER, number>;
type FreeCandies = Record<Paying | typeof SCATTER | "X", number>;
export const WEIGHTS: {
  base: Candies;
  ante1: Candies;
  ante2: Candies;
  spins1: FreeCandies;
  spins2: FreeCandies;
  free: FreeCandies;
  bought: FreeCandies;
  super1: FreeCandies;
  super2: FreeCandies;
} = {
  base: { HEART: 20, STAR: 30, MOON: 40, GEM: 50, ORANGE: 70, LEMON: 85, MINT: 100, GRAPE: 120, PEACH: 140, LOLLIPOP: 10 },
  // Ante bet 1, priced at COST.ANTE1: the same candies, more lollipops (in twentieths, so it can be set finely).
  ante1: { HEART: 400, STAR: 600, MOON: 800, GEM: 1000, ORANGE: 1400, LEMON: 1700, MINT: 2000, GRAPE: 2400, PEACH: 2800, LOLLIPOP: 343 },
  // Ante bet 2, priced at COST.ANTE2: more lollipops still, and its free spins are super free spins 1.
  ante2: { HEART: 400, STAR: 600, MOON: 800, GEM: 1000, ORANGE: 1400, LEMON: 1700, MINT: 2000, GRAPE: 2400, PEACH: 2800, LOLLIPOP: 383 },
  // Super spins 1 and 2: no lollipops; multiplier candies (X) on top of the one every spin is sure of.
  // (Super spins 1 in halves, so it can be set finely.)
  spins1: { HEART: 40, STAR: 60, MOON: 80, GEM: 100, ORANGE: 160, LEMON: 200, MINT: 260, GRAPE: 320, PEACH: 400, LOLLIPOP: 0, X: 29 },
  spins2: { HEART: 20, STAR: 30, MOON: 40, GEM: 50, ORANGE: 80, LEMON: 100, MINT: 130, GRAPE: 160, PEACH: 200, LOLLIPOP: 0, X: 40 },
  // Free spins land the low candies a little more often, so they win more often, and the multiplier candies (X) on top.
  free: { HEART: 20, STAR: 30, MOON: 40, GEM: 50, ORANGE: 80, LEMON: 100, MINT: 130, GRAPE: 160, PEACH: 200, LOLLIPOP: 13, X: 57 },
  // Bought free spins, priced at COST.BUY.
  bought: { HEART: 20, STAR: 30, MOON: 40, GEM: 50, ORANGE: 80, LEMON: 100, MINT: 130, GRAPE: 160, PEACH: 200, LOLLIPOP: 13, X: 43 },
  // Super free spins 1, priced at COST.SUPER1: multiplier candies from SUPER1_MULTIPLIERS.
  super1: { HEART: 20, STAR: 30, MOON: 40, GEM: 50, ORANGE: 80, LEMON: 100, MINT: 130, GRAPE: 160, PEACH: 200, LOLLIPOP: 13, X: 37 },
  // Super free spins 2, priced at COST.SUPER2: multiplier candies from SUPER2_MULTIPLIERS, adding up as they go.
  super2: { HEART: 20, STAR: 30, MOON: 40, GEM: 50, ORANGE: 80, LEMON: 100, MINT: 130, GRAPE: 160, PEACH: 200, LOLLIPOP: 13, X: 30 },
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

/** Which candies a spin draws from: a paid spin's, a special bet's, natural free spins', bought ones' or super ones'. */
export type Feel = "base" | "ante1" | "ante2" | "spins1" | "spins2" | "free" | "bought" | "super1" | "super2";
/** true and false still mean a free spin and a paid one. */
const feelOf = (feel: Feel | boolean): Feel => (feel === true ? "free" : feel === false ? "base" : feel);
const PAID_FEELS: readonly Feel[] = ["base", "ante1", "ante2", "spins1", "spins2"];
const isFreeFeel = (feel: Feel) => !PAID_FEELS.includes(feel);
/** Super spins: a paid spin that is sure of a multiplier candy, and is multiplied like a free spin. */
const isSpinsFeel = (feel: Feel) => feel === "spins1" || feel === "spins2";

type Table<T> = { entries: Array<[T, number]>; total: number };
const tableOf = <T>(entries: Array<[T, number]>): Table<T> => ({ entries, total: entries.reduce((sum, [, weight]) => sum + weight, 0) });
/** The weights as lists to draw from, made again only if the weights are replaced (the payout-rate script tries others). */
const FEELS: readonly Feel[] = ["base", "ante1", "ante2", "spins1", "spins2", "free", "bought", "super1", "super2"];
let tables: {
  from: object[];
  feel: Record<Feel, Table<Cell | "X">>;
  multipliers: Table<number>;
  super1: Table<number>;
  super2: Table<number>;
  spins1: Table<number>;
  spins2: Table<number>;
} | null = null;
function weightTables() {
  const from = [...FEELS.map((feel) => WEIGHTS[feel]), MULTIPLIERS, SUPER1_MULTIPLIERS, SUPER2_MULTIPLIERS, SPINS1_MULTIPLIERS, SPINS2_MULTIPLIERS];
  if (!tables || from.some((part, i) => tables!.from[i] !== part)) {
    // A weight of 0 (no lollipops in super spins) is left out, so it can't be drawn.
    const of = (weights: object) => tableOf((Object.entries(weights) as Array<[Cell | "X", number]>).filter(([, weight]) => weight > 0));
    tables = {
      from,
      feel: Object.fromEntries(FEELS.map((feel) => [feel, of(WEIGHTS[feel])])) as Record<Feel, Table<Cell | "X">>,
      multipliers: tableOf(MULTIPLIERS),
      super1: tableOf(SUPER1_MULTIPLIERS),
      super2: tableOf(SUPER2_MULTIPLIERS),
      spins1: tableOf(SPINS1_MULTIPLIERS),
      spins2: tableOf(SPINS2_MULTIPLIERS),
    };
  }
  return tables;
}

/** A multiplier candy, from the feel's own list. */
function dropMultiplier(feel: Feel, draw: Draw): Multiplier {
  const t = weightTables();
  const values = feel === "super1" ? t.super1 : feel === "super2" ? t.super2 : feel === "spins1" ? t.spins1 : feel === "spins2" ? t.spins2 : t.multipliers;
  return `X${pick(values.entries, values.total, draw)}` as Multiplier;
}

/** One new candy dropping in. */
function dropOne(feel: Feel, draw: Draw): Cell {
  const table = weightTables().feel[feel];
  const cell = pick(table.entries, table.total, draw);
  return cell === "X" ? dropMultiplier(feel, draw) : cell;
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
  /**
   * In a free spin or a super spin that won: the multipliers on the final board, added up (in super
   * free spins 2, the total so far, this spin's included). Otherwise 1.
   */
  multiplier: number;
  /** Super free spins 2 only: the total multiplier after this spin, which carries on to the next. */
  total?: number;
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
export function tumble(board: Board, wins: Win[], feel: Feel | boolean, draw: Draw): Board {
  const kind = feelOf(feel);
  const gone = new Set(wins.flatMap((win) => win.cells));
  const next: Board = [];
  for (let column = 0; column < COLUMNS; column++) {
    const kept: Cell[] = [];
    for (let row = 0; row < ROWS; row++) if (!gone.has(at(column, row))) kept.push(board[at(column, row)]);
    const fresh = Array.from({ length: ROWS - kept.length }, () => dropOne(kind, draw));
    next.push(...fresh, ...kept);
  }
  return next;
}

/** A fresh board. In super spins, one with no multiplier candy gets one, in a cell drawn at random. */
export function land(feel: Feel | boolean, draw: Draw = randomInt): Board {
  const kind = feelOf(feel);
  const board = Array.from({ length: CELLS }, () => dropOne(kind, draw));
  if (isSpinsFeel(kind) && !board.some(isMultiplier)) board[checked(draw, CELLS)] = dropMultiplier(kind, draw);
  return board;
}

/** What a finished spin's lollipops pay. */
export function scatterPayFor(count: number): number {
  if (count < 4) return 0;
  return SCATTER_PAYS[Math.min(count, 6) as 4 | 5 | 6];
}

/**
 * One spin, paid or free, with all its tumbles. crypto.randomInt unless a test or the simulation passes its own draw.
 * `carried`: in super free spins 2, the total multiplier the spins before this one built up.
 */
export function spinOnce(feel: Feel | boolean, draw: Draw = randomInt, start?: Board, carried?: number): SpinResult {
  const kind = feelOf(feel);
  const free = isFreeFeel(kind);
  let board = start ?? land(kind, draw);
  const steps: Step[] = [];
  let tumbleWin = 0;
  // A board always has 30 candies and every tumble takes 8 or more away, but new ones can win again: bounded all the same.
  for (let guard = 0; guard < 1000; guard++) {
    const wins = winsOn(board);
    steps.push({ board, wins });
    if (wins.length === 0) break;
    tumbleWin += wins.reduce((sum, win) => sum + win.pay, 0);
    board = tumble(board, wins, kind, draw);
  }
  const final = steps[steps.length - 1].board;
  const scatters = final.filter((cell) => cell === SCATTER).length;
  const scatterPay = scatterPayFor(scatters);
  const multiplies = free || isSpinsFeel(kind);
  const sum = multiplies ? final.reduce((total, cell) => total + multiplierOf(cell), 0) : 0;
  const freeSpinsWon = free ? (scatters >= SCATTERS_FOR_MORE ? MORE_FREE_SPINS : 0) : scatters >= SCATTERS_FOR_FREE ? FREE_SPINS : 0;
  if (carried !== undefined) {
    // Progressive: a winning spin's multipliers join the total, and the total multiplies its win.
    const total = carried + (tumbleWin > 0 ? sum : 0);
    const multiplier = tumbleWin > 0 && total > 0 ? total : 1;
    return { free, steps, scatters, scatterPay, tumbleWin, multiplier, total, win: tumbleWin * multiplier + scatterPay, freeSpinsWon };
  }
  const multiplier = multiplies && tumbleWin > 0 && sum > 0 ? sum : 1;
  return { free, steps, scatters, scatterPay, tumbleWin, multiplier, win: tumbleWin * multiplier + scatterPay, freeSpinsWon };
}

export type Round = {
  mode: Mode;
  /** Free spins bought outright (BUY, SUPER1, SUPER2), before any won again; 0 for a paid spin. */
  bought: number;
  /** The paid spin, then each free spin it gave, in order; a bought round has only free spins. */
  spins: SpinResult[];
  /** What the whole round pays, in hundredths of the bet, after the MAX_WIN cap. */
  win: number;
  /** Whether the cap was reached (the free spins stop there). */
  capped: boolean;
  /**
   * A bought round: the board shown before the free spins, with the lollipops that "give" them. It is only a
   * picture: it pays nothing and nothing on it wins (no candy 8 or more times).
   */
  intro?: Board;
};

/** The lollipops on a bought round's opening board. */
const INTRO_SCATTERS = 4;

/** A bought round's opening board: paying candies with no win among them, and four lollipops in four different columns. */
export function introBoard(draw: Draw = randomInt): Board {
  const counts = new Map<Cell, number>();
  const board: Board = [];
  for (let cell = 0; cell < CELLS; cell++) {
    let candy: Cell = PAYING[checked(draw, PAYING.length)];
    // Never 8 of one candy: it would look like a win that isn't paid.
    for (let tries = 0; (counts.get(candy) ?? 0) >= 7 && tries < 50; tries++) candy = PAYING[checked(draw, PAYING.length)];
    counts.set(candy, (counts.get(candy) ?? 0) + 1);
    board.push(candy);
  }
  const columns = Array.from({ length: COLUMNS }, (_, column) => column);
  for (let i = 0; i < INTRO_SCATTERS; i++) {
    const swap = i + checked(draw, COLUMNS - i);
    [columns[i], columns[swap]] = [columns[swap], columns[i]];
    board[at(columns[i], checked(draw, ROWS))] = SCATTER;
  }
  return board;
}

/** A paid spin and every free spin it gives, played out; or (BUY, SUPER1, SUPER2) the free spins bought, played out. */
export function play(draw: Draw = randomInt, mode: Mode = "NORMAL"): Round {
  const cap = MAX_WIN * 100;
  const bought = isBoughtMode(mode) ? FREE_SPINS : 0;
  const freeFeel: Feel = mode === "BUY" ? "bought" : mode === "SUPER1" || mode === "ANTE2" ? "super1" : mode === "SUPER2" ? "super2" : "free";
  const progressive = mode === "SUPER2";
  let carried = 0;
  const spins: SpinResult[] = [];
  let total = 0;
  let remaining = bought;
  if (!bought) {
    const paidFeel: Record<string, Feel> = { ANTE1: "ante1", ANTE2: "ante2", SPINS1: "spins1", SPINS2: "spins2" };
    const first = spinOnce(paidFeel[mode] ?? "base", draw);
    spins.push(first);
    total = first.win;
    remaining = first.freeSpinsWon;
  }
  let played = 0;
  while (remaining > 0 && total < cap && played < MAX_FREE_SPINS) {
    const next = spinOnce(freeFeel, draw, undefined, progressive ? carried : undefined);
    if (progressive) carried = next.total ?? carried;
    spins.push(next);
    total += next.win;
    played += 1;
    remaining += next.freeSpinsWon - 1;
  }
  // Drawn last, so the free spins themselves come out exactly as they would without it.
  const intro = bought ? { intro: introBoard(draw) } : {};
  return { mode, bought, spins, win: Math.min(total, cap), capped: total >= cap, ...intro };
}

/** What a round of this mode costs, in cents, for a bet in cents. */
export const costCents = (betCents: number, mode: Mode) => Math.round(betCents * COST[mode]);

/** What a round pays in cents, for a stake in cents, rounded down to the cent. */
export const winCents = (stakeCents: number, winHundredths: number) => Math.floor((stakeCents * winHundredths) / 100);

/** A round as stored and shown: the boards as short strings, to keep it small. */
export function record(round: Round) {
  return {
    mode: round.mode,
    bought: round.bought,
    win: round.win / 100,
    capped: round.capped,
    freeSpins: round.spins.filter((spin) => spin.free).length,
    ...(round.intro ? { intro: round.intro } : {}),
    spins: round.spins.map((spin) => ({
      free: spin.free,
      steps: spin.steps.map((step) => ({ board: step.board, wins: step.wins.map((win) => ({ symbol: win.symbol, count: win.count, cells: win.cells, pay: win.pay / 100 })) })),
      scatters: spin.scatters,
      scatterPay: spin.scatterPay / 100,
      tumbleWin: spin.tumbleWin / 100,
      multiplier: spin.multiplier,
      ...(spin.total !== undefined ? { total: spin.total } : {}),
      win: spin.win / 100,
      freeSpinsWon: spin.freeSpinsWon,
    })),
  };
}
