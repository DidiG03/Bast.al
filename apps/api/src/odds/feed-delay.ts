import { type LateTimeline, type Moment, minuteStart } from "../bets/late";

/**
 * How long after a goal goes in the site first sees it (GoalSeen), measured
 * against the finished match's timeline. The feed gives a goal's minute, not
 * its second, so each goal is taken to be in the middle of its minute: one
 * goal's figure is good to about half a minute either way, and the average
 * over many goals is close.
 */

export type SeenGoal = { eventName: string; homeScore: number; awayScore: number; source: string; seenAt: Date; timeline: LateTimeline };

export type FeedDelay = {
  goals: number;
  /** Seconds, rounded; null without any goals measured. */
  average: number | null;
  median: number | null;
  /** Nine goals in ten arrived within this. */
  p90: number | null;
  slowest: number | null;
  /** The average for each source: the live scores list and the live prices. */
  bySource: Record<string, { goals: number; average: number }>;
  /** The newest goals measured, newest first. */
  recent: Array<{ eventName: string; score: string; minute: string; source: string; seenAt: string; seconds: number }>;
};

/** When a goal most likely went in, in Unix seconds: the middle of its minute, from its half's kick-off. Null without that kick-off. */
export function goalTime(goal: Moment, timeline: LateTimeline): number | null {
  const firstHalf = goal.minute <= 45;
  const start = firstHalf ? timeline.first : timeline.second;
  if (start === null) return null;
  return start + (goal.minute - (firstHalf ? 0 : 45) - 0.5 + (goal.extra ?? 0)) * 60;
}

/**
 * How far behind the ground the site was on one goal, from its minute in the
 * feed's timeline and when the site first saw it: `eventAt` is the middle of
 * the goal's minute (ms), `lagMs` the delay from it (good to about half a
 * minute either way), and `lagMinMs` the least it can have been (from the
 * end of the minute), which no goal timed by its minute can make look worse
 * than it was. Null without the half's kick-off.
 */
export function goalLag(goal: Moment, timeline: LateTimeline, seenAt: Date): { eventAt: number; lagMs: number; lagMinMs: number } | null {
  const start = minuteStart(goal, timeline);
  if (start === null) return null;
  const eventAt = start + 30_000;
  return { eventAt, lagMs: seenAt.getTime() - eventAt, lagMinMs: seenAt.getTime() - (start + 60_000) };
}

/** The goal of a timeline that made a score: the n-th of the match in time order, when the goals up to it add up to the score. */
export function goalForScore(timeline: LateTimeline, home: number, away: number): Moment | null {
  const ordered = [...timeline.goals].sort((a, b) => a.minute - b.minute || (a.extra ?? 0) - (b.extra ?? 0));
  const goal = ordered[home + away - 1];
  if (!goal || ordered.slice(0, home + away).filter((g) => g.side === "home").length !== home) return null;
  return goal;
}

/**
 * A measured minimum delay outside this is a goal matched to the wrong minute
 * (a kick-off time the feed got wrong, a VAR goal put back), not a feed that
 * slow. It is left out of the figures that gate live betting. 120 s is past
 * any wait a live bet sits through, so a real delay that long still shows up
 * as the feed being too slow once enough goals are inside the window.
 */
export const PLAUSIBLE_LAG_MS = { min: 0, max: 120_000 };

/** One goal's delay (GoalSeen.lagMinMs, the least it can have been) with where its match came from. */
export type GoalLagRow = { lagMinMs: number; /** The delay from the middle of the minute, used when the least possible delay is negative. */ lagMs?: number | null; provider: string; league: string };
/** The delay on goals for one group of matches: how many goals, and the share (`percentile`) that arrived within `p`, seconds. */
export type LagGroup = { goals: number; p: number; median: number };

/**
 * The feed's delay on goals, overall, by provider and by competition
 * ("provider · league"). It goes by each goal's least possible delay
 * (goalLag's lagMinMs): a goal's minute gives its time only to the minute,
 * so its middle would put up to half a minute of guesswork into every goal,
 * and the slowest ones would all look half a minute slower than they were.
 * The least possible delay never makes the feed look slower than it was,
 * and over many goals its high end (`percentile`, 0.95 by default) comes
 * close to the real one.
 */
/**
 * The figure a goal contributes. Normally the least it can have been.
 * When that is negative (the site saw the goal before its minute ended) the
 * delay from the middle of the minute is used instead, if that is plausible,
 * so a feed that is about 40–50 s behind is still counted for its competition.
 */
export function lagSample(row: GoalLagRow): number | null {
  if (row.lagMinMs >= PLAUSIBLE_LAG_MS.min && row.lagMinMs <= PLAUSIBLE_LAG_MS.max) return row.lagMinMs;
  if (row.lagMinMs < PLAUSIBLE_LAG_MS.min && typeof row.lagMs === "number" && row.lagMs >= PLAUSIBLE_LAG_MS.min && row.lagMs <= PLAUSIBLE_LAG_MS.max) return row.lagMs;
  return null;
}

