import { createHmac } from "crypto";

/**
 * Bast.al's Scratch Cards. A card has 9 boxes; three of the same symbol win
 * that symbol's prize (PRIZES), and a card never has two winning symbols.
 * Each prize's chance is set out of a million, so a card pays back exactly
 * 90% of its price on average (payoutRate). The card is decided and paid
 * when it's bought; scratching only shows it. This file is the game's whole
 * definition, used as it is by the API and the tests, so what's tested is
 * what's played.
 *
 * Cards are provably fair, with the same seed pair as Dice, Keno and Coin
 * Flip. The card takes random numbers one at a time: the i-th (from 0) is
 * HMAC-SHA256 of the server seed and "clientSeed:nonce:i", its first 4
 * bytes read as a fraction of 1. The first picks the prize from the odds
 * (none, or one of PRIZES in order); the next fill the other boxes from the
 * symbols still allowed (at most two of each, and none more of the winning
 * one), each an index into that list; the last shuffle the 9 boxes
 * (Fisher-Yates, from the last box down).
 */

export const GAME_NAME = "Scratch Cards";

/** Boxes on a card. */
export const CELLS = 9;
/** What a card costs, in ALL, like every Casino game. The Player's max stake applies too. */
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;

export const SYMBOLS = ["CHERRY", "LEMON", "BELL", "CLOVER", "WATERMELON", "DIAMOND", "SEVEN", "CROWN"] as const;
export type ScratchSymbol = (typeof SYMBOLS)[number];

/** The chances below are out of this many cards. */
export const ODDS_OUT_OF = 1_000_000;

/** Each prize: the symbol that shows three times, what it pays in times the price, and how many cards in a million win it. */
export const PRIZES: ReadonlyArray<{ symbol: ScratchSymbol; multiplier: number; odds: number }> = [
  { symbol: "CHERRY", multiplier: 1, odds: 200_000 },
  { symbol: "LEMON", multiplier: 2, odds: 100_000 },
  { symbol: "BELL", multiplier: 5, odds: 40_000 },
  { symbol: "CLOVER", multiplier: 10, odds: 12_500 },
  { symbol: "WATERMELON", multiplier: 25, odds: 3_000 },
  { symbol: "DIAMOND", multiplier: 100, odds: 500 },
  { symbol: "SEVEN", multiplier: 500, odds: 60 },
  { symbol: "CROWN", multiplier: 1000, odds: 20 },
];

export const MAX_MULTIPLIER = Math.max(...PRIZES.map((prize) => prize.multiplier));

/** What a card pays back on average, in percent of its price: exact, from the odds. */
export function payoutRate(): number {
  return (PRIZES.reduce((sum, prize) => sum + prize.odds * prize.multiplier, 0) / ODDS_OUT_OF) * 100;
}

/** The chance a card wins something (its price back or more), in percent. */
export function winChance(): number {
  return (PRIZES.reduce((sum, prize) => sum + prize.odds, 0) / ODDS_OUT_OF) * 100;
}

/** What a card pays, in cents, for a price in cents. */
export const winCents = (stakeCents: number, multiplier: number) => stakeCents * multiplier;

/** The i-th random number for these seeds and nonce, from 0 up to 1. */
function randomAt(serverSeed: string, clientSeed: string, nonce: number, i: number): number {
  const bytes = createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}:${i}`).digest();
  return bytes[0] / 256 + bytes[1] / 256 ** 2 + bytes[2] / 256 ** 3 + bytes[3] / 256 ** 4;
}

export type Card = { cells: ScratchSymbol[]; symbol: ScratchSymbol | null; multiplier: number };

/** The card for a server seed, a client seed and a nonce: its 9 boxes, left to right and top to bottom, and its prize. */
export function cardFor(serverSeed: string, clientSeed: string, nonce: number): Card {
  let i = 0;
  const next = () => randomAt(serverSeed, clientSeed, nonce, i++);

  const roll = Math.floor(next() * ODDS_OUT_OF);
  let edge = 0;
  const prize = PRIZES.find((candidate) => roll < (edge += candidate.odds)) ?? null;

  const cells: ScratchSymbol[] = [];
  const counts = new Map<ScratchSymbol, number>();
  if (prize) {
    cells.push(prize.symbol, prize.symbol, prize.symbol);
    counts.set(prize.symbol, 3);
  }
  while (cells.length < CELLS) {
    const allowed = SYMBOLS.filter((symbol) => (counts.get(symbol) ?? 0) < 2);
    const symbol = allowed[Math.floor(next() * allowed.length)];
    cells.push(symbol);
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  for (let k = CELLS - 1; k > 0; k--) {
    const j = Math.floor(next() * (k + 1));
    [cells[k], cells[j]] = [cells[j], cells[k]];
  }
  return { cells, symbol: prize?.symbol ?? null, multiplier: prize?.multiplier ?? 0 };
}
