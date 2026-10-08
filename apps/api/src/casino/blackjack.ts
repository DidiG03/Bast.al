import { randomInt } from "crypto";

/**
 * Bast.al's blackjack. This file is the game's whole definition: the shoe,
 * the hand values, every move and the pay-outs. It's pure (no database, no
 * money), used as it is by the API, the tests and the payout-rate script
 * (scripts/blackjack-rtp.mjs), so what's measured is what's played.
 *
 * The rules:
 * - A fresh 6-deck shoe, shuffled for every round, so nothing carries over.
 * - One hand per round. The dealer takes a card face down. With an ace
 *   showing, the dealer offers insurance, then looks at that card: a
 *   blackjack is turned over at once and ends the round. Otherwise the
 *   dealer doesn't look until the Player has played: a blackjack under a
 *   ten showing shows only then, and beats every hand but a blackjack,
 *   doubles and splits included.
 * - The dealer stands on every 17, soft 17 included.
 * - Blackjack pays 3 to 2 at once (a tie if the dealer has one too), a win
 *   1 to 1, a tie returns the bet.
 * - Insurance, when the dealer shows an ace: half the bet, pays 2 to 1 if
 *   the face-down card makes blackjack. Settled when the dealer looks.
 * - One split per round, of two cards of the same rank (two kings, not a
 *   king and a queen), and one double down per round: on the first two
 *   cards, or on one of the split hands. Split aces get one card each. 21
 *   on a split hand isn't blackjack.
 * RULES holds the settings that set the house's edge.
 *
 * Money here is in cents, so every amount stays a whole number.
 */

export const GAME_NAME = "Blackjack";
export const DECKS = 6;
/** What the round pays back on average with perfect play, in percent, as measured by scripts/blackjack-rtp.mjs. */
export const PAYOUT_RATE = 99.5;
/** The rules that set the house's edge. Kept together so the payout-rate script can measure other settings. */
export const RULES = {
  /** What a blackjack pays, as [to win, for every]: [3, 2] is 3 to 2. */
  blackjackPays: [3, 2] as [number, number],
  /** Whether the dealer draws on a soft 17. */
  dealerHitsSoft17: false,
  /** The hard totals a double down is allowed on; null for any first two cards. */
  doubleOn: null as number[] | null,
  /** Whether a split hand may be doubled. */
  doubleAfterSplit: true,
  /** The pairs that may be split, by card value (1 is aces, 10 a pair of tens, jacks, queens or kings); null for every pair. */
  splitPairs: null as number[] | null,
};

/** The chips, in dollars. A bet is a sum of them. */
export const CHIPS = [0.5, 1, 2, 5, 10, 25] as const;
/** The most a first bet can be when the Player has no max stake set. */
export const TABLE_MAX = 100;

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"] as const;
const SUITS = ["S", "H", "D", "C"] as const;
/** A card: rank then suit, "AS" (ace of spades), "TD" (ten of diamonds). */
export type Card = `${(typeof RANKS)[number]}${(typeof SUITS)[number]}`;

