import {
  CustomLinesDefinitions,
  LeftToRightLinesPatterns,
  Paytable,
  SecureRandomNumberGenerator,
  SymbolsCombinationsGenerator,
  SymbolsSequence,
  VideoSlotConfig,
  VideoSlotWinCalculator,
  type RandomNumberGenerating,
} from "pokie";

/**
 * Bast.al's slot: a classic fruit game. 5 reels, 3 rows, 5 fixed lines,
 * fruit and sevens, a star that pays anywhere, no wilds and no free spins.
 * After a win the Player can try "double or nothing" (see casino.service.ts).
 * The maths runs on pokie (github.com/sta-ger/pokie): it lands the reels and
 * works out every line and scatter win. This file is the game's whole
 * definition, used as it is by the API, the tests and the payout-rate
 * simulation (scripts/casino-rtp.mjs), so what's proved is what's played.
 *
 * Amounts here are in line bets: a spin costs LINES line bets, and a win of
 * 25 pays 25 line bets. The API turns them into money.
 */

/** What Players see the game called. Change it here; the web app shows whatever this says. */
export const GAME_NAME = "Sizzling Hot";

export const REELS = 5;
export const ROWS = 3;
export const LINES = 5;
/** What spins pay back on average, in percent of what they cost, as measured (see REEL_MAKEUP). */
export const PAYOUT_RATE = 94.9;
/** What a spin can cost, in dollars. A line bet is a fifth of it. */
export const BETS = [0.5, 1, 2, 5, 10, 25] as const;

export const SYMBOLS = ["SEVEN", "MELON", "GRAPES", "PLUM", "ORANGE", "LEMON", "CHERRY", "STAR"] as const;
export type SlotSymbol = (typeof SYMBOLS)[number];
/** Pays anywhere on the reels, never on a line. */
export const SCATTER: SlotSymbol = "STAR";

type Paying = Exclude<SlotSymbol, "STAR">;

/**
 * Line wins, left to right from the first reel, in line bets: [2, 3, 4, 5]
 * in a row. 0 means that many don't pay; only cherries pay for 2.
 */
export const LINE_PAYS: Record<Paying, [number, number, number, number]> = {
  SEVEN: [0, 100, 1000, 0],
  MELON: [0, 40, 120, 700],
  GRAPES: [0, 40, 120, 700],
  PLUM: [0, 10, 40, 200],
  ORANGE: [0, 10, 40, 200],
  LEMON: [0, 10, 40, 200],
  CHERRY: [5, 10, 40, 200],
};

/** Stars anywhere, in line bets: 2, 10 and 50 times the whole bet. */
export const SCATTER_PAYS: Record<3 | 4 | 5, number> = { 3: 10, 4: 50, 5: 250 };

/** The 5 lines: for each reel, which row (0 top, 2 bottom) the line runs through. */
export const LINE_SHAPES: number[][] = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
];

/**
 * How many of each symbol are on each reel. Together with the pays above,
 * this sets the payout rate (PAYOUT_RATE), measured over 10 million spins
 * by scripts/casino-rtp.mjs. Change any number here, run it again, and
 * update PAYOUT_RATE.
 */
const REEL_MAKEUP: Array<Record<SlotSymbol, number>> = Array.from({ length: REELS }, () => ({
  SEVEN: 3,
  MELON: 6,
  GRAPES: 6,
  PLUM: 4,
  ORANGE: 6,
  LEMON: 10,
  CHERRY: 8,
  STAR: 2,
}));

/**
 * Lays a reel out from its makeup, spreading each symbol as evenly as it
 * can so the same symbol rarely sits next to itself. Always the same order
 * for the same makeup.
 */
function layOut(makeup: Record<SlotSymbol, number>): SlotSymbol[] {
  const size = SYMBOLS.reduce((sum, symbol) => sum + makeup[symbol], 0);
  const slots: Array<{ at: number; symbol: SlotSymbol }> = [];
  SYMBOLS.forEach((symbol, order) => {
    const count = makeup[symbol];
    for (let i = 0; i < count; i++) slots.push({ at: ((i + 0.5) * size) / count + order / 100, symbol });
  });
  return slots.sort((a, b) => a.at - b.at).map((slot) => slot.symbol);
}

/** The reels as they're printed: each one's symbols in order, wrapping round. */
export const REEL_STRIPS: SlotSymbol[][] = REEL_MAKEUP.map(layOut);