export function lagStats(rows: GoalLagRow[], percentile = 0.95): { all: LagGroup | null; byProvider: Record<string, LagGroup>; byCompetition: Record<string, LagGroup>; ignored: number } {
  const kept = rows.flatMap((row) => {
    const sample = lagSample(row);
    return sample === null ? [] : [{ ...row, sample }];
  });
  const group = (values: number[]): LagGroup | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const at = (share: number) => Math.round(Math.max(0, sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]) / 1000);
    return { goals: sorted.length, p: at(percentile), median: at(0.5) };
  };
  const by = (key: (row: GoalLagRow & { sample: number }) => string) => {
    const groups = new Map<string, number[]>();
    for (const row of kept) groups.set(key(row), [...(groups.get(key(row)) ?? []), row.sample]);
    return Object.fromEntries([...groups].map(([name, values]) => [name, group(values)!]));
  };
  return { all: group(kept.map((row) => row.sample)), byProvider: by((row) => row.provider), byCompetition: by((row) => competitionKey(row.provider, row.league)), ignored: rows.length - kept.length };
}

/**
 * Which competitions are too slow for live betting, from lagStats. Only a
 * competition's own goals count (at least `minGoals`): a slow average across
 * every league must not close one that hasn't been measured. When every
 * measured competition is over `maxLagMs`, the figures are treated as broken
 * (a bad kick-off time, a clock) and nothing is closed; the caller alerts
 * instead. `maxLagMs` of 0 turns the gate off.
 */
export function lagGate(stats: { byCompetition: Record<string, LagGroup> } | null, opts: { maxLagMs: number; minGoals: number }): { slow: string[]; broken: boolean; measured: number } {
  if (!stats || opts.maxLagMs <= 0) return { slow: [], broken: false, measured: 0 };
  const measured = Object.entries(stats.byCompetition).filter(([, group]) => group.goals >= opts.minGoals);
  const slow = measured.filter(([, group]) => group.p * 1000 >= opts.maxLagMs).map(([name]) => name);
  const broken = measured.length >= 2 && slow.length === measured.length;
  return { slow: broken ? [] : slow, broken, measured: measured.length };
}

/** How a competition is named in lagStats. */
export const competitionKey = (provider: string, league: string) => `${provider} · ${league}`;

/** A measured delay outside this (seconds) means the goal was matched wrongly, not that the feed was that late or early. */
const PLAUSIBLE = { min: -90, max: 900 };

export function feedDelay(seen: SeenGoal[], recentCount = 15): FeedDelay {
  const measured: Array<SeenGoal & { seconds: number; goal: Moment }> = [];
  for (const row of seen) {
    // The goal that made this score: the n-th of the match, in time order.
    const ordered = [...row.timeline.goals].sort((a, b) => a.minute - b.minute || (a.extra ?? 0) - (b.extra ?? 0));
    const n = row.homeScore + row.awayScore;
    const goal = ordered[n - 1];
    if (!goal) continue;
    // The goals up to it have to add up to the score seen, or it's a different goal (one taken back by VAR, say).
    if (ordered.slice(0, n).filter((g) => g.side === "home").length !== row.homeScore) continue;
    const at = goalTime(goal, row.timeline);
    if (at === null) continue;
    const seconds = row.seenAt.getTime() / 1000 - at;
    if (seconds < PLAUSIBLE.min || seconds > PLAUSIBLE.max) continue;
    measured.push({ ...row, seconds, goal });
  }
  const round = (value: number) => Math.round(value);
  const sorted = measured.map((row) => row.seconds).sort((a, b) => a - b);
  const pick = (share: number) => (sorted.length === 0 ? null : round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]));
  const average = (rows: number[]) => (rows.length === 0 ? null : round(rows.reduce((sum, value) => sum + value, 0) / rows.length));
  const bySource: FeedDelay["bySource"] = {};
  for (const source of new Set(measured.map((row) => row.source))) {
    const rows = measured.filter((row) => row.source === source).map((row) => row.seconds);
    bySource[source] = { goals: rows.length, average: average(rows)! };
  }
  return {
    goals: measured.length,
    average: average(sorted),
    median: pick(0.5),
    p90: pick(0.9),
    slowest: sorted.length === 0 ? null : round(sorted[sorted.length - 1]),
    bySource,
    recent: [...measured]
      .sort((a, b) => b.seenAt.getTime() - a.seenAt.getTime())
      .slice(0, recentCount)
      .map((row) => ({
        eventName: row.eventName,
        score: `${row.homeScore}–${row.awayScore}`,
        minute: row.goal.extra ? `${row.goal.minute}+${row.goal.extra}` : String(row.goal.minute),
        source: row.source,
        seenAt: row.seenAt.toISOString(),
        seconds: round(row.seconds),
      })),
  };
}
