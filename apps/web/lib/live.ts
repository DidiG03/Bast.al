import type { OddsEvent } from "./api";
import { msg } from "./i18n/core";

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

/** The clock on a match row: "67'", "HT", "FT". */
export function liveClock(event: Pick<OddsEvent, "elapsed" | "period">, t: T): string {
  const code = event.period ? CLOCK[event.period] : undefined;
  if (code) return code;
  return event.elapsed === null ? t("Live") : `${event.elapsed}'`;
}

/** A live match's pill: "Half-time" during the break, otherwise "Live 67'". */
export function livePill(event: Pick<OddsEvent, "elapsed" | "period">, t: T): string {
  const pause = event.period ? BREAKS[event.period] : undefined;
  if (pause) return t(pause);
  return event.elapsed === null ? t("Live") : t("Live {minute}'", { minute: event.elapsed });
}

/** The pause message for a break, or null when the match isn't in one. */
export function breakPause(event: Pick<OddsEvent, "period">): string | null {
  return event.period ? BREAK_PAUSES[event.period] ?? null : null;
}
