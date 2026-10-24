/**
 * Late live bets. Our live feed reports a goal some seconds after it goes
 * in, and someone at the ground (or with a faster stream) sees it first. A
 * live bet records what we showed when it was placed (LiveState). A bet
 * placed after a goal we hadn't shown yet is void, its stake back, whichever
 * way it would have gone, like any bookmaker's rule on bets accepted after
 * the event. The same goes for a bet on a cards market placed after a card we
 * hadn't shown yet, and for any bet but corners and cards placed after a red
 * card we hadn't shown yet (it changes the match).
 *
 * "After" goes by when the goal really went in, not when we heard of it. Each
 * goal's time comes from two places: its minute in the feed's timeline, from
 * when each half kicked off (LateTimeline), and when our site first saw the
 * new score (SeenScore, from GoalSeen). The feed only gives the minute, and
 * its kick-off times can be off, so the goal is taken at the earlier of the
 * start of its minute and LATE_ASSUMED_LAG_MS before we saw it, but never
 * more than LATE_MAX_FEED_LAG_MS before we saw it. A bet placed from
 * LATE_BUFFER_MS before that on, on a score that didn't have the goal, is
 * void: the bet was placed in [goal time - buffer, when we received it].
 * Every rule errs on the side of voiding, never of paying a bet on a goal
 * someone had already seen.
 */

const envMs = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
};
/** A bet placed this long before a goal's time still counts as after it. */
export const LATE_BUFFER_MS = envMs("LATE_BUFFER_MS", 15_000);
/** How far behind the ground our feed usually is: a goal is taken to have gone in at least this long before we saw it. */
export const LATE_ASSUMED_LAG_MS = envMs("LATE_ASSUMED_LAG_MS", 30_000);
/** The most our feed is ever behind: a goal never went in longer than this before we saw it. */
export const LATE_MAX_FEED_LAG_MS = envMs("LATE_MAX_FEED_LAG_MS", 120_000);

export type Side = "home" | "away";

/** What the site showed for a live match when a bet on it was placed. */
export type LiveState = {
  home: number;
  away: number;
  /** The match minute the site showed (the feed's), or null if it had none. */
  minute: number | null;
  /** Cards shown so far (yellow and red), or null when the site had no timeline for the match. */
  cards: number | null;
  /** Red cards shown so far, or null when not known (older bets, or no timeline). */
  reds?: number | null;
  /** How the bet was confirmed, for checking a case afterwards; the late check doesn't read it. */
  audit?: LiveAudit;
  /** The late check's latest decision on it (settlement), for checking a case afterwards. */
  late?: LateRecord;
};

/** The late check's decision on a live bet, kept with it: void or stands, why, and when it was decided. */
export type LateRecord = LateDecision & { checkedAt: string; /** "arrival" (when the goal reached the site), "settlement", or "recheck" (a settled bet looked at again). */ when: string };

/**
 * The feed's own record of a match at one moment, read straight from it: the
 * score in its fixture, how many goals, cards, VAR checks and penalties its
 * timeline has, and the latest of them. Two of these, from when a live bet
 * came in and from the end of its wait, show whether anything happened in
 * between, whatever our saved copy says.
 */
export type FeedMark = {
  home: number | null;
  away: number | null;
  /** In the feed's timeline: goals, every card, red cards, VAR checks, missed penalties, and all of those together. */
  goals: number;
  cards: number;
  reds: number;
  vars: number;
  missedPenalties: number;
  events: number;
  /** The latest of them, e.g. "goal home 67'". */
  last: string | null;
  /** When it was read. */
  at: string;
};

/**
 * What happened between two readings of the feed that a live bet can't go on
 * through, or null: a goal, a red card, a VAR check or a missed penalty
 * (anything on a cards market's bet also counts every card). Counts, not
 * each event, because the feed sometimes moves an event's minute between
 * readings.
 */
export function newInFeed(before: FeedMark, after: FeedMark, cardsMarket: boolean): "a goal" | "a red card" | "a VAR check" | "a penalty" | "a card" | null {
  if (after.goals > before.goals || (after.home ?? 0) + (after.away ?? 0) > (before.home ?? 0) + (before.away ?? 0)) return "a goal";
  if (after.reds > before.reds) return "a red card";
  if (after.vars > before.vars) return "a VAR check";
  if (after.missedPenalties > before.missedPenalties) return "a penalty";
  if (cardsMarket && after.cards > before.cards) return "a card";
  return null;
}

/**
 * A live bet's timing, kept with it: when it was asked for and confirmed, the
 * price then and at the end of the wait, and how fresh the feed was at each
 * point (the time it last sent prices, the time the bookmaker last changed
 * them, and the match clock it gave).
 */
