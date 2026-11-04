/**
 * Shtatat.al's Baccarat (punto banco), with the standard rules. The Player bets
 * on Player, Banker or Tie; two hands are dealt from a fresh 8-deck shoe and
 * the one closer to 9 wins. Cards count at face value, aces 1, tens and
 * pictures 0, and a hand counts its last digit (7 + 8 = 5). A third card is
 * drawn by the fixed tableau below; nobody chooses.
 *
 * Pays: Player 0.47 to 1, Banker 0.43 to 1, Tie 7 to 1. A tie returns Player
 * and Banker stakes. With the standard drawing rules that pays back about 75%
 * on every side (Player 75.5%, Banker 75.1%, Tie 76.1%).
 * This file is the game's whole definition, used by the API and the tests.
 */

export const GAME_NAME = "Baccarat";
export const SIDES = ["PLAYER", "BANKER", "TIE"] as const;
export type Side = (typeof SIDES)[number];
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;
export const DECKS = 8;

/** A card: rank 1 (ace) to 13 (king), suit 0 to 3 (♠ ♥ ♦ ♣). */
export type Card = { rank: number; suit: number };
export type Hand = { player: Card[]; banker: Card[]; playerTotal: number; bankerTotal: number; winner: Side };

export const cardValue = (card: Card) => (card.rank >= 10 ? 0 : card.rank);
export const total = (cards: Card[]) => cards.reduce((sum, card) => sum + cardValue(card), 0) % 10;

/** Whether the Banker draws a third card, given its total and the Player's third card (null if the Player stood). */
export function bankerDraws(bankerTotal: number, playerThird: Card | null): boolean {
  if (playerThird === null) return bankerTotal <= 5;
  const p = cardValue(playerThird);
  if (bankerTotal <= 2) return true;
  if (bankerTotal === 3) return p !== 8;
  if (bankerTotal === 4) return p >= 2 && p <= 7;
  if (bankerTotal === 5) return p >= 4 && p <= 7;
  if (bankerTotal === 6) return p === 6 || p === 7;
  return false;
}

/** Deals one hand from a fresh shoe; `draw(n)` picks one of the n cards left. */
export function deal(draw: (below: number) => number): Hand {
  const shoe: Card[] = [];
  for (let deck = 0; deck < DECKS; deck++) for (let suit = 0; suit < 4; suit++) for (let rank = 1; rank <= 13; rank++) shoe.push({ rank, suit });
  const next = () => shoe.splice(draw(shoe.length), 1)[0];
  const player = [next()];
  const banker = [next()];
  player.push(next());
  banker.push(next());
  const natural = total(player) >= 8 || total(banker) >= 8;
  let playerThird: Card | null = null;
  if (!natural) {
    if (total(player) <= 5) {
      playerThird = next();
      player.push(playerThird);
    }
    if (bankerDraws(total(banker), playerThird)) banker.push(next());
  }
  const playerTotal = total(player);
  const bankerTotal = total(banker);
  const winner: Side = playerTotal > bankerTotal ? "PLAYER" : bankerTotal > playerTotal ? "BANKER" : "TIE";
  return { player, banker, playerTotal, bankerTotal, winner };
}

/** What a bet on `side` pays back, in cents (stake included), for the hand's winner. */
export function payoutCents(stakeCents: number, side: Side, winner: Side): number {
  if (side === "TIE") return winner === "TIE" ? stakeCents * 8 : 0;
  if (winner === "TIE") return stakeCents;
  if (side !== winner) return 0;
  return stakeCents + Math.floor((stakeCents * (side === "PLAYER" ? 47 : 43)) / 100);
}

/** What each side pays back on average, in percent, with these rules (for the rules sheet). */
export const PAYOUT_RATES: Record<Side, number> = { PLAYER: 75.51, BANKER: 75.1, TIE: 76.12 };
