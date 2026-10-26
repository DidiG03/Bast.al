/**
 * Shtatat.al's Mines. A 5 by 5 field with mines hidden on it. The Player opens
 * tiles; each safe one raises the multiplier, and they can cash out at any
 * time after the first. A mine loses the stake. This file is the game's
 * whole definition, used as it is by the API and the tests, so what's
 * tested is what's played.
 *
 * The multiplier after k safe tiles is the fair price of surviving them
 * (the tiles left, over the safe tiles left, at each step) times 85%,
 * floored to the cent. That 15% is the house edge: before the cents are
 * floored, cashing out after any number of tiles pays back 85% on average.
 * With few mines the fair price of the early safe tiles is only just over
 * 1, so 85% of it would pay less than the stake (one mine, two tiles, is
 * 0.92×). Every cash-out after a safe tile is held at 1.01× at least,
 * whichever mine count was picked. A round pays at most 5,000 times the bet.
 */

export const GAME_NAME = "Mines";

export const COLUMNS = 5;
export const TILES = 25;
/** How many mines a round can hide. */
export const MINE_COUNTS = [1, 3, 5, 10, 15, 20, 24] as const;
/** What a round can cost, in dollars. The same chips as the fruit slot. */
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;
/** The house's edge: 15%, so a round pays back 85% on average, except where that would pay 1.00× or less. Those cash-outs are held at 1.01×. */
export const HOUSE_EDGE = 0.15;
/** No cash-out after a safe tile pays at 1.00× or below, in hundredths (101 is 1.01×). */
const MIN_PAYOUT = 101n;
/** What a round pays back on average, in percent of the stake, before cents are floored. */
export const PAYOUT_RATE = 85;
/** The most a round pays, in times the bet. */
export const MAX_WIN = 5000;

export type Phase = "PLAY" | "WON" | "LOST";
export type TileState = "hidden" | "gem" | "mine" | "hit";

/** A round still being played, or just finished. `mineTiles` stays on the server until the round ends. Amounts are cents. */
export type Round = {
  bet: number;
  mines: number;
  mineTiles: number[];
  /** Safe tiles opened, in the order they were opened. */
  revealed: number[];
  /** The tile that hit a mine, once the round is lost. */
  bust: number | null;
  phase: Phase;
  /** Cents paid back, once the round is over. 0 when it's lost. */
  payout: number;
  capped: boolean;
};

/** A round as the Player may see it. Hidden tiles give nothing away while it's still going. */
export type RoundView = {
  phase: Phase;
  mines: number;
  bet: number;
  opened: number;
  /** The cash-out multiplier now: 1 before any tile, and the paid one once the round is over. */
  multiplier: number;
  /** The multiplier after one more safe tile. Null once the round is over. */
  nextMultiplier: number | null;
  /** Dollars paid back if they cash out now, or what the finished round paid. */
  cashout: number;
  capped: boolean;
  tiles: TileState[];
};

export class MinesError extends Error {}

const money = (cents: number) => Math.round(cents) / 100;

/** The multiplier after `opened` safe tiles, in hundredths (110 is 1.10), floored, and never past MAX_WIN. */
export function multiplierHundredths(mines: number, opened: number): number {
  if (opened <= 0) return 100;
  const safe = TILES - mines;
  let num = BigInt(PAYOUT_RATE);
  let den = 1n;
  for (let step = 0; step < opened; step++) {
    num *= BigInt(TILES - step);
    den *= BigInt(safe - step);
  }
  const raw = num / den;
  const hundredths = raw < MIN_PAYOUT ? MIN_PAYOUT : raw;
  const cap = BigInt(MAX_WIN) * 100n;
  return Number(hundredths > cap ? cap : hundredths);
}

/** What cashing out after `opened` safe tiles pays, in cents, floored, and never past MAX_WIN times the stake. */
export function payoutCents(stakeCents: number, mines: number, opened: number): number {
  if (opened <= 0) return 0;
  const raw = Math.floor((stakeCents * multiplierHundredths(mines, opened)) / 100);
  return Math.min(raw, stakeCents * MAX_WIN);
}

/** Hides `count` mines on the field. `draw(n)` returns an integer from 0 up to, but not including, n. */
export function placeMines(count: number, draw: (below: number) => number): number[] {
  const tiles = Array.from({ length: TILES }, (_, index) => index);
  for (let index = 0; index < count; index++) {
    const swap = index + draw(TILES - index);
    const held = tiles[index];
    tiles[index] = tiles[swap];
    tiles[swap] = held;
  }
  return tiles.slice(0, count).sort((a, b) => a - b);
}

/** Starts a round: the bet (cents) down, the mines placed, nothing opened yet. */
export function startRound(betCents: number, mines: number, draw: (below: number) => number): Round {
  if (!(MINE_COUNTS as readonly number[]).includes(mines)) throw new MinesError("Pick 1, 3, 5, 10, 15, 20 or 24 mines.");
  return { bet: betCents, mines, mineTiles: placeMines(mines, draw), revealed: [], bust: null, phase: "PLAY", payout: 0, capped: false };
}

function finish(round: Round, phase: "WON" | "LOST", bust: number | null): Round {
  const capped = phase === "WON" && multiplierHundredths(round.mines, round.revealed.length) >= MAX_WIN * 100;
  return { ...round, phase, bust, payout: phase === "WON" ? payoutCents(round.bet, round.mines, round.revealed.length) : 0, capped };
}

/** Opens one tile. A mine ends the round for nothing; the last safe tile, or the win cap, cashes it out. */
export function reveal(round: Round, tile: number): Round {
  if (round.phase !== "PLAY") throw new MinesError("This round is already over.");
  if (!Number.isInteger(tile) || tile < 0 || tile >= TILES) throw new MinesError("That isn't a tile on the board.");
  if (round.revealed.includes(tile)) throw new MinesError("That tile is already open.");
  if (round.mineTiles.includes(tile)) return finish(round, "LOST", tile);
  const next: Round = { ...round, revealed: [...round.revealed, tile] };
  const cleared = next.revealed.length >= TILES - next.mines;
  const capped = multiplierHundredths(next.mines, next.revealed.length) >= MAX_WIN * 100;
  if (cleared || capped) return finish(next, "WON", null);
  return next;
}

/** Takes the win so far. The first tile has to be open. */
export function cashOut(round: Round): Round {
  if (round.phase !== "PLAY") throw new MinesError("This round is already over.");
  if (round.revealed.length === 0) throw new MinesError("Open a tile before you cash out.");
  return finish(round, "WON", null);
}

/** The round with the mines hidden until it's over, when every tile shows. */
export function publicView(round: Round): RoundView {
  const done = round.phase !== "PLAY";
  const mines = new Set(round.mineTiles);
  const opened = new Set(round.revealed);
  const tiles: TileState[] = Array.from({ length: TILES }, (_, index) => {
    if (!done) return opened.has(index) ? "gem" : "hidden";
    if (index === round.bust) return "hit";
    if (mines.has(index)) return "mine";
    return "gem";
  });
  const hundredths = multiplierHundredths(round.mines, round.revealed.length);
  const next = round.phase === "PLAY" ? multiplierHundredths(round.mines, round.revealed.length + 1) : null;
  return {
    phase: round.phase,
    mines: round.mines,
    bet: money(round.bet),
    opened: round.revealed.length,
    multiplier: hundredths / 100,
    nextMultiplier: next === null ? null : next / 100,
    cashout: money(round.phase === "PLAY" ? payoutCents(round.bet, round.mines, round.revealed.length) : round.payout),
    capped: round.capped,
    tiles,
  };
}
