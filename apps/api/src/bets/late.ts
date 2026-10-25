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
 * goal's time comes from its minute in the feed's timeline, from when its
 * half kicked off (LateTimeline; when the feed sends no kick-off times, from
 * the match clock the feed gave as the bet was confirmed, LiveAudit.clock),
 * and from when our site first saw the new score (SeenScore, from GoalSeen).
 * The feed only gives the minute, so the goal is taken at the earlier of the
 * start of its minute and LATE_ASSUMED_LAG_MS before we saw it; with no
 * usable minute, LATE_MAX_FEED_LAG_MS before we saw it. A bet placed from
 * LATE_BUFFER_MS before that on, on a score without the goal, is void: the
 * bet was placed in [goal time - buffer, when we received it].
 *
 * Nothing is paid without the check: a live bet on a match that scored after
 * the score it was placed on, where that goal can't be timed at all (no
 * timeline from the feed and the site never saw it), is void too, once
 * settlement has waited LATE_CHECK_WAIT_MS for the timeline. Every rule errs
 * on the side of voiding, never of paying a bet on a goal someone had
 * already seen. LATE_RULE_VERSION goes up when the rule changes, so bets
 * checked under an older one are checked again (SettlementService).
 */

const envMs = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
};
/** A bet placed this long before a goal's time still counts as after it. */
export const LATE_BUFFER_MS = envMs("LATE_BUFFER_MS", 30_000);
/** How far behind the ground our feed usually is: a goal is taken to have gone in at least this long before we saw it. */
export const LATE_ASSUMED_LAG_MS = envMs("LATE_ASSUMED_LAG_MS", 30_000);
/** How far behind our feed can be: with no usable minute for a goal, it's taken to have gone in this long before we saw it. */
export const LATE_MAX_FEED_LAG_MS = envMs("LATE_MAX_FEED_LAG_MS", 120_000);
/** The late rule's version, kept with each decision: a bet decided under an older one is checked again. */
export const LATE_RULE_VERSION = 3;

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
  /** The match's state version (Event.liveVersion) when the bet came in and at the end of the wait. */
  versionAtSubmit?: number | null;
  versionAtConfirm?: number | null;
};

/** A goal or a card, at its minute plus added time (45+2 is minute 45, extra 2). `red` marks a red card (a second yellow too). */
export type Moment = { minute: number; extra: number | null; side: Side; red?: boolean };

/** A finished match's goals and cards with their minutes, and when each half kicked off (Unix seconds, from the feed). */
export type LateTimeline = { first: number | null; second: number | null; goals: Moment[]; cards: Moment[] };

/** Markets a goal doesn't decide: corners and cards. A goal before such a bet doesn't make it late. */
export const isCornersMarket = (marketKey: string) => /^(home_|away_)?corners/.test(marketKey);
export const isCardsMarket = (marketKey: string) => /^(home_|away_)?cards/.test(marketKey);

/** Reads a stored LiveState, or null when there isn't a usable one. The record of how it was confirmed comes too, when kept. */
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
    ...(state.audit && typeof state.audit === "object" ? { audit: state.audit } : {}),
  };
}

/**
 * When the half the bet was placed in kicked off (Unix seconds), from the
 * match clock the feed gave with the prices read as it was confirmed
 * ("61:57" at feedAtConfirm), for a timeline without kick-off times. Null
 * without a clock, or at 45:xx, which could be either half.
 */
export function kickOffFromClock(audit: LiveAudit | undefined): { first: number | null; second: number | null } | null {
  const match = /^(\d+):(\d{2})$/.exec(audit?.clock ?? "");
  const readAt = audit?.feedAtConfirm ? Date.parse(audit.feedAtConfirm) : NaN;
  if (!match || Number.isNaN(readAt)) return null;
  const minutes = Number(match[1]);
  const elapsed = minutes * 60 + Number(match[2]);
  if (minutes < 45) return { first: Math.round(readAt / 1000 - elapsed), second: null };
  if (minutes >= 46) return { first: null, second: Math.round(readAt / 1000 - (elapsed - 45 * 60)) };
  return null;
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
  // Kick-off times that put the goal after we had it are wrong: only when we had it counts then.
  if (start === null || start > received) return received - LATE_MAX_FEED_LAG_MS;
  return Math.min(start, received - LATE_ASSUMED_LAG_MS);
}

/**
 * What the late check decided about a live bet, and what it went on: kept on
 * the bet and logged. `undecided`: the match scored after the bet's score and
 * that goal can't be timed (no timeline, never seen by the site); settlement
 * waits for the timeline, then voids it.
 */
export type LateDecision = { late: boolean; undecided?: boolean; reason: string | null; detail: string; version?: number };

/** Why a bet whose later goal can't be timed is void. */
export const UNTIMED_REASON = "couldn't confirm it was placed before a goal the feed reported late";

const iso = (ms: number | null) => (ms === null ? "unknown" : new Date(ms).toISOString());
const minuteText = (moment: Moment) => (moment.extra ? `${moment.minute}+${moment.extra}'` : `${moment.minute}'`);

/**
 * Whether a live bet is late (see the top of this file). `timeline` is the
 * feed's, null if it hasn't come; `seen` is when the site saw each score;
 * `result` is the final score, when the match is over, to tell goals after
 * the bet's score that nothing can time.
 */
