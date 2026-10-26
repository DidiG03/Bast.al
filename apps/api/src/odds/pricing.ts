import { LIVE_CUTOFF_MINUTE, marketGroup, pauseDeadline, type LivePause } from "./live-guard";

const envMs = (name: string, fallback: number) => (process.env[name] !== undefined && process.env[name] !== "" && Number(process.env[name]) >= 0 ? Number(process.env[name]) : fallback);

/** Lowest and highest price anyone can set or be shown. */
export const MIN_ODDS = 1.01;
export const MAX_ODDS = 1000;
/** Largest total margin (Super Admin's base plus an Owner's) in percent. */
export const MAX_MARGIN = 50;
/**
 * How far above the feed price an Owner's own price can go, in percent:
 * room for a promotion, but a typo (150 for 1.50) or a price made up to pay
 * someone out is refused.
 */
export const MAX_ABOVE_FEED = 10;

/** The highest price an Owner can give a selection: MAX_ABOVE_FEED above its feed price, rounded down to the cent. */
export function priceCeiling(feedOdds: number): number {
  const ceiling = Math.floor(feedOdds * (1 + MAX_ABOVE_FEED / 100) * 100 + 1e-6) / 100;
  return Math.min(MAX_ODDS, Math.max(MIN_ODDS, ceiling));
}

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

/**
 * What a team sees for one selection: the Owner's own price if set,
 * otherwise the feed less the team margin. An Owner's price never goes above
 * priceCeiling, even when the feed price drops after it was set.
 */
export function teamPrice(input: { feedOdds: number; baseMargin: number; ownerMargin: number; override?: number | null }): number {
  if (input.override !== undefined && input.override !== null) return Math.min(input.override, priceCeiling(input.feedOdds));
  return applyMargin(input.feedOdds, teamMargin(input.baseMargin, input.ownerMargin));
}

/** Live bets pause when the feed hasn't sent in-play prices for this long. */
export const LIVE_ODDS_STALE_MS = Number(process.env.LIVE_ODDS_STALE_MS) || 90_000;

/** Greyhound races close for bets this long before their scheduled start. */
export const RACE_CLOSE_MS = 60_000;

type LiveEventState = {
  /** "greyhounds" closes RACE_CLOSE_MS before the start. */
  sport?: string;
  /** Bets close then, if it's before the start (an MMA card's first fight). */
  closesAt?: Date | null;
  status: string;
  startsAt: Date;
  suspended: boolean;
  hidden: boolean;
  liveStopped: boolean;
  liveOddsAt: Date | null;
  elapsed?: number | null;
  /** The feed's phase while live ("HT" at half-time). */
  period?: string | null;
  /** A goal on the match reached the site too long after it went in (Event.liveSlowFeed): no more live bets on it. */
  liveSlowFeed?: boolean;
  /** Its competition's feed is too slow for live betting (OddsService.liveLimits): pre-match only. */
  liveSlowCompetition?: boolean;
};

/** A market's live state: the feed's suspension, a pause after something in the match, and when the feed last priced it. */
type LiveMarketState = { key?: string; liveSuspended: boolean; livePausedAt?: Date | null; livePausedUntil?: Date | null; livePauseReason?: string | null; liveQuotedAt?: Date | null };

/**
 * A market the feed hasn't priced for this long during play is taken off
 * the live board (shown under "Not available during play") rather than
 * left there suspended. LIVE_MARKET_STALE_MS=0 turns it off.
 */
export const LIVE_MARKET_STALE_MS = envMs("LIVE_MARKET_STALE_MS", 5 * 60_000);

/** Why a live market is paused right now (a goal, a card…: odds/live-guard.ts eventPause), or null. */
export function marketPause(market: LiveMarketState, now: Date = new Date()): string | null {
  // The fallback after the pause started is a hard stop, even if a later reading pushed livePausedUntil past it.
  const end = pauseDeadline({ pausedAt: market.livePausedAt, until: market.livePausedUntil, reason: market.livePauseReason }, now);
  return end === null ? null : market.livePauseReason ?? "goal";
}

/**
 * Whether a live market is one the feed isn't pricing during play: no
 * priced reading of it for LIVE_MARKET_STALE_MS, or, for one never priced
 * live at all (`everPriced` false), that long since kick-off. Not while the
 * match is at a break, when the bookmaker may take everything down for a
 * while.
 */
/**
 * Corners and cards the feed isn't pricing during play. They go under
 * "Not available during play" rather than sitting as a dead Suspended row.
 */
export function liveSideUnpriced(key: string | undefined, hasLivePrice: boolean): boolean {
  if (hasLivePrice || !key) return false;
  const group = marketGroup(key);
  return group === "corners" || group === "cards";
}

export function marketStale(event: { status: string; startsAt: Date; period?: string | null }, market: LiveMarketState, now: Date = new Date(), everPriced = true): boolean {
  if (event.status !== "LIVE" || LIVE_MARKET_STALE_MS <= 0 || ["HT", "BT", "P"].includes(event.period ?? "")) return false;
  const since = market.liveQuotedAt ?? (everPriced ? null : event.startsAt);
  return since !== null && now.getTime() - since.getTime() > LIVE_MARKET_STALE_MS;
}

/**
 * Why a whole live match isn't taking bets right now, or null if it is (or
 * isn't live). In order: its competition's feed is too slow for live
 * betting, the bookmaker blocked it (or a goal reached the site too late),
 * the last minutes, or prices that stopped arriving. A goal, a card or the
 * bookmaker reopening it pauses single markets instead (marketPause).
 */
