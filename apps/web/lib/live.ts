import type { OddsEvent } from "./api";
import { serverNow } from "./clock";
import { msg } from "./i18n/core";
import { holdMinute } from "./live-rules.mjs";

/** Breaks in play, by the feed's phase code: shown instead of the minute. */
const BREAKS: Record<string, string> = {
  FT: msg("Full time"),
  HT: msg("Half-time"),
  BT: msg("Break before extra time"),
  SUSP: msg("Match interrupted"),
  INT: msg("Match interrupted"),
};

/** Why live bets are paused during a break, in words a Player understands. */
const BREAK_PAUSES: Record<string, string> = {
  FT: msg("This match has finished. Bets on it are settled in a few minutes."),
  HT: msg("Half-time break. Live betting reopens when the second half starts."),
  BT: msg("Break before extra time. Live betting reopens when play restarts."),
  SUSP: msg("The match has been interrupted. Live betting reopens if play restarts."),
  INT: msg("The match has been interrupted. Live betting reopens if play restarts."),
};

type T = (text: string, vars?: Record<string, string | number>) => string;

/** Short codes for the match row. The full sentence stays in the banner under the row. */
const CLOCK: Record<string, string> = { HT: "HT", FT: "FT", BT: "BT", SUSP: "INT", INT: "INT", ET: "ET", P: "PEN" };

/** Minutes to add to the feed's last minute while play is going, and no more than this: a stuck update must not run the clock on. */
const CLOCK_CATCHUP_MIN = 1;
const TICKING = new Set(["1H", "2H", "ET"]);

/** A match clock. `elapsed` may be missing on a bet, where the feed never sent a minute. */
type ClockEvent = { id?: string; elapsed?: number | null; elapsedAt?: string | null; period?: string | null };

/** The highest minute already shown for a match in this period. A later poll must not step it back. */
const shownMinute = new Map<string, number>();

function stableMinute(event: ClockEvent, minute: number | null): number | null {
  if (!event.id || minute === null) return minute;
  const key = `${event.id}:${event.period ?? ""}`;
  const next = holdMinute(shownMinute.get(key) ?? null, minute);
  if (typeof next === "number") shownMinute.set(key, next);
  return next;
}

/** The minute to show: the feed's, plus how long since it last moved, while the half is being played. */
export function liveMinute(event: ClockEvent, now = serverNow()): number | null {
  if (event.elapsed === null || event.elapsed === undefined) return null;
  const at = event.elapsedAt ? Date.parse(event.elapsedAt) : NaN;
  if (!Number.isFinite(at) || (event.period && !TICKING.has(event.period))) return event.elapsed;
  const extra = Math.max(0, Math.min(CLOCK_CATCHUP_MIN, Math.floor((now - at) / 60_000)));
  return event.elapsed + extra;
}

/** The clock on a match row: "67'", "HT", "FT". */
export function liveClock(event: ClockEvent, t: T): string {
  const code = event.period ? CLOCK[event.period] : undefined;
  if (code) return code;
  const minute = stableMinute(event, liveMinute(event));
  return minute === null ? t("Live") : `${minute}'`;
}

/** A live match's pill: "Half-time" during the break, otherwise "Live 67'". */
export function livePill(event: ClockEvent, t: T): string {
  const pause = event.period ? BREAKS[event.period] : undefined;
  if (pause) return t(pause);
  const minute = stableMinute(event, liveMinute(event));
  return minute === null ? t("Live") : t("Live {minute}'", { minute });
}

/** The pause message for a break, or null when the match isn't in one. */
export function breakPause(event: Pick<OddsEvent, "period">): string | null {
  return event.period ? BREAK_PAUSES[event.period] ?? null : null;
}