export function lateDecision(input: { state: LiveState; placedAt: Date; marketKey: string; timeline: LateTimeline | null; seen?: SeenScore[]; result?: { home: number; away: number } | null }): LateDecision {
  const { state, placedAt, marketKey } = input;
  // Kick-off times the feed's timeline lacks come from the match clock the bet recorded.
  const clock = kickOffFromClock(state.audit);
  const timeline = input.timeline && clock ? { ...input.timeline, first: input.timeline.first ?? clock.first, second: input.timeline.second ?? clock.second } : input.timeline;
  const seen = [...(input.seen ?? [])].sort((a, b) => a.seenAt.getTime() - b.seenAt.getTime());
  const at = placedAt.getTime();
  const showed = `showed ${state.home}–${state.away}${state.minute === null ? "" : ` at ${state.minute}'`}, placed ${iso(at)}`;
  // Only the match minute to go on: the bet's from the kick-offs, or the one the site showed, which runs behind.
  const betMinute = timeline ? betMoment(placedAt, state, timeline) : state.minute === null ? null : { minute: state.minute, extra: 0 };
  /** Whether a goal or card came before the bet, or close enough before it (LATE_BUFFER_MS) that it may have. */
  const before = (moment: Moment, received: number | null): { yes: boolean; how: string } => {
    const when = eventTime(timeline ? minuteStart(moment, timeline) : null, received);
    if (when !== null) return { yes: at >= when - LATE_BUFFER_MS, how: `in from ${iso(when)}` };
    if (!betMinute) return { yes: false, how: "no time for it or the bet" };
    // The site's minute runs behind the feed's, so a goal up to two minutes after it counts too.
    return { yes: atOrBefore(moment, { minute: betMinute.minute + 2, extra: betMinute.extra }), how: `minute only, the bet's ${betMinute.minute}'` };
  };
  const done = (decision: LateDecision): LateDecision => ({ ...decision, version: LATE_RULE_VERSION });

  if (isCardsMarket(marketKey)) {
    if (state.cards === null || !timeline) return done({ late: false, reason: null, detail: `not voided because ${state.cards === null ? "no cards were recorded when it was placed" : "the feed's timeline hasn't come"}; ${showed}` });
    const cards = timeline.cards.map((card) => ({ card, ...before(card, null) })).filter((c) => c.yes);
    if (cards.length > state.cards) {
      const card = cards[state.cards];
      return done({ late: true, reason: "placed after a card that hadn't shown yet", detail: `card ${minuteText(card.card)} ${card.how}; ${showed} with ${state.cards} card(s)` });
    }
    return done({ late: false, reason: null, detail: `not voided because ${timeline.cards.length} card(s) in the timeline, ${cards.length} before the bet, and it showed ${state.cards}; ${showed}` });
  }
  if (isCornersMarket(marketKey)) return done({ late: false, reason: null, detail: "not voided because corners aren't checked" });

  if (timeline) {
    const ordered = [...timeline.goals].sort((a, b) => a.minute - b.minute || (a.extra ?? 0) - (b.extra ?? 0));
    const counted = { home: [] as string[], away: [] as string[] };
    const notes: string[] = [];
    let home = 0;
    let away = 0;
    for (const goal of ordered) {
      if (goal.side === "home") home++;
      else away++;
      // When the site first showed the score this goal made, if it did.
      const row = seen.find((s) => s.home === home && s.away === away);
      const received = row ? row.seenAt.getTime() : null;
      const check = before(goal, received);
      const text = `goal ${home}–${away} at ${minuteText(goal)} (${check.how}, seen ${iso(received)})`;
      if (check.yes) counted[goal.side].push(text);
      const shown = goal.side === "home" ? home <= state.home : away <= state.away;
      notes.push(`${text}: ${shown ? "already showing" : check.yes ? "before the bet" : "after the bet"}`);
    }
    if (counted.home.length > state.home || counted.away.length > state.away) {
      const culprit = counted.home.length > state.home ? counted.home[state.home] : counted.away[state.away];
      return done({ late: true, reason: "placed after a goal that hadn't shown yet", detail: `${culprit}; ${showed}` });
    }
    // A red card changes every other market's odds. Only bets that recorded the reds shown can be checked.
    if (typeof state.reds === "number") {
      const reds = timeline.cards.filter((card) => card.red).map((card) => ({ card, ...before(card, null) })).filter((c) => c.yes);
      if (reds.length > state.reds) {
        const red = reds[state.reds];
        return done({ late: true, reason: "placed after a red card that hadn't shown yet", detail: `red card ${minuteText(red.card)} ${red.how}; ${showed} with ${state.reds} red(s)` });
      }
    }
    return done({ late: false, reason: null, detail: `not voided because ${ordered.length === 0 ? "the timeline has no goals" : notes.join("; ")}; ${showed}` });
  }

  // No timeline yet (or the feed's never added up): when the site saw each score is all there is.
  // The first score past the bet's decides: a goal after it can only be later still.
  const next = seen.find((row) => row.home > state.home || row.away > state.away);
  if (next) {
    const check = before({ minute: 0, extra: null, side: "home" }, next.seenAt.getTime());
    if (check.yes) return done({ late: true, reason: "placed after a goal that hadn't shown yet", detail: `score ${next.home}–${next.away} seen ${iso(next.seenAt.getTime())}, ${check.how} (no timeline); ${showed}` });
    return done({ late: false, reason: null, detail: `not voided because the first score past the bet's, ${next.home}–${next.away}, was seen ${iso(next.seenAt.getTime())}, ${check.how}: after the bet (no timeline); ${showed}` });
  }
  const result = input.result ?? null;
  if (result && (result.home > state.home || result.away > state.away)) {
    return done({ late: false, undecided: true, reason: UNTIMED_REASON, detail: `the match ended ${result.home}–${result.away}, but there's no timeline and the site never saw a score past the bet's; ${showed}` });
  }
  return done({ late: false, reason: null, detail: `not voided because ${result ? `the match ended ${result.home}–${result.away}, no goal after the bet's score` : `there's no timeline yet and no score past the bet's was seen (${seen.length} seen)`}; ${showed}` });
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
