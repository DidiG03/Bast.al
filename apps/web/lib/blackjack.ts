/**
 * Blackjack in the browser: card names and hand totals, for showing the
 * dealer's cards one at a time. The API (apps/api/src/casino/blackjack.ts)
 * deals, decides and pays; nothing here changes a result.
 */

export const SUIT_SYMBOLS: Record<string, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const isRedSuit = (card: string) => card[1] === "H" || card[1] === "D";
/** The rank as printed on the card: "10" for a ten. */
export const rankLabel = (card: string) => (card[0] === "T" ? "10" : card[0]);

const value = (card: string) => (card[0] === "A" ? 1 : "TJQK".includes(card[0]) ? 10 : Number(card[0]));

/** A hand's best total, and whether an ace in it counts 11. */
export function handTotal(cards: string[]): { total: number; soft: boolean } {
  const hard = cards.reduce((sum, card) => sum + value(card), 0);
  const soft = cards.some((card) => card[0] === "A") && hard + 10 <= 21;
  return { total: soft ? hard + 10 : hard, soft };
}
