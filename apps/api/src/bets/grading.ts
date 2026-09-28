import { BetStatus, Prisma, SelectionResult } from "@prisma/client";

/**
 * Whether a selection won, from the 90-minute score. Returns null for a
 * market we don't know how to grade; its bets stay open for Super Admin.
 */
export function gradeSelection(marketKey: string, selectionKey: string, home: number, away: number): SelectionResult | null {
  const outcome = home > away ? "home" : home < away ? "away" : "draw";
  const won = (yes: boolean) => (yes ? SelectionResult.WON : SelectionResult.LOST);
  switch (marketKey) {
    case "match_winner":
      return ["home", "draw", "away"].includes(selectionKey) ? won(selectionKey === outcome) : null;
    case "double_chance": {
      const covers: Record<string, string[]> = { home_draw: ["home", "draw"], home_away: ["home", "away"], draw_away: ["draw", "away"] };
      return covers[selectionKey] ? won(covers[selectionKey].includes(outcome)) : null;
    }
    case "goals_2_5":
      if (selectionKey === "over") return won(home + away > 2.5);
      if (selectionKey === "under") return won(home + away < 2.5);
      return null;
    case "btts":
      if (selectionKey === "yes") return won(home > 0 && away > 0);
      if (selectionKey === "no") return won(!(home > 0 && away > 0));
      return null;
    default:
      return null;
  }
}

/**
 * What a bet pays back, stake included: stake x odds for a win (rounded
 * down to the cent), the stake for a void, nothing for a loss.
 */
export function payoutFor(status: BetStatus, stake: Prisma.Decimal, odds: Prisma.Decimal): Prisma.Decimal {
  if (status === BetStatus.WON) return stake.mul(odds).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  if (status === BetStatus.VOID) return stake;
  return new Prisma.Decimal(0);
}

/** Multiplies leg prices and rounds down to the cent, so the price shown is never more than what's paid. */
export function combinedOdds(odds: Prisma.Decimal[]): Prisma.Decimal {
  return odds.reduce((product, price) => product.mul(price), new Prisma.Decimal(1)).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
}

/**
 * Where an accumulator stands from its legs: lost as soon as any leg loses,
 * open while any leg is undecided, void if every leg is void, otherwise won
 * at the combined price of the legs that weren't void.
 */
export function accumulatorOutcome(legs: Array<{ odds: Prisma.Decimal; result: SelectionResult | null }>): { status: BetStatus; odds: Prisma.Decimal } {
  const live = legs.filter((leg) => leg.result !== SelectionResult.VOID);
  const odds = combinedOdds(live.map((leg) => leg.odds));
  if (legs.some((leg) => leg.result === SelectionResult.LOST)) return { status: BetStatus.LOST, odds };
  if (legs.some((leg) => leg.result === null)) return { status: BetStatus.OPEN, odds };
  if (live.length === 0) return { status: BetStatus.VOID, odds: new Prisma.Decimal(1) };
  return { status: BetStatus.WON, odds };
}
