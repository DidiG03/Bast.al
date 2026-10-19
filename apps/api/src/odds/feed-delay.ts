import type { LateTimeline, Moment } from "../bets/late";

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
