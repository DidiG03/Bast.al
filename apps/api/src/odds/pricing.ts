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

/** Live bets pause when the feed hasn't sent in-play prices for this long. */
export const LIVE_ODDS_STALE_MS = Number(process.env.LIVE_ODDS_STALE_MS) || 90_000;

type LiveEventState = {
  status: string;
  startsAt: Date;
  suspended: boolean;
  hidden: boolean;
  liveStopped: boolean;
  liveOddsAt: Date | null;
};

/**
 * Whether a match takes bets right now: before kick-off, or while live with
 * fresh in-play prices the feed hasn't stopped. LIVE_BETTING=off turns in-play
 * betting off everywhere.
 */
export function eventOpen(event: LiveEventState, now: Date = new Date()): boolean {
  if (event.suspended || event.hidden) return false;
  if (event.status === "UPCOMING") return event.startsAt > now;
  if (event.status !== "LIVE" || process.env.LIVE_BETTING === "off") return false;
  return !event.liveStopped && event.liveOddsAt !== null && now.getTime() - event.liveOddsAt.getTime() <= LIVE_ODDS_STALE_MS;
}

/**
 * A selection's price for a team and whether it can be bet on. While a match is
 * live the price is the in-play feed price less the team margin: an Owner's
 * fixed pre-match price would go stale the moment a goal goes in.
 */
export function selectionQuote(input: {
  event: LiveEventState;
  market: { liveSuspended: boolean };
  selection: { feedOdds: number; liveOdds: number | null; result: string | null };
  baseMargin: number;
  ownerMargin: number;
  override: number | null;
  now?: Date;
}): { price: number; bettable: boolean; live: boolean; suspended: boolean } {
  const live = input.event.status === "LIVE";
  const open = eventOpen(input.event, input.now) && input.selection.result === null;
  if (!live) {
    const price = teamPrice({ feedOdds: input.selection.feedOdds, baseMargin: input.baseMargin, ownerMargin: input.ownerMargin, override: input.override });
    return { price, bettable: open, live, suspended: false };
  }
  const suspended = input.market.liveSuspended || input.selection.liveOdds === null;
  const price = applyMargin(input.selection.liveOdds ?? input.selection.feedOdds, teamMargin(input.baseMargin, input.ownerMargin));
  return { price, bettable: open && !suspended, live, suspended };
}