export type LiveAudit = {
  submittedAt: string;
  confirmedAt: string;
  delayMs: number;
  /** Why the wait was longer than usual, or null. */
  longerBecause: string | null;
  askedOdds: number | null;
  confirmedOdds: number | null;
  feedAtSubmit: string | null;
  feedAtConfirm: string | null;
  /** The bookmaker's own "updated at" on the prices read at the end of the wait. */
  bookmakerUpdate: string | null;
  /** The match clock the feed gave with those prices ("61:57"). */
  clock: string | null;
  /** The feed's timeline read straight from it when the bet came in and at the end of the wait (null if it couldn't be). */
  markAtSubmit?: FeedMark | null;
  markAtConfirm?: FeedMark | null;
  /** The score each of the feed's sources gave at the end of the wait: its live prices and its fixture. */
  scoreFromOdds?: string | null;
  scoreFromFixture?: string | null;
  /** How long the checks with the feed at the end of the wait took. */
  checkMs?: number | null;
};

/** A goal or a card, at its minute plus added time (45+2 is minute 45, extra 2). `red` marks a red card (a second yellow too). */
export type Moment = { minute: number; extra: number | null; side: Side; red?: boolean };

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
  return {
    home: state.home,
    away: state.away,
    minute: typeof state.minute === "number" ? state.minute : null,
    cards: typeof state.cards === "number" ? state.cards : null,
    reds: typeof state.reds === "number" ? state.reds : null,
  };
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

/** By `seenAt` our site showed this score: when it first saw each goal (GoalSeen). */
export type SeenScore = { home: number; away: number; seenAt: Date };

/** When a goal's or card's minute began (ms), from its half's kick-off: minute 23 began 22:00 in, 45+2 began 46:00 in. Null without that kick-off. */
export function minuteStart(moment: Moment, timeline: LateTimeline): number | null {
  const firstHalf = moment.minute <= 45;
  const start = firstHalf ? timeline.first : timeline.second;
  if (start === null) return null;
  return (start + (moment.minute - (firstHalf ? 0 : 45) - 1 + (moment.extra ?? 0)) * 60) * 1000;
}

/**
 * When a goal went in at the earliest (ms), from the start of its minute and
 * when our site received it (see the top of this file). Null with neither.
 */
export function eventTime(start: number | null, received: number | null): number | null {
  if (received === null) return start;
  const slowest = received - LATE_MAX_FEED_LAG_MS;
  // Kick-off times that put the goal after we had it are wrong: only when we had it counts then.
  if (start === null || start > received) return slowest;
  return Math.max(slowest, Math.min(start, received - LATE_ASSUMED_LAG_MS));
}

/** What the late check decided about a live bet, and what it went on: kept on the bet and logged. */
export type LateDecision = { late: boolean; reason: string | null; detail: string };

const iso = (ms: number | null) => (ms === null ? "unknown" : new Date(ms).toISOString());
const minuteText = (moment: Moment) => (moment.extra ? `${moment.minute}+${moment.extra}'` : `${moment.minute}'`);

/**
 * Whether a live bet is late (see the top of this file). `timeline` is the
 * feed's, null if it hasn't come; `seen` is when the site saw each score.
 * With neither a timeline nor a score seen after the bet's, it stands.
 */
