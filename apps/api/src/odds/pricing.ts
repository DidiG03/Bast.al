/** Lowest and highest price anyone can set or be shown. */
export const MIN_ODDS = 1.01;
export const MAX_ODDS = 1000;
/** Largest total margin (Super Admin's base plus an Owner's) in percent. */
export const MAX_MARGIN = 50;

/**
 * The margin a team's prices run at: Super Admin's base plus the Owner's own,
 * never below 0, so no team is ever priced above the feed.
 */
export function teamMargin(baseMargin: number, ownerMargin: number): number {
  return Math.min(MAX_MARGIN, Math.max(0, baseMargin + ownerMargin));
}

/**
 * Takes a margin off a feed price: 2.00 at 5% becomes 1.90. Rounded down to
 * the cent so a margin never pays out more than intended, and kept within
 * MIN_ODDS..MAX_ODDS.
 */
export function applyMargin(feedOdds: number, marginPercent: number): number {
  // The small epsilon stops 1.9 * 100 = 189.99999... rounding down to 1.89.
  const price = Math.floor(feedOdds * (1 - marginPercent / 100) * 100 + 1e-6) / 100;
  return Math.min(MAX_ODDS, Math.max(MIN_ODDS, price));
}

/** What a team sees for one selection: the Owner's own price if set, otherwise the feed less the team margin. */
export function teamPrice(input: { feedOdds: number; baseMargin: number; ownerMargin: number; override?: number | null }): number {
  if (input.override !== undefined && input.override !== null) return input.override;
  return applyMargin(input.feedOdds, teamMargin(input.baseMargin, input.ownerMargin));
}