export function livePause(event: LiveEventState, now: Date = new Date()): LivePause | null {
  if (event.status !== "LIVE") return null;
  if (event.liveSlowCompetition) return "competition";
  // The bookmaker blocking the match, or not having priced it in the opening minutes. Not "a moment".
  if (event.liveStopped) return "bookmaker";
  if (event.liveSlowFeed) return "feed";
  if (LIVE_CUTOFF_MINUTE > 0 && (event.elapsed ?? 0) >= LIVE_CUTOFF_MINUTE) return "late";
  if (event.liveOddsAt === null) {
    const sinceKick = now.getTime() - event.startsAt.getTime();
    if (sinceKick < 3 * 60_000 || (event.elapsed ?? 99) <= 2) return "bookmaker";
    return "feed";
  }
  if (now.getTime() - event.liveOddsAt.getTime() > LIVE_ODDS_STALE_MS) return "feed";
  return null;
}

/**
 * Whether a match takes bets right now: before kick-off, or while live with
 * fresh in-play prices and nothing pausing it (see livePause). LIVE_BETTING=off
 * turns in-play betting off everywhere.
 */
export function eventOpen(event: LiveEventState, now: Date = new Date()): boolean {
  if (event.suspended || event.hidden) return false;
  if (event.status === "UPCOMING") {
    const closes = Math.min(event.startsAt.getTime() - (event.sport === "greyhounds" ? RACE_CLOSE_MS : 0), event.closesAt?.getTime() ?? Infinity);
    return closes > now.getTime();
  }
  if (event.status !== "LIVE" || process.env.LIVE_BETTING === "off") return false;
  return livePause(event, now) === null;
}

/**
 * A selection's price for a team and whether it can be bet on. While a match is
 * live the price is the in-play feed price less the team margin: an Owner's
 * fixed pre-match price would go stale the moment a goal goes in.
 */
export function selectionQuote(input: {
  event: LiveEventState;
  market: LiveMarketState;
  /** `withdrawn`: the feed stopped pricing this outcome before kick-off (see Selection.withdrawn). */
  selection: { feedOdds: number; liveOdds: number | null; result: string | null; withdrawn?: boolean };
  baseMargin: number;
  ownerMargin: number;
  override: number | null;
  now?: Date;
}): { price: number; bettable: boolean; live: boolean; suspended: boolean } {
  const live = input.event.status === "LIVE";
  // A greyhound race has no price before the off: its bets are paid at the starting price (price 0 means "SP").
  if (input.event.sport === "greyhounds") {
    const withdrawn = input.selection.withdrawn === true;
    return { price: 0, bettable: eventOpen(input.event, input.now) && input.selection.result === null && !withdrawn, live: false, suspended: withdrawn };
  }
  const open = eventOpen(input.event, input.now) && input.selection.result === null;
  if (!live) {
    const price = teamPrice({ feedOdds: input.selection.feedOdds, baseMargin: input.baseMargin, ownerMargin: input.ownerMargin, override: input.override });
    const withdrawn = input.selection.withdrawn === true;
    return { price, bettable: open && !withdrawn, live, suspended: withdrawn };
  }
  // Paused after a goal or a card, or not priced during play for a while: off the board too.
  const suspended = input.market.liveSuspended || input.selection.liveOdds === null || marketPause(input.market, input.now) !== null || marketStale(input.event, input.market, input.now, input.selection.liveOdds !== null);
  const price = applyMargin(input.selection.liveOdds ?? input.selection.feedOdds, teamMargin(input.baseMargin, input.ownerMargin));
  return { price, bettable: open && !suspended, live, suspended };
}

/** What's paused on a live match, for its banner: the latest event's reason, how many markets, the first few, and when they're back. */
export type MarketPauseSummary = {
  reason: string;
  count: number;
  /** The first few paused markets' names, in board order. */
  markets: string[];
  /** When the last of them reopens at the latest. */
  until: string;
  /** Fresh prices are in for all of them: `until` is when they reopen, not just the latest they might. */
  exact: boolean;
};

export function pauseSummary(
  markets: Array<{ name: string; sortOrder: number; livePausedAt?: Date | null; livePausedUntil?: Date | null; liveReopenFrom?: Date | null; livePauseReason?: string | null }>,
  now: Date = new Date(),
): MarketPauseSummary | null {
  const paused = markets
    .filter((market) => pauseDeadline({ pausedAt: market.livePausedAt, until: market.livePausedUntil, reason: market.livePauseReason }, now) !== null)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  if (paused.length === 0) return null;
  const latest = paused.reduce((top, market) => ((market.livePausedAt?.getTime() ?? 0) > (top.livePausedAt?.getTime() ?? 0) ? market : top));
  const until = Math.max(...paused.map((market) => pauseDeadline({ pausedAt: market.livePausedAt, until: market.livePausedUntil, reason: market.livePauseReason }, now)!));
  return {
    reason: latest.livePauseReason ?? "goal",
    count: paused.length,
    markets: paused.slice(0, 3).map((market) => market.name),
    until: new Date(until).toISOString(),
    exact: paused.every((market) => market.liveReopenFrom != null && market.livePausedUntil!.getTime() <= market.liveReopenFrom.getTime()),
  };
}
