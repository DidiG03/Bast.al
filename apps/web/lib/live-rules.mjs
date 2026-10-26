/**
 * The minute already shown for this match and period, and the one a new
 * reading would show. A poll must not step the clock backwards.
 */
export function holdMinute(previous, next) {
  if (next === null || next === undefined) return previous ?? null;
  if (previous === null || previous === undefined) return next;
  return next < previous ? previous : next;
}

/**
 * One label for a market row. "paused" only while our own pause is active;
 * "suspended" only when the bookmaker's market is off and we are not pausing
 * it. A stale row is taken off the board instead of either word.
 */
export function rowWord(ourPause, suspended, stale) {
  if (stale || !suspended) return null;
  return ourPause ? "paused" : "suspended";
}
