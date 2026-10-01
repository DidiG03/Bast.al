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
 * "Golazo", Bast.al's slot: 5 reels, 3 rows, 10 lines, football symbols.
 * The maths runs on pokie (github.com/sta-ger/pokie): it lands the reels and
 * works out every line and scatter win. This file is the game's whole
 * definition, used as it is by the API, the tests and the payout-rate
 * simulation (scripts/casino-rtp.mjs), so what's proved is what's played.
 *
 * Amounts here are in line bets: a spin costs LINES line bets, and a win of
 * 25 pays 25 line bets. The API turns them into money.
 */

export const REELS = 5;
export const ROWS = 3;
export const LINES = 10;
/** What spins pay back on average, in percent of what they cost, as measured (see REEL_MAKEUP). */
export const PAYOUT_RATE = 94.8;
/** What a spin can cost, in dollars. A line bet is a tenth of it. */
export const BETS = [0.5, 1, 2, 5, 10] as const;

export const SYMBOLS = ["SEVEN", "TROPHY", "BALL", "BOOT", "GLOVES", "FLAG", "YELLOW", "RED", "WILD", "GOAL"] as const;
export type SlotSymbol = (typeof SYMBOLS)[number];
/** Stands in for every symbol but the goal. */
export const WILD: SlotSymbol = "WILD";
/** Pays anywhere on the reels, and 3 or more give free spins. */
export const SCATTER: SlotSymbol = "GOAL";

type Paying = Exclude<SlotSymbol, "WILD" | "GOAL">;

/** Line wins, left to right from the first reel, in line bets: [3, 4, 5] in a row. */
export const LINE_PAYS: Record<Paying, [number, number, number]> = {
  SEVEN: [50, 250, 1500],
  TROPHY: [30, 150, 600],
  BALL: [20, 80, 300],
  BOOT: [16, 60, 200],
  GLOVES: [12, 40, 150],
  FLAG: [10, 30, 100],
  YELLOW: [8, 20, 60],
  RED: [5, 16, 50],
};

/** Goals anywhere, in line bets. */
export const SCATTER_PAYS: Record<3 | 4 | 5, number> = { 3: 10, 4: 50, 5: 250 };
/** Free spins for goals anywhere. Won again during free spins, they add up. */
export const FREE_SPINS: Record<3 | 4 | 5, number> = { 3: 8, 4: 12, 5: 20 };

/** The 10 lines: for each reel, which row (0 top, 2 bottom) the line runs through. */
export const LINE_SHAPES: number[][] = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
  [0, 1, 1, 1, 0],
];

/**
 * How many of each symbol are on each reel. Wilds only on the middle three.
 * Together with the pays above, this sets the payout rate: 94.8%, measured
 * over two runs of 10 million spins by scripts/casino-rtp.mjs (PAYOUT_RATE).
 * Change any number here, run it again, and update PAYOUT_RATE.
 */
const REEL_MAKEUP: Array<Record<SlotSymbol, number>> = [
  { SEVEN: 1, TROPHY: 2, BALL: 3, BOOT: 4, GLOVES: 5, FLAG: 6, YELLOW: 8, RED: 9, WILD: 0, GOAL: 2 },
  { SEVEN: 1, TROPHY: 2, BALL: 3, BOOT: 4, GLOVES: 5, FLAG: 6, YELLOW: 7, RED: 8, WILD: 3, GOAL: 2 },
  { SEVEN: 1, TROPHY: 2, BALL: 3, BOOT: 4, GLOVES: 5, FLAG: 6, YELLOW: 7, RED: 8, WILD: 3, GOAL: 2 },
  { SEVEN: 1, TROPHY: 2, BALL: 3, BOOT: 4, GLOVES: 5, FLAG: 6, YELLOW: 7, RED: 8, WILD: 3, GOAL: 2 },
  { SEVEN: 1, TROPHY: 2, BALL: 3, BOOT: 4, GLOVES: 5, FLAG: 6, YELLOW: 8, RED: 9, WILD: 0, GOAL: 2 },
];

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
  config.setWildSymbols([WILD]);
  config.setScatterSymbols([SCATTER]);
  config.setAvailableSymbols([...SYMBOLS]);
  config.setWildSubstitutions({ [WILD]: SYMBOLS.filter((symbol) => symbol !== WILD && symbol !== SCATTER) });
  config.setLinesDefinitions(new CustomLinesDefinitions().fromMap(Object.fromEntries(LINE_SHAPES.map((shape, index) => [String(index), shape]))));
  config.setLinesPatterns(new LeftToRightLinesPatterns(REELS, 3));
  config.setSymbolsSequences(REEL_STRIPS.map((strip) => new SymbolsSequence<SlotSymbol>().fromArray(strip)));

  const paytable = new Paytable<SlotSymbol>([1], SYMBOLS.filter((symbol) => symbol !== WILD), [WILD], REELS);
  for (const symbol of SYMBOLS) {
    if (symbol === WILD) continue;
    for (let count = 3; count <= REELS; count++) paytable.setPayoutForSymbol(symbol, count, 0);
  }
  for (const [symbol, pays] of Object.entries(LINE_PAYS) as Array<[Paying, [number, number, number]]>) {
    pays.forEach((pay, index) => paytable.setPayoutForSymbol(symbol, index + 3, pay));
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
  /** Goals anywhere, when there are 3 or more. */
  scatter: { count: number; cells: Array<[number, number]>; win: number } | null;
  freeSpins: number;
  /** Everything the round pays, in line bets. */
  win: number;
};

/** Plays one round. Uses crypto.randomInt unless a test or the simulation passes its own random source. */
export function playRound(rng: RandomNumberGenerating = secure): Round {
  const generator = new SymbolsCombinationsGenerator<SlotSymbol>(config, rng);
  const combination = generator.generateSymbolsCombination();
  const calculator = new VideoSlotWinCalculator<SlotSymbol>(config);
  calculator.calculateWin(1, combination);
  const grid = combination.toMatrix();

  const lines: WinningLine[] = Object.values(calculator.getWinningLines()).map((won) => {
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
  const goals = Math.min(cells.length, 5) as 3 | 4 | 5;
  const scatter = cells.length >= 3 ? { count: cells.length, cells, win: SCATTER_PAYS[goals] } : null;

  const lineWin = lines.reduce((sum, line) => sum + line.win, 0);
  return {
    grid,
    stops: generator.getLastStopPositions(),
    lines: lines.sort((a, b) => a.line - b.line),
    scatter,
    freeSpins: scatter ? FREE_SPINS[goals] : 0,
    win: lineWin + (scatter?.win ?? 0),
  };
}

/** The pay table in dollars for a bet, for the rules sheet. */
export function payTable(bet: number) {
  const lineBet = bet / LINES;
  const money = (lineBets: number) => Math.round(lineBets * lineBet * 100) / 100;
  return {
    lines: (Object.entries(LINE_PAYS) as Array<[Paying, [number, number, number]]>).map(([symbol, pays]) => ({ symbol, pays: pays.map(money) })),
    scatter: { symbol: SCATTER, pays: [3, 4, 5].map((count) => money(SCATTER_PAYS[count as 3 | 4 | 5])), freeSpins: [3, 4, 5].map((count) => FREE_SPINS[count as 3 | 4 | 5]) },
    wild: WILD,
    lineShapes: LINE_SHAPES,
  };
}