export function lateDecision(input: { state: LiveState; placedAt: Date; marketKey: string; timeline: LateTimeline | null; seen?: SeenScore[] }): LateDecision {
  const { state, placedAt, marketKey, timeline } = input;
  const seen = [...(input.seen ?? [])].sort((a, b) => a.seenAt.getTime() - b.seenAt.getTime());
  const at = placedAt.getTime();
  const showed = `showed ${state.home}–${state.away}${state.minute === null ? "" : ` at ${state.minute}'`}, placed ${iso(at)}`;
  // Only the match minute to go on: the bet's from the kick-offs, or the one the site showed, which runs behind.
  const betMinute = timeline ? betMoment(placedAt, state, timeline) : state.minute === null ? null : { minute: state.minute, extra: 0 };
  /** Whether a goal or card came before the bet, or close enough before it (LATE_BUFFER_MS) that it may have. */
  const before = (moment: Moment, received: number | null): { yes: boolean; when: number | null } => {
    const when = eventTime(timeline ? minuteStart(moment, timeline) : null, received);
    if (when !== null) return { yes: at >= when - LATE_BUFFER_MS, when };
    if (!betMinute) return { yes: false, when: null };
    // The site's minute runs behind the feed's, so a goal in the minute after it counts too.
    return { yes: atOrBefore(moment, { minute: betMinute.minute + 1, extra: betMinute.extra }), when: null };
  };

  if (isCardsMarket(marketKey)) {
    if (state.cards === null || !timeline) return { late: false, reason: null, detail: `cards: ${state.cards === null ? "no cards recorded when placed" : "no timeline"}; ${showed}` };
    const cards = timeline.cards.map((card) => ({ card, ...before(card, null) })).filter((c) => c.yes);
    if (cards.length > state.cards) {
      const card = cards[state.cards];
      return { late: true, reason: "placed after a card that hadn't shown yet", detail: `card ${minuteText(card.card)} from ${iso(card.when)}; ${showed} with ${state.cards} card(s)` };
    }
    return { late: false, reason: null, detail: `${timeline.cards.length} card(s) checked, ${cards.length} before the bet; ${showed} with ${state.cards}` };
  }
  if (isCornersMarket(marketKey)) return { late: false, reason: null, detail: "corners aren't checked" };

  if (timeline) {
    const ordered = [...timeline.goals].sort((a, b) => a.minute - b.minute || (a.extra ?? 0) - (b.extra ?? 0));
    const counted = { home: [] as string[], away: [] as string[] };
    let home = 0;
    let away = 0;
    for (const goal of ordered) {
      if (goal.side === "home") home++;
      else away++;
      // When the site first showed the score this goal made, if it did.
      const row = seen.find((s) => s.home === home && s.away === away);
      const received = row ? row.seenAt.getTime() : null;
      const check = before(goal, received);
      if (check.yes) counted[goal.side].push(`goal ${home}–${away} at ${minuteText(goal)} from ${iso(check.when)}, seen ${iso(received)}`);
    }
    if (counted.home.length > state.home || counted.away.length > state.away) {
      const culprit = counted.home.length > state.home ? counted.home[state.home] : counted.away[state.away];
      return { late: true, reason: "placed after a goal that hadn't shown yet", detail: `${culprit}; ${showed}` };
    }
    // A red card changes every other market's odds. Only bets that recorded the reds shown can be checked.
    if (typeof state.reds === "number") {
      const reds = timeline.cards.filter((card) => card.red).map((card) => ({ card, ...before(card, null) })).filter((c) => c.yes);
      if (reds.length > state.reds) {
        const red = reds[state.reds];
        return { late: true, reason: "placed after a red card that hadn't shown yet", detail: `red card ${minuteText(red.card)} from ${iso(red.when)}; ${showed} with ${state.reds} red(s)` };
      }
    }
    return { late: false, reason: null, detail: `${ordered.length} goal(s) in the timeline, none before the bet that hadn't shown; ${showed}` };
  }

  // No timeline yet (or the feed's never added up): when the site saw each score is all there is.
  for (const row of seen) {
    if (row.home <= state.home && row.away <= state.away) continue;
    const check = before({ minute: 0, extra: null, side: "home" }, row.seenAt.getTime());
    if (check.yes) return { late: true, reason: "placed after a goal that hadn't shown yet", detail: `score ${row.home}–${row.away} seen ${iso(row.seenAt.getTime())}, so in from ${iso(check.when)} (no timeline); ${showed}` };
  }
  return { late: false, reason: null, detail: `no timeline; ${seen.length} score(s) seen, none that the bet's could have missed; ${showed}` };
}

/** Why a live bet is late, or null when it isn't (or can't be told): see lateDecision. */
export function lateReason(state: LiveState, placedAt: Date, marketKey: string, timeline: LateTimeline | null, seen: SeenScore[] = []): string | null {
  return lateDecision({ state, placedAt, marketKey, timeline, seen }).reason;
}

/**
 * Live corners can't be checked after the match: the feed gives the number
 * of corners, never when each was taken. So a live bet on corners waits
 * longer before it's accepted (a corner shows on the feed's prices in that
 * time), and each Player can have only so much on a match's corners live.
 */
export const LIVE_CORNERS_DELAY_MS = Number(process.env.LIVE_CORNERS_DELAY_MS ?? 20_000);
/** The most a Player can have staked on live corners bets on one match (ALL), across all their open bets. */
export const LIVE_CORNERS_MAX_STAKE = Number(process.env.LIVE_CORNERS_MAX_STAKE ?? 1_000);

/** How long settlement waits for a finished match's timeline before checking its live bets on the scores the site saw alone. */
export const LATE_CHECK_WAIT_MS = Number(process.env.LATE_CHECK_WAIT_MS ?? 3 * 3_600_000);
