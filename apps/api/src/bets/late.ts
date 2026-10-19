/**
 * Late live bets. Our live feed reports a goal some seconds after it goes
 * in, and someone at the ground (or with a faster stream) sees it first. A
 * live bet records what we showed when it was placed (LiveState); after full
 * time the feed's timeline says when each goal and card really happened
 * (LateTimeline). A bet placed after a goal we hadn't shown yet is void, its
 * stake back, whichever way it would have gone, like any bookmaker's rule on
 * bets accepted after the event. The same goes for a bet on a cards market
 * placed after a card we hadn't shown yet.
 *
 * The feed gives each goal's minute, not its second, and the bet's minute is
 * worked out from when each half kicked off. A goal in the same minute as the
 * bet may have come before it, so it counts as before: the rule errs on the
 * side of voiding, never of paying a bet on a goal someone had already seen.
 */

export type Side = "home" | "away";

/** What the site showed for a live match when a bet on it was placed. */
export type LiveState = {
  home: number;
  away: number;
  /** The match minute the site showed (the feed's), or null if it had none. */
  minute: number | null;
  /** Cards shown so far (yellow and red), or null when the site had no timeline for the match. */
  cards: number | null;
};

/** A goal or a card, at its minute plus added time (45+2 is minute 45, extra 2). */
export type Moment = { minute: number; extra: number | null; side: Side };

/** A finished match's goals and cards with their minutes, and when each half kicked off (Unix seconds, from the feed). */
export type LateTimeline = { first: number | null; second: number | null; goals: Moment[]; cards: Moment[] };

/** Markets a goal doesn't decide: corners and cards. A goal before such a bet doesn't make it late. */
export const isCornersMarket = (marketKey: string) => /^(home_|away_)?corners/.test(marketKey);
export const isCardsMarket = (marketKey: string) => /^(home_|away_)?cards/.test(marketKey);

/** Reads a stored LiveState, or null when there isn't a usable one. */
export function liveStateOf(value: unknown): LiveState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<LiveState>;
  if (typeof state.home !== "number" || typeof state.away !== "number") return null;
  return { home: state.home, away: state.away, minute: typeof state.minute === "number" ? state.minute : null, cards: typeof state.cards === "number" ? state.cards : null };
}

/** Reads a stored LateTimeline, or null. */
export function timelineOf(value: unknown): LateTimeline | null {
  if (!value || typeof value !== "object") return null;
  const timeline = value as Partial<LateTimeline>;
  if (!Array.isArray(timeline.goals) || !Array.isArray(timeline.cards)) return null;
  return { first: timeline.first ?? null, second: timeline.second ?? null, goals: timeline.goals, cards: timeline.cards };
}

/**
 * When a bet was placed, in match time: from the half's kick-off when the
 * feed sent it, otherwise the minute the site showed. Minutes count like the
 * feed's: the first minute of the match is 1, and added time sits on 45 or 90.
 */
export function betMoment(placedAt: Date, state: LiveState, timeline: LateTimeline): { minute: number; extra: number } | null {
  const at = placedAt.getTime() / 1000;
  const from = (start: number, base: number, end: number) => {
    const minute = base + Math.floor((at - start) / 60) + 1;
    return minute > end ? { minute: end, extra: minute - end } : { minute, extra: 0 };
  };
  if (timeline.second !== null && at >= timeline.second) return from(timeline.second, 45, 90);
  if (timeline.first !== null && at >= timeline.first && (timeline.second === null || at < timeline.second)) return from(timeline.first, 0, 45);
  return state.minute === null ? null : { minute: state.minute, extra: 0 };
}

/** Whether a moment came at or before the bet: earlier minute, or the same minute and no later in added time. */
function atOrBefore(moment: Moment, bet: { minute: number; extra: number }): boolean {
  if (moment.minute !== bet.minute) return moment.minute < bet.minute;
  return (moment.extra ?? 0) <= bet.extra;
}

/**
 * Why a live bet is late, or null when it isn't (or can't be told): a goal
 * went in before it that the site hadn't shown, or, for a cards market, a
 * card was shown before it that the site hadn't.
 */
export function lateReason(state: LiveState, placedAt: Date, marketKey: string, timeline: LateTimeline): string | null {
  const bet = betMoment(placedAt, state, timeline);
  if (!bet) return null;
  if (isCardsMarket(marketKey)) {
    if (state.cards === null) return null;
    const cards = timeline.cards.filter((card) => atOrBefore(card, bet)).length;
    return cards > state.cards ? "placed after a card that hadn't shown yet" : null;
  }
  if (isCornersMarket(marketKey)) return null;
  const before = timeline.goals.filter((goal) => atOrBefore(goal, bet));
  const home = before.filter((goal) => goal.side === "home").length;
  const away = before.filter((goal) => goal.side === "away").length;
  return home > state.home || away > state.away ? "placed after a goal that hadn't shown yet" : null;
}

/** How long settlement waits for a finished match's timeline before settling its live bets without the check. */
export const LATE_CHECK_WAIT_MS = Number(process.env.LATE_CHECK_WAIT_MS ?? 3 * 3_600_000);