/** A full shoe, shuffled with crypto.randomInt unless a test passes its own draw. The next card is the last one. */
export function newShoe(draw: (below: number) => number = randomInt): Card[] {
  const shoe: Card[] = [];
  for (let deck = 0; deck < DECKS; deck++) for (const suit of SUITS) for (const rank of RANKS) shoe.push(`${rank}${suit}`);
  // Fisher–Yates.
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = draw(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

/** A card's value: aces 1 (the total decides whether one counts 11), faces 10. */
export const cardValue = (card: Card) => (card[0] === "A" ? 1 : "TJQK".includes(card[0]) ? 10 : Number(card[0]));

/** A hand's best total, and whether an ace in it counts 11 (soft). */
export function handTotal(cards: Card[]): { total: number; soft: boolean } {
  const hard = cards.reduce((sum, card) => sum + cardValue(card), 0);
  const soft = cards.some((card) => card[0] === "A") && hard + 10 <= 21;
  return { total: soft ? hard + 10 : hard, soft };
}

const isNatural = (cards: Card[]) => cards.length === 2 && handTotal(cards).total === 21;

export type HandResult = "BLACKJACK" | "WIN" | "PUSH" | "LOSE" | "BUST";

export type PlayerHand = {
  cards: Card[];
  /** Cents on this hand: the bet, or twice it after a double. */
  bet: number;
  doubled: boolean;
  /** One of two hands from a split: 21 on it isn't blackjack. */
  split: boolean;
  /** No more moves on this hand: stood, bust, doubled, 21, or a split ace. */
  done: boolean;
  result: HandResult | null;
  /** Cents back to the Player (the bet included), once settled. */
  payout: number;
};

export type Phase = "INSURANCE" | "PLAYER" | "DONE";

export type Round = {
  shoe: Card[];
  /** The dealer's cards; the second is face down until the dealer plays. */
  dealer: Card[];
  hands: PlayerHand[];
  /** The hand being played. */
  active: number;
  phase: Phase;
  /** The first bet, in cents. */
  bet: number;
  /** Insurance taken (cents), 0 if declined, null before it's asked or when it isn't offered. */
  insurance: number | null;
  /** What insurance paid back (cents), its stake included. */
  insurancePayout: number;
  splitUsed: boolean;
  doubleUsed: boolean;
  /** Whether the dealer's face-down card is shown. */
  revealed: boolean;
};

export type Action = "hit" | "stand" | "double" | "split" | "insure" | "noInsurance";

/** Everything the Player has put down this round, in cents. */
export const staked = (round: Round) => round.hands.reduce((sum, hand) => sum + hand.bet, 0) + (round.insurance ?? 0);
/** Everything the round has paid back, in cents (stakes included). */
export const paidOut = (round: Round) => round.hands.reduce((sum, hand) => sum + hand.payout, 0) + round.insurancePayout;

const take = (round: Round): Card => {
  const card = round.shoe.pop();
  if (!card) throw new Error("The shoe ran out");
  return card;
};

/** Starts a round: the bet (cents) down, two cards each. With insurance to offer it waits for the Player; otherwise a Player's blackjack settles at once. */
export function deal(bet: number, shoe: Card[] = newShoe()): Round {
  if (!Number.isInteger(bet) || bet <= 0) throw new Error("A bet is a whole number of cents");
  const round: Round = {
    shoe: [...shoe],
    dealer: [],
    hands: [{ cards: [], bet, doubled: false, split: false, done: false, result: null, payout: 0 }],
    active: 0,
    phase: "PLAYER",
    bet,
    insurance: null,
    insurancePayout: 0,
    splitUsed: false,
    doubleUsed: false,
    revealed: false,
  };
  // Player, dealer, player, dealer: as at a real table.
  round.hands[0].cards.push(take(round));
  round.dealer.push(take(round));
  round.hands[0].cards.push(take(round));
  round.dealer.push(take(round));
  if (round.dealer[0][0] === "A") {
    round.phase = "INSURANCE";
    return round;
  }
  return checkNatural(round);
}

/**
 * A Player's blackjack ends the round at once (the dealer's card is turned
 * over: a blackjack there too is a tie). The dealer doesn't look for one of
 * their own here, under a ten showing; it shows when the Player has played.
 */
function checkNatural(round: Round): Round {
  if (isNatural(round.hands[0].cards)) {
    round.hands[0].done = true;
    return finish(round);
  }
  round.phase = "PLAYER";
  return round;
}

/** The moves open to the Player right now. */
export function allowed(round: Round): Action[] {
  if (round.phase === "INSURANCE") return ["insure", "noInsurance"];
  if (round.phase !== "PLAYER") return [];
  const hand = round.hands[round.active];
  const moves: Action[] = ["hit", "stand"];
  if (hand.cards.length === 2 && !round.doubleUsed && canDouble(hand)) moves.push("double");
  if (!round.splitUsed && round.hands.length === 1 && hand.cards.length === 2 && hand.cards[0][0] === hand.cards[1][0] && (RULES.splitPairs === null || RULES.splitPairs.includes(cardValue(hand.cards[0])))) moves.push("split");
  return moves;
}

function canDouble(hand: PlayerHand): boolean {
  if (hand.split && !RULES.doubleAfterSplit) return false;
  const { total, soft } = handTotal(hand.cards);
  return RULES.doubleOn === null || (!soft && RULES.doubleOn.includes(total));
}

/** Plays one move and returns the round after it (a new object; the one passed in isn't changed). Throws on a move that isn't allowed. */
export function act(input: Round, action: Action): Round {
  if (!allowed(input).includes(action)) throw new MoveError(action, input);
  const round: Round = structuredClone(input);

  if (action === "insure" || action === "noInsurance") {
    round.insurance = action === "insure" ? Math.floor(round.bet / 2) : 0;
    // The dealer looks at the face-down card: a blackjack is turned over and ends the round.
    if (isNatural(round.dealer)) return finish(round);
    return checkNatural(round);
  }

  const hand = round.hands[round.active];
  switch (action) {
    case "hit": {
      hand.cards.push(take(round));
      if (handTotal(hand.cards).total >= 21) hand.done = true;
      break;
    }
    case "stand":
      hand.done = true;
      break;
    case "double":
      round.doubleUsed = true;
      hand.bet *= 2;
      hand.doubled = true;
      hand.cards.push(take(round));
      hand.done = true;
      break;
    case "split": {
      round.splitUsed = true;
      const [first, second] = hand.cards;
      const aces = first[0] === "A";
      round.hands = [first, second].map((card) => {
        const cards: Card[] = [card, take(round)];
        // Split aces get one card each and no more; any hand reaching 21 is done.
        return { cards, bet: hand.bet, doubled: false, split: true, done: aces || handTotal(cards).total === 21, result: null, payout: 0 };
      });
      round.active = 0;
      break;
    }
  }
  return advance(round);
}

/** On to the next hand still to play, or to the dealer when there's none. */
function advance(round: Round): Round {
  const next = round.hands.findIndex((hand) => !hand.done);
  if (next >= 0) {
    round.active = next;
    return round;
  }
  return finish(round);
}

/** Ends the round: the dealer plays (unless every hand is bust), then each hand is paid. */
function finish(round: Round): Round {
  round.phase = "DONE";
  round.revealed = true;
  round.hands.forEach((hand) => (hand.done = true));
  const dealerNatural = isNatural(round.dealer);
  if (round.insurance) round.insurancePayout = dealerNatural ? round.insurance * 3 : 0;
  const live = round.hands.some((hand) => handTotal(hand.cards).total <= 21);
  const naturalOnly = round.hands.length === 1 && isNatural(round.hands[0].cards);
  // The dealer draws to 17 (and on a soft 17 if RULES say so); there's nothing to draw for when the Player is bust or has blackjack.
  if (live && !dealerNatural && !naturalOnly) {
    const draws = () => {
      const { total, soft } = handTotal(round.dealer);
      return total < 17 || (total === 17 && soft && RULES.dealerHitsSoft17);
    };
    while (draws()) round.dealer.push(take(round));
  }
  const dealer = handTotal(round.dealer).total;
  for (const hand of round.hands) {
    const total = handTotal(hand.cards).total;
    const natural = !hand.split && isNatural(hand.cards);
    if (total > 21) settle(hand, "BUST", 0);
    else if (natural && dealerNatural) settle(hand, "PUSH", hand.bet);
    else if (natural) settle(hand, "BLACKJACK", hand.bet + (hand.bet * RULES.blackjackPays[0]) / RULES.blackjackPays[1]);
    else if (dealerNatural) settle(hand, "LOSE", 0);
    else if (dealer > 21 || total > dealer) settle(hand, "WIN", hand.bet * 2);
    else if (total === dealer) settle(hand, "PUSH", hand.bet);
    else settle(hand, "LOSE", 0);
  }
  return round;
}

function settle(hand: PlayerHand, result: HandResult, payout: number) {
  hand.result = result;
  // 3 to 2 on an odd number of cents rounds down to the cent.
  hand.payout = Math.floor(payout);
}

/** Stands every hand still open and finishes the round: for a round the Player walked away from. Declines insurance first. */
export function standAll(input: Round): Round {
  let round = input;
  if (round.phase === "INSURANCE") round = act(round, "noInsurance");
  while (round.phase === "PLAYER") round = act(round, "stand");
  return round;
}

/** The round as the Player may see it: the dealer's face-down card hidden, the shoe left out. */
export function publicView(round: Round) {
  const dealer = round.revealed ? round.dealer : [round.dealer[0], null];
  const shown = round.revealed ? round.dealer : [round.dealer[0]];
  return {
    phase: round.phase,
    dealer,
    dealerTotal: handTotal(shown).total,
    dealerSoft: handTotal(shown).soft,
    hands: round.hands.map((hand) => ({
      cards: hand.cards,
      total: handTotal(hand.cards).total,
      soft: handTotal(hand.cards).soft,
      blackjack: !hand.split && isNatural(hand.cards),
      bet: hand.bet / 100,
      doubled: hand.doubled,
      done: hand.done,
      result: hand.result,
      payout: hand.payout / 100,
    })),
    active: round.active,
    insurance: round.insurance === null ? null : round.insurance / 100,
    insurancePayout: round.insurancePayout / 100,
    allowed: allowed(round),
    staked: staked(round) / 100,
    payout: round.phase === "DONE" ? paidOut(round) / 100 : null,
  };
}

export class MoveError extends Error {
  readonly action: Action;

  constructor(action: Action, round: Round) {
    super(round.phase === "DONE" ? "This round is over. Deal again." : "That move isn't open right now.");
    this.action = action;
  }
}
