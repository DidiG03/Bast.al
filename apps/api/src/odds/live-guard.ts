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
/** The least a goal (a red card, a VAR check) pauses the markets it changes, however quickly the prices catch up. */
export const GOAL_MIN_PAUSE_MS = ms("LIVE_GOAL_MIN_PAUSE_MS", 15_000);
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

/**
 * Why a whole live match isn't taking bets right now, for the Player: the
 * last minutes, the feed (the bookmaker blocking it, prices that stopped, a
 * goal that reached the site too late), or a competition whose feed is too
 * slow for live betting. A goal or a card pauses single markets instead
 * (Market.livePauseReason).
 */
export type LivePause = "late" | "feed" | "competition" | "bookmaker";
/**
 * The latest pause on a match (Event.liveCooldownReason, until its end):
 * a goal, a jump in the prices, the bookmaker reopening it, or a red card, a
 * VAR check or a penalty in the feed's timeline. The pauses themselves are
 * on the markets each changes (eventPause); the match keeps the latest to
 * make a live slip wait longer after it and for the record.
 */
export type CooldownReason = MarketPauseReason;
/** Pauses for something that happened in the match: they last until the prices are made again after it (eventPauseOver). */
export const EVENT_PAUSES: ReadonlySet<string> = new Set(["goal", "red", "var", "ahead"]);

export type LiveReading = { homeScore: number | null; awayScore: number | null; stopped: boolean };

/** The score changed between two readings: a goal, or a goal taken back. The first reading of a match (no score yet) is not one. */
export function scoreChanged(before: LiveReading, after: LiveReading): boolean {
  return before.homeScore !== null && before.awayScore !== null && after.homeScore !== null && after.awayScore !== null && (before.homeScore !== after.homeScore || before.awayScore !== after.awayScore);
}

/**
 * The pause a new reading of a live match calls for, if any. `before` is what
 * we had saved; `swing` says the match-result prices jumped.
 */
export function cooldownFor(before: LiveReading, after: LiveReading, swing: boolean, now: Date = new Date()): { until: Date; reason: MarketPauseReason } | null {
  if (scoreChanged(before, after) && GOAL_COOLDOWN_MS > 0) return { until: new Date(now.getTime() + GOAL_COOLDOWN_MS), reason: "goal" };
  if (swing && SWING_COOLDOWN_MS > 0) return { until: new Date(now.getTime() + SWING_COOLDOWN_MS), reason: "swing" };
  if (before.stopped && !after.stopped && REOPEN_COOLDOWN_MS > 0) return { until: new Date(now.getTime() + REOPEN_COOLDOWN_MS), reason: "reopen" };
  return null;
}

/**
 * The same goal must not start another pause. `key` is the score ("2:1").
 * A new score is a new goal and does start one. A red card or a VAR check
 * is not a score, so it is never this.
 */
export function sameScorePause(active: { reason: string | null; until: Date | null } | null, nextReason: string, previousKey: string | null, nextKey: string, now: Date): boolean {
  if (nextReason !== "goal" && nextReason !== "ahead") return false;
  if (!active?.until || active.until <= now) return false;
  if (active.reason !== "goal" && active.reason !== "ahead") return false;
  return previousKey === nextKey;
}

/** Keeps the later of two pauses, so a short one never cuts a longer one short. */
export function laterCooldown(current: { until: Date | null; reason: string | null }, next: { until: Date; reason: CooldownReason } | null): { until: Date | null; reason: string | null } {
  if (!next) return current;
  if (current.until && current.until >= next.until) return current;
  return next;
}

/**
 * Whether a live match-result price is the wrong way round for a goal just
 * scored: the side that scored is no shorter than it was before the goal.
 * That price wasn't made for the goal, so no bet is taken at it. `before` is
 * the match-result prices just before the goal. Other markets' prices can't
 * be compared with those, so they aren't checked here.
 */
export function wrongWayAfterGoal(input: { marketKey: string; selectionKey: string; price: number; side: "home" | "away"; before: { home?: number | null; draw?: number | null; away?: number | null } }): boolean {
  if (input.marketKey !== "match_winner" || input.selectionKey !== input.side) return false;
  const was = input.before[input.side];
  return typeof was === "number" && was > 1 && input.price >= was;
}

