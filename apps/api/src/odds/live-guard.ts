/**
 * When live betting on a match should pause, on top of the bookmaker's own
 * "blocked" flag (which the feed only shows us as often as we ask). Every
 * rule errs on the side of pausing: a missed bet costs a little, a bet on a
 * goal someone has already seen costs a lot.
 */

const ms = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && process.env[name] !== "" && process.env[name] !== undefined ? value : fallback;
};

/** After a goal (or a goal taken back by VAR): the prices need a while to settle. The longest it pauses; see goalPauseOver for reopening sooner. */
export const GOAL_COOLDOWN_MS = ms("LIVE_GOAL_COOLDOWN_MS", 90_000);
/** The least a goal pauses live betting, however quickly the prices catch up. */
export const GOAL_MIN_PAUSE_MS = ms("LIVE_GOAL_MIN_PAUSE_MS", 30_000);
/** After a big jump in the main prices, which usually means a red card or a penalty. */
export const SWING_COOLDOWN_MS = ms("LIVE_SWING_COOLDOWN_MS", 30_000);
/** After the bookmaker reopens a match it had blocked. */
export const REOPEN_COOLDOWN_MS = ms("LIVE_REOPEN_COOLDOWN_MS", 15_000);
/**
 * How far a match-result outcome's chance (1 / price) has to move between two
 * readings to count as a jump: 0.12 = 12 percentage points, e.g. a home win
 * going from 50% to 31% after a red card. Chances rather than prices, so a
 * long shot drifting from 26.0 to 34.0 (a 1-point change) doesn't count.
 */
export const SWING_POINTS = Number(process.env.LIVE_SWING_POINTS) > 0 ? Number(process.env.LIVE_SWING_POINTS) : 0.12;
/** No live bets from this minute on: the last minutes are when a delayed feed hurts most. */
export const LIVE_CUTOFF_MINUTE = ms("LIVE_CUTOFF_MINUTE", 89);

/** Why a live match isn't taking bets right now, for the Player. */
export type LivePause = "goal" | "swing" | "reopen" | "late" | "feed";

export type LiveReading = { homeScore: number | null; awayScore: number | null; stopped: boolean };

/**
 * The pause a new reading of a live match calls for, if any. `before` is what
 * we had saved; `swing` says the match-result prices jumped.
 */
export function cooldownFor(before: LiveReading, after: LiveReading, swing: boolean, now: Date = new Date()): { until: Date; reason: LivePause } | null {
  const scored =
    before.homeScore !== null && before.awayScore !== null && after.homeScore !== null && after.awayScore !== null && (before.homeScore !== after.homeScore || before.awayScore !== after.awayScore);
  if (scored && GOAL_COOLDOWN_MS > 0) return { until: new Date(now.getTime() + GOAL_COOLDOWN_MS), reason: "goal" };
  if (swing && SWING_COOLDOWN_MS > 0) return { until: new Date(now.getTime() + SWING_COOLDOWN_MS), reason: "swing" };
  if (before.stopped && !after.stopped && REOPEN_COOLDOWN_MS > 0) return { until: new Date(now.getTime() + REOPEN_COOLDOWN_MS), reason: "reopen" };
  return null;
}

/** Keeps the later of two pauses, so a short one never cuts a longer one short. */
export function laterCooldown(current: { until: Date | null; reason: string | null }, next: { until: Date; reason: LivePause } | null): { until: Date | null; reason: string | null } {
  if (!next) return current;
  if (current.until && current.until >= next.until) return current;
  return next;
}

/**
 * Whether a goal's pause can end before GOAL_COOLDOWN_MS is up, on a new
 * reading of the match: the bookmaker isn't blocking it, the reading's prices
 * already carry the score (so they were made after the goal), the reading
 * doesn't call for a pause of its own (another goal, a jump, a reopening),
 * and at least GOAL_MIN_PAUSE_MS has gone by since the goal.
 */
export function goalPauseOver(
  pause: { until: Date | null; reason: string | null },
  reading: { hasScore: boolean; stopped: boolean; pausesItself: boolean },
  now: Date = new Date(),
): boolean {
  if (pause.reason !== "goal" || !pause.until || pause.until <= now) return false;
  if (reading.stopped || !reading.hasScore || reading.pausesItself) return false;
  const goalAt = pause.until.getTime() - GOAL_COOLDOWN_MS;
  return now.getTime() - goalAt >= GOAL_MIN_PAUSE_MS;
}

/** Whether any outcome's chance moved by at least SWING_POINTS between two readings. Outcomes new or gone don't count. */
export function bigSwing(before: Array<number | null>, after: Array<number | null>): boolean {
  return before.some((old, index) => {
    const next = after[index];
    if (old === null || next === null || old <= 1 || next <= 1) return false;
    return Math.abs(1 / next - 1 / old) >= SWING_POINTS;
  });
}
