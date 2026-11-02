import { SelectionResult } from "@prisma/client";
import { LIVE_CUTOFF_MINUTE } from "./live-guard";

/**
 * Extra time and penalties. Every other football market is on the 90
 * minutes and stoppage time, so once a match goes to extra time those are
 * decided. What can be bet on then is its own set of markets, live only:
 *
 * - Extra time result, double chance and goals: extra time's own goals
 *   (the 30 minutes), not the 90 before them;
 * - To qualify: who goes through, on extra time, then the shootout if it's
 *   level. A match goes to extra time only when the tie is level (on the
 *   night, or on aggregate in a second leg), so this is right for both;
 * - Penalty shootout winner: the shootout.
 *
 * They open when extra time starts (the break before it included) and close
 * near its end (LIVE_ET_CUTOFF_MINUTE) and for the whole shootout, which is
 * too quick for a live feed. The 90-minute markets never take bets then.
 */

/** Extra time and its breaks, by the feed's phase code. "P" is the shootout. */
export const EXTRA_TIME_PERIODS = new Set(["ET", "BT"]);
export const SHOOTOUT_PERIOD = "P";

/** No live bets from this minute of extra time on, like the minute-89 cutoff in the 90 minutes. */
export const LIVE_ET_CUTOFF_MINUTE = process.env.LIVE_ET_CUTOFF_MINUTE !== undefined && Number.isFinite(Number(process.env.LIVE_ET_CUTOFF_MINUTE)) ? Number(process.env.LIVE_ET_CUTOFF_MINUTE) : 118;

export function isExtraTimeMarket(marketKey: string): boolean {
  return marketKey.startsWith("et_") || marketKey === "to_qualify" || marketKey === "pen_winner";
}

/** Whether a market can take bets in this phase of a live match: extra-time markets only in extra time, the others never then. */
export function marketInPhase(marketKey: string, period: string | null | undefined): boolean {
  if (period === SHOOTOUT_PERIOD) return false;
  const extra = isExtraTimeMarket(marketKey);
  return EXTRA_TIME_PERIODS.has(period ?? "") ? extra : !extra;
}

/** Whether live betting has closed for the end of a period: minute 89 in the 90 minutes, LIVE_ET_CUTOFF_MINUTE in extra time, the whole shootout. */
export function liveCutoffReached(elapsed: number | null | undefined, period: string | null | undefined): boolean {
  if (period === SHOOTOUT_PERIOD) return true;
  const minute = elapsed ?? 0;
  if (EXTRA_TIME_PERIODS.has(period ?? "")) return LIVE_ET_CUTOFF_MINUTE > 0 && minute >= LIVE_ET_CUTOFF_MINUTE;
  return LIVE_CUTOFF_MINUTE > 0 && minute >= LIVE_CUTOFF_MINUTE;
}

type Score = { home: number; away: number };

/** What the extra-time markets settle on, from a finished match. */
export type ExtraTimeResult = {
  /** The match went to extra time (and maybe penalties). */
  extraTime: boolean;
  /** Goals in extra time alone. */
  extraTimeScore: Score | null;
  /** The shootout's score. */
  penalties: Score | null;
};

const winner = (score: Score): "home" | "draw" | "away" => (score.home > score.away ? "home" : score.home < score.away ? "away" : "draw");

/**
 * Grades an extra-time market. A match decided in the 90 minutes had no extra
 * time: its bets are void (they can only have been placed once extra time had
 * started, so this is a correction to the result rather than the usual case).
 * The shootout winner is void when extra time decided it. Null while a number
 * it needs is missing: the bet waits for Super Admin.
 */
export function gradeExtraTime(marketKey: string, selectionKey: string, result: ExtraTimeResult): SelectionResult | null {
  if (!result.extraTime) return SelectionResult.VOID;
  const won = (yes: boolean) => (yes ? SelectionResult.WON : SelectionResult.LOST);
  const et = result.extraTimeScore;
  const pens = result.penalties;
  if (marketKey === "pen_winner") {
    if (selectionKey !== "home" && selectionKey !== "away") return null;
    if (pens) return won(winner(pens) === selectionKey);
    return et && winner(et) !== "draw" ? SelectionResult.VOID : null;
  }
  if (!et) return null;
  if (marketKey === "to_qualify") {
    if (selectionKey !== "home" && selectionKey !== "away") return null;
    const side = winner(et) !== "draw" ? winner(et) : pens ? winner(pens) : null;
    return side === null || side === "draw" ? null : won(side === selectionKey);
  }
  if (marketKey === "et_winner") return ["home", "draw", "away"].includes(selectionKey) ? won(winner(et) === selectionKey) : null;
  if (marketKey === "et_double_chance") {
    const side = winner(et);
    if (selectionKey === "home_draw") return won(side !== "away");
    if (selectionKey === "draw_away") return won(side !== "home");
    if (selectionKey === "home_away") return won(side !== "draw");
    return null;
  }
  const line = /^et_goals_(\d+)_5$/.exec(marketKey);
  if (line) {
    const threshold = Number(line[1]) + 0.5;
    const goals = et.home + et.away;
    if (selectionKey === "over") return won(goals > threshold);
    if (selectionKey === "under") return won(goals < threshold);
  }
  return null;
}