/** Whether any outcome's chance moved by at least SWING_POINTS between two readings. Outcomes new or gone don't count. */
export function bigSwing(before: Array<number | null>, after: Array<number | null>): boolean {
  return before.some((old, index) => {
    const next = after[index];
    if (old === null || next === null || old <= 1 || next <= 1) return false;
    return Math.abs(1 / next - 1 / old) >= SWING_POINTS;
  });
}

/**
 * A price move small enough to take without asking again: under 2 percentage
 * points of chance. 1.90 to 1.95 is about 1.3 points; 2.00 to 2.50 is about
 * 10 and is not. A price of 1.00 or below is not a real price.
 */
export const SMALL_MOVE_POINTS = 0.02;

export function smallPriceMove(before: number, after: number): boolean {
  if (!(before > 1) || !(after > 1)) return false;
  return Math.abs(1 / after - 1 / before) < SMALL_MOVE_POINTS;
}

/** A move a bet takes without asking: a small one up. Any move down shows the Player the new price first. */
export function takenWithoutAsking(before: number, after: number): boolean {
  return after > before && smallPriceMove(before, after);
}

/**
 * Pauses on single markets. Something happening in a live match pauses the
 * markets it changes, not the whole match: a goal the goal markets (result,
 * double chance, totals, both teams to score, correct score, handicaps and
 * the rest that settle on goals), a red card, a VAR check, a penalty or a
 * jump in the prices those and the cards markets. The bookmaker reopening a
 * match it had blocked pauses every market briefly. A market the event
 * doesn't change stays open only if the reading that brought the event (so
 * made after it) still prices it; otherwise it pauses too, until a reading
 * made after the event prices it again.
 *
 * Each pause lasts until the market's prices are made again after the event
 * (freshUntil), at least GOAL_MIN_PAUSE_MS for a market the event changes,
 * and at most the fallback (GOAL_COOLDOWN_MS after a goal, a red card or a
 * VAR check; SWING_COOLDOWN_MS after a jump; REOPEN_COOLDOWN_MS after a
 * reopen) when fresh prices don't come.
 */
export type MarketGroup = "goals" | "cards" | "corners";
export type MarketPauseReason = "goal" | "red" | "var" | "swing" | "reopen" | "ahead";

export function marketGroup(key: string): MarketGroup {
  if (/^(home_|away_)?corners_/.test(key)) return "corners";
  if (/^(home_|away_)?cards_/.test(key)) return "cards";
  return "goals";
}

/** The markets each kind of event changes. */
export const EVENT_HITS: Record<MarketPauseReason, readonly MarketGroup[]> = {
  goal: ["goals"],
  // The timeline is ahead of the score on the board. Same markets as a goal, but it isn't called a goal until the score changes.
  ahead: ["goals"],
  red: ["goals", "cards"],
  var: ["goals", "cards"],
  swing: ["goals", "cards"],
  reopen: ["goals", "cards", "corners"],
};

/** The longest each kind of event pauses a market when fresh prices don't come. */
export function fallbackMs(reason: MarketPauseReason): number {
  return reason === "swing" ? SWING_COOLDOWN_MS : reason === "reopen" ? REOPEN_COOLDOWN_MS : GOAL_COOLDOWN_MS;
}

/**
 * When a pause actually ends: the time it was given, and never later than
 * its fallback after it started. A second reading of the same event must not
 * keep markets closed past that.
 */
export function pauseDeadline(pause: { pausedAt?: Date | null; until?: Date | null; reason?: string | null }, now: Date = new Date()): number | null {
  if (!pause.until || pause.until <= now) return null;
  const reason = pause.reason as MarketPauseReason | null;
  const cap = pause.pausedAt && reason && reason in EVENT_HITS ? pause.pausedAt.getTime() + fallbackMs(reason) : pause.until.getTime();
  const end = Math.min(pause.until.getTime(), cap);
  return end > now.getTime() ? end : null;
}

export const hitBy = (reason: MarketPauseReason, marketKey: string) => EVENT_HITS[reason].includes(marketGroup(marketKey));

/** A market's pause (Market.livePausedAt, livePausedUntil, liveReopenFrom, livePauseReason). */
export type MarketPause = { pausedAt: Date | null; until: Date | null; reopenFrom: Date | null; reason: string | null };

/**
 * The pause an event puts on one market, or null if that market stays open.
 * Only the markets the event can change are paused. `pricedSinceEvent` is
 * kept for callers that already know which markets this reading priced.
 */