function buildConfig(): VideoSlotConfig<SlotSymbol> {
  const config = new VideoSlotConfig<SlotSymbol>();
  config.setAvailableBets([1]);
  config.setReelsNumber(REELS);
  config.setReelsSymbolsNumber(ROWS);
  config.setWildSymbols([]);
  config.setScatterSymbols([SCATTER]);
  config.setAvailableSymbols([...SYMBOLS]);
  config.setLinesDefinitions(new CustomLinesDefinitions().fromMap(Object.fromEntries(LINE_SHAPES.map((shape, index) => [String(index), shape]))));
  // Lines are checked from 2 in a row; anything the pays below leave at 0 doesn't count as a win.
  config.setLinesPatterns(new LeftToRightLinesPatterns(REELS, 2));
  config.setSymbolsSequences(REEL_STRIPS.map((strip) => new SymbolsSequence<SlotSymbol>().fromArray(strip)));

  const paytable = new Paytable<SlotSymbol>([1], [...SYMBOLS], [], REELS);
  for (const symbol of SYMBOLS) {
    for (let count = 2; count <= REELS; count++) paytable.setPayoutForSymbol(symbol, count, 0);
  }
  for (const [symbol, pays] of Object.entries(LINE_PAYS) as Array<[Paying, number[]]>) {
    pays.forEach((pay, index) => paytable.setPayoutForSymbol(symbol, index + 2, pay));
  }
  for (const [count, pay] of Object.entries(SCATTER_PAYS)) paytable.setPayoutForSymbol(SCATTER, Number(count), pay);
  config.setPaytable(paytable);
  return config;
}

const config = buildConfig();
const secure = new SecureRandomNumberGenerator();

export type WinningLine = {
  /** Index into LINE_SHAPES. */
  line: number;
  symbol: SlotSymbol;
  /** How many in a row, from the first reel. */
  count: number;
  /** [reel, row] of each symbol that counts. */
  cells: Array<[number, number]>;
  /** In line bets. */
  win: number;
};

export type Round = {
  /** grid[reel][row], top row first. */
  grid: SlotSymbol[][];
  /** Where each reel stopped on its strip, so a round can be checked later. */
  stops: number[];
  lines: WinningLine[];
  /** Stars anywhere, when there are 3 or more. */
  scatter: { count: number; cells: Array<[number, number]>; win: number } | null;
  /** Everything the round pays, in line bets. */
  win: number;
};

/** How many times the reels may land again before a round is given up. */
const LANDINGS = 1000;

/** Five sevens on a line: the reels never stop that way. */
const fiveSevens = (grid: SlotSymbol[][]) => LINE_SHAPES.some((shape) => shape.every((row, reel) => grid[reel][row] === "SEVEN"));

/** Plays one round. Uses crypto.randomInt unless a test or the simulation passes its own random source. */
export function playRound(rng: RandomNumberGenerating = secure): Round {
  const generator = new SymbolsCombinationsGenerator<SlotSymbol>(config, rng);
  let combination = generator.generateSymbolsCombination();
  for (let landing = 1; fiveSevens(combination.toMatrix()); landing++) {
    if (landing >= LANDINGS) throw new Error("The reels couldn't land");
    combination = generator.generateSymbolsCombination();
  }
  const calculator = new VideoSlotWinCalculator<SlotSymbol>(config);
  calculator.calculateWin(1, combination);
  const grid = combination.toMatrix();

  const lines: WinningLine[] = Object.values(calculator.getWinningLines())
    .filter((won) => won.getWinAmount() > 0)
    .map((won) => {
      const shape = LINE_SHAPES[Number(won.getLineId())];
      return {
        line: Number(won.getLineId()),
        symbol: won.getSymbolId(),
        count: won.getSymbolsPositions().length,
        cells: won.getSymbolsPositions().map((reel) => [reel, shape[reel]] as [number, number]),
        win: won.getWinAmount(),
      };
    });

  const cells: Array<[number, number]> = [];
  grid.forEach((column, reel) => column.forEach((symbol, row) => symbol === SCATTER && cells.push([reel, row])));
  const stars = Math.min(cells.length, 5) as 3 | 4 | 5;
  const scatter = cells.length >= 3 ? { count: cells.length, cells, win: SCATTER_PAYS[stars] } : null;

  const lineWin = lines.reduce((sum, line) => sum + line.win, 0);
  return {
    grid,
    stops: generator.getLastStopPositions(),
    lines: lines.sort((a, b) => a.line - b.line),
    scatter,
    win: lineWin + (scatter?.win ?? 0),
  };
}

/** Double or nothing: at most this many guesses in a row, and never for more than this much (dollars). */
export const GAMBLE_STEPS = 5;
export const GAMBLE_LIMIT = 500;

export const SUITS = ["HEARTS", "DIAMONDS", "CLUBS", "SPADES"] as const;
export type Suit = (typeof SUITS)[number];
export type CardColor = "RED" | "BLACK";
export const colorOf = (suit: Suit): CardColor => (suit === "HEARTS" || suit === "DIAMONDS" ? "RED" : "BLACK");
