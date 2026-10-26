import type { OddsEvent } from "./api";
import type { SlipItem } from "./slip";

/**
 * What changed on one live match, as the API pushes it to a Player's team
 * (`odds.live`): the header when the score, minute or pause changed, and
 * [id, suspended, stale] / [id, price, suspended] for markets and prices that moved.
 */
export type LiveDelta = {
  id: string;
  header?: Pick<OddsEvent, "status" | "live" | "elapsed" | "elapsedAt" | "period" | "homeScore" | "awayScore" | "bettable" | "livePause" | "allMarketsSuspended" | "marketPause">;
  markets?: Array<[string, boolean, boolean?]>;
  prices?: Array<[string, number, boolean]>;
};

/** The deltas of one push, by match. */
export function byMatch(deltas: LiveDelta[]): Map<string, LiveDelta> {
  return new Map(deltas.map((delta) => [delta.id, delta]));
}

/**
 * One match with a push applied. The same object comes back when nothing in
 * it changed, so the match cards that didn't move don't redraw.
 */
export function applyDelta(event: OddsEvent, delta: LiveDelta | undefined): OddsEvent {
  if (!delta) return event;
  const markets = new Map((delta.markets ?? []).map(([id, suspended, stale]) => [id, { suspended, stale: stale ?? false }]));
  const prices = new Map((delta.prices ?? []).map(([id, price, suspended]) => [id, { price, suspended }]));
  let changed = false;
  const nextMarkets = event.markets.map((market) => {
    const state = markets.get(market.id);
    const suspended = state?.suspended;
    let marketChanged = state !== undefined && (state.suspended !== (market.suspended ?? false) || state.stale !== (market.stale ?? false));
    const selections = market.selections.map((selection) => {
      const quote = prices.get(selection.id);
      if (!quote || (quote.price === selection.price && quote.suspended === (selection.suspended ?? false))) return selection;
      marketChanged = true;
      return { ...selection, price: quote.price, suspended: quote.suspended };
    });
    // A short pause (a goal, a card) says "Paused". The bookmaker taking a market off says "Suspended".
    const paused = state?.stale ? null : state?.suspended && delta.header?.marketPause ? delta.header.marketPause.reason : state?.suspended === false ? null : market.paused;
    if (!marketChanged && paused === market.paused) return market;
    changed = true;
    return { ...market, ...(state !== undefined ? { suspended, stale: state.stale } : {}), paused, selections };
  });
  if (!changed && !delta.header) return event;
  return { ...event, ...(delta.header ?? {}), markets: changed ? nextMarkets : event.markets };
}

/**
 * A list with a push applied, and whether the push named a match that's
 * live but not on the list (it just kicked off): then the list is fetched.
 */
export function applyToList(list: OddsEvent[], deltas: Map<string, LiveDelta>): { list: OddsEvent[]; missing: boolean } {
  let changed = false;
  const next = list.map((event) => {
    const updated = applyDelta(event, deltas.get(event.id));
    if (updated !== event) changed = true;
    return updated;
  });
  const listed = new Set(list.map((event) => event.id));
  const missing = Array.from(deltas.values()).some((delta) => !listed.has(delta.id) && delta.header?.live === true);
  return { list: changed ? next : list, missing };
}

/** Whether a push priced something an opened match doesn't have yet (a market that just appeared): then it's fetched again. */
export function hasUnknownSelections(event: OddsEvent, delta: LiveDelta | undefined): boolean {
  if (!delta?.prices) return false;
  const known = new Set(event.markets.flatMap((market) => market.selections.map((selection) => selection.id)));
  return delta.prices.some(([id]) => !known.has(id));
}

/**
 * The slip with a push applied: a live pick takes its new price (keeping
 * the one it was added at, to show the move) and pauses while its match or
 * outcome isn't taking bets. `bettableNow` says whether a match takes bets
 * when the push didn't say (from the list). `recheck` is set when the push
 * alone can't tell whether a pick is open (its match finished, or reopened
 * without a word on that pick): then the slip asks the API.
 */
export function applyToSlip(items: SlipItem[], deltas: Map<string, LiveDelta>, bettableNow: (eventId: string) => boolean | undefined): { items: SlipItem[]; recheck: boolean } {
  const prices = new Map<string, { price: number; suspended: boolean }>();
  for (const delta of Array.from(deltas.values())) for (const [id, price, suspended] of delta.prices ?? []) prices.set(id, { price, suspended });
  let changed = false;
  let recheck = false;
  const next = items.map((item) => {
    const delta = deltas.get(item.eventId);
    if (!delta || item.sp || item.closed) return item;
    if (delta.header && !delta.header.live) {
      recheck = true;
      return item;
    }
    const quote = prices.get(item.selectionId);
    let updated = item;
    if (quote && quote.price !== item.odds) {
      const previous = item.previousOdds ?? item.odds;
      updated = { ...updated, odds: quote.price, previousOdds: previous === quote.price ? undefined : previous, live: true };
    }
    const bettable = delta.header?.bettable ?? bettableNow(item.eventId);
    let paused = item.paused;
    if (bettable === false) paused = true;
    else if (quote && bettable === true) paused = quote.suspended;
    // The match reopened, or its state isn't on the list, with no word on this pick: ask.
    else if (delta.header || (quote && bettable === undefined)) recheck = true;
    if (paused !== item.paused) updated = { ...updated, paused };
    if (updated !== item) changed = true;
    return updated;
  });
  return { items: changed ? next : items, recheck };
}