export function eventPause(input: { reason: MarketPauseReason; marketKey: string; pricedSinceEvent: boolean; now: Date }): MarketPause | null {
  const fallback = fallbackMs(input.reason);
  if (fallback <= 0) return null;
  const now = input.now.getTime();
  const until = new Date(now + fallback);
  // A goal or a red card only pauses the markets it can change. Corners stay
  // open on a red card, and a market this reading doesn't price stays as it
  // was: pausing it left a row stuck on "Paused" after the banner had gone.
  if (!hitBy(input.reason, input.marketKey)) return null;
  const least = input.reason === "reopen" ? fallback : Math.min(GOAL_MIN_PAUSE_MS, fallback);
  return { pausedAt: input.now, until, reopenFrom: new Date(now + least), reason: input.reason };
}

/**
 * A market's pause with a new event's added. A jump in the prices or the
 * bookmaker reopening the match during a pause for a goal, a red card or a
 * VAR check is the market catching up with that event, not another one: it
 * doesn't add to the pause, or the new prices would stay hidden for the
 * whole fallback. Anything else restarts the wait for fresh prices from the
 * new event and keeps the later end.
 */
export function mergePause(current: MarketPause, next: MarketPause | null, now: Date): MarketPause {
  if (!next) return current;
  const active = current.until !== null && current.until > now;
  if (!active) return next;
  if (EVENT_PAUSES.has(current.reason ?? "") && (next.reason === "swing" || next.reason === "reopen")) return current;
  const later = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : a ?? b);
  // A new event starts its own window, and that window cannot run past its own fallback.
  const cap = next.pausedAt ? new Date(next.pausedAt.getTime() + fallbackMs(next.reason as MarketPauseReason)) : next.until;
  const until = later(current.until, next.until);
  return { pausedAt: next.pausedAt, until: until && cap && until > cap ? cap : until, reopenFrom: later(current.reopenFrom, next.reopenFrom), reason: next.reason };
}

/**
 * When a paused market can reopen, given a new reading of its match, or null
 * if this reading doesn't let it. See freshBlocker for what "fresh" means
 * with this feed. The market then reopens at its earliest (`reopenFrom`),
 * or now if that's past.
 */
export function freshUntil(
  pause: MarketPause,
  reading: { stopped: boolean; scoreKnown: boolean; priced: boolean; bookmakerUpdate: Date | null; movedAt: Date | null },
  now: Date,
): Date | null {
  if (!pause.until || pause.until <= now || !pause.pausedAt) return null;
  if (freshBlocker(pause, reading, now)) return null;
  const until = new Date(Math.max(pause.reopenFrom?.getTime() ?? now.getTime(), now.getTime()));
  return until < pause.until ? until : null;
}

/**
 * Why this reading doesn't reopen a paused market, or null when it does.
 * API-Football's odds `update` time often stays at or before the moment we
 * saved the pause, even on a later poll that carries new prices. A market
 * the event changes therefore reopens when its own prices differ from the
 * ones stored before the pause, or when that timestamp is later. The reading
 * that starts the pause writes the new prices at the same moment, so a move
 * at that moment counts. Either one is enough. A poll that doesn't qualify
 * leaves the 15 s minimum where it is.
 */
export function freshBlocker(
  pause: MarketPause,
  reading: { stopped: boolean; scoreKnown: boolean; priced: boolean; bookmakerUpdate: Date | null; movedAt: Date | null },
  now: Date,
): string | null {
  if (!pause.until || pause.until <= now || !pause.pausedAt) return "pause already over";
  if (reading.stopped) return "bookmaker blocking the match";
  if (!reading.scoreKnown) return "score isn't the latest";
  if (!reading.priced) return "market not priced on this reading";
  const pausedAt = pause.pausedAt.getTime();
  const madeAfter = Boolean(reading.bookmakerUpdate && reading.bookmakerUpdate.getTime() > pausedAt);
  const pricesMoved = Boolean(reading.movedAt && reading.movedAt.getTime() >= pausedAt);
  const changedByEvent = pause.reopenFrom !== null && pause.reopenFrom.getTime() > pausedAt;
  if (changedByEvent || !reading.bookmakerUpdate) {
    if (!pricesMoved && !madeAfter) return changedByEvent ? "prices haven't moved since the event, and the bookmaker time isn't later" : "no bookmaker time and prices haven't moved";
  }
  return null;
}
