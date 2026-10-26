/**
 * Corners and cards lines against the live count. An Over that has already
 * won, or an Under that has already lost, must not be offered or accepted.
 * The count comes from the match centre (API-Football fixtures/statistics).
 */

export const COUNT_STATS_MAX_AGE_MS = 60_000;

export type CountPair = [number, number];

export type CountStats = {
  corners: CountPair | null;
  /** Yellow plus red, each side. */
  cards: CountPair | null;
  at: Date | null;
};

export function countsFromCentre(centre: unknown, at: Date | null): CountStats {
  const raw = centre && typeof centre === "object" ? (centre as { corners?: CountPair | null; yellow?: CountPair | null; red?: CountPair | null }) : null;
  if (!raw) return { corners: null, cards: null, at };
  const add = (a: CountPair | null | undefined, b: CountPair | null | undefined): CountPair | null => (a && b ? [a[0] + b[0], a[1] + b[1]] : a ?? b ?? null);
  return { corners: raw.corners ?? null, cards: add(raw.yellow, raw.red), at };
}

export function statsFresh(stats: CountStats, now: Date, maxAgeMs = COUNT_STATS_MAX_AGE_MS): boolean {
  if (!stats.at) return false;
  return now.getTime() - stats.at.getTime() <= maxAgeMs;
}

/** The count an over/under market settles on, or null when it isn't one of these. */
export function countForMarket(key: string, stats: CountStats): number | null {
  const total = (pair: CountPair | null) => (pair ? pair[0] + pair[1] : null);
  if (/^home_corners_\d+_5$/.test(key)) return stats.corners ? stats.corners[0] : null;
  if (/^away_corners_\d+_5$/.test(key)) return stats.corners ? stats.corners[1] : null;
  if (/^corners_\d+_5$/.test(key)) return total(stats.corners);
  if (/^home_cards_\d+_5$/.test(key)) return stats.cards ? stats.cards[0] : null;
  if (/^away_cards_\d+_5$/.test(key)) return stats.cards ? stats.cards[1] : null;
  if (/^cards_\d+_5$/.test(key)) return total(stats.cards);
  return null;
}

const lineOf = (key: string) => {
  const match = /_(\d+)_5$/.exec(key);
  return match ? Number(`${match[1]}.5`) : null;
};

/**
 * True when this pick can no longer lose: Over is already in, or Under is
 * already broken. `count` is the live total for that market.
 */
export function countLineDead(marketKey: string, selectionKey: string, count: number): boolean {
  const line = lineOf(marketKey);
  if (line === null) return false;
  if (selectionKey !== "over" && selectionKey !== "under") return false;
  return count > line;
}

/** A corners or cards over/under market (the ones the live count can close). */
export function isCountMarket(key: string): boolean {
  return /^(home_|away_)?(corners|cards)_\d+_5$/.test(key);
}

/** Any corners or cards market, including ranges and handicaps. */
export function isCountFamily(key: string): boolean {
  return /^(home_|away_)?(corners|cards)(_|$)/.test(key);
}

/**
 * The live count for this market is missing, or the match centre is older
 * than a minute. Corners and cards markets are held until a fresh count arrives.
 */
export function countStatsStale(centre: unknown, at: Date | null | undefined, marketKey: string, now: Date): boolean {
  if (!isCountFamily(marketKey)) return false;
  const stats = countsFromCentre(centre, at ?? null);
  const pair = /corners/.test(marketKey) ? stats.corners : stats.cards;
  return pair === null || !statsFresh(stats, now);
}

/** This over has already won, or this under has already lost, on the latest count. */
export function countSelectionDead(centre: unknown, at: Date | null | undefined, marketKey: string, selectionKey: string, now: Date): boolean {
  if (!isCountMarket(marketKey) || countStatsStale(centre, at, marketKey, now)) return false;
  const count = countForMarket(marketKey, countsFromCentre(centre, at ?? null));
  return count !== null && countLineDead(marketKey, selectionKey, count);
}
