/**
 * Scratch Cards in the browser: the same card as the API's
 * (apps/api/src/casino/scratch.ts), so a Player can check any card from its
 * seeds once the server seed is shown. The API makes every card and pays it;
 * this file never makes one.
 */

import type { ScratchSymbol } from "./api";

export const CELLS = 9;
export const SYMBOLS: ScratchSymbol[] = ["CHERRY", "LEMON", "BELL", "CLOVER", "WATERMELON", "DIAMOND", "SEVEN", "CROWN"];
const ODDS_OUT_OF = 1_000_000;
/** Each prize's symbol and how many cards in a million win it, in the API's order. */
const ODDS: Array<[ScratchSymbol, number]> = [
  ["CHERRY", 200_000],
  ["LEMON", 100_000],
  ["BELL", 40_000],
  ["CLOVER", 12_500],
  ["WATERMELON", 3_000],
  ["DIAMOND", 500],
  ["SEVEN", 60],
  ["CROWN", 20],
];

/** Each symbol's picture. */
export const SYMBOL_ART: Record<ScratchSymbol, string> = {
  CHERRY: "🍒",
  LEMON: "🍋",
  BELL: "🔔",
  CLOVER: "🍀",
  WATERMELON: "🍉",
  DIAMOND: "💎",
  SEVEN: "7",
  CROWN: "👑",
};

/** Each symbol's name, to translate. */
export const SYMBOL_NAMES: Record<ScratchSymbol, string> = {
  CHERRY: "Cherry",
  LEMON: "Lemon",
  BELL: "Bell",
  CLOVER: "Clover",
  WATERMELON: "Watermelon",
  DIAMOND: "Diamond",
  SEVEN: "Seven",
  CROWN: "Crown",
};

/** The card these seeds and this nonce make: the i-th random number is HMAC-SHA256(serverSeed, "clientSeed:nonce:i"), first 4 bytes as a fraction. */
export async function cardFromSeeds(serverSeed: string, clientSeed: string, nonce: number): Promise<{ cells: ScratchSymbol[]; symbol: ScratchSymbol | null }> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(serverSeed), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  let i = 0;
  const next = async () => {
    const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${clientSeed}:${nonce}:${i++}`)));
    return bytes[0] / 256 + bytes[1] / 256 ** 2 + bytes[2] / 256 ** 3 + bytes[3] / 256 ** 4;
  };

  const roll = Math.floor((await next()) * ODDS_OUT_OF);
  let edge = 0;
  const prize = ODDS.find(([, odds]) => roll < (edge += odds))?.[0] ?? null;

  const cells: ScratchSymbol[] = [];
  const counts = new Map<ScratchSymbol, number>();
  if (prize) {
    cells.push(prize, prize, prize);
    counts.set(prize, 3);
  }
  while (cells.length < CELLS) {
    const allowed = SYMBOLS.filter((symbol) => (counts.get(symbol) ?? 0) < 2);
    const symbol = allowed[Math.floor((await next()) * allowed.length)];
    cells.push(symbol);
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  for (let k = CELLS - 1; k > 0; k--) {
    const j = Math.floor((await next()) * (k + 1));
    [cells[k], cells[j]] = [cells[j], cells[k]];
  }
  return { cells, symbol: prize };
}
