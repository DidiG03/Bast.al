/**
 * Spreading API-Football's daily requests over the day. The plan's count
 * starts again at midnight UTC; each answer says how many requests are left
 * and how many the plan allows (see httpFetchJson), so the pacing follows
 * whichever plan is active without a setting.
 *
 * Each repeating task (live prices, live scores, match stats) asks for the
 * interval it would like. While there's plenty left it gets exactly that;
 * when what's left wouldn't last until midnight at that speed, its runs are
 * spaced out so its share of what's left does. A reserve is kept back for
 * live scores and results, so bets can always be settled, and once the plan
 * says the day's requests are used up nothing is asked until the reset.
 */

const DAY_MS = 86_400_000;

/** Time until API-Football's daily count starts again (midnight UTC). */
export function msUntilReset(now: number): number {
  return DAY_MS - (now % DAY_MS);
}

/** What's kept back for live scores and results: 8% of the plan, at least 600 requests. */
export function quotaReserve(limit: number | null): number {
  const fromEnv = Number(process.env.API_FOOTBALL_QUOTA_RESERVE);
  if (fromEnv > 0) return fromEnv;
  return Math.max(600, Math.round((limit ?? 7_500) * 0.08));
}

/**
 * How long to wait before the next run of a task that would like to run
 * every `wantMs` and costs `perRun` requests, when it may use `share` (0..1)
 * of the requests `left` until the reset in `msLeft`. Never shorter than
 * `wantMs`; Infinity when it can't afford a single run.
 */
export function pacedInterval(input: { wantMs: number; perRun: number; share: number; left: number | null; msLeft: number }): number {
  if (input.left === null) return input.wantMs;
  const runs = (Math.max(0, input.left) * input.share) / Math.max(1, input.perRun);
  if (runs < 1) return Infinity;
  return Math.max(input.wantMs, input.msLeft / runs);
}

/** Whether an error from the feed says the day's requests are used up. */
export function isDailyLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /request limit for the day|reached the request limit/i.test(message);
}

/**
 * Plans with this many requests a day or more refresh pre-match prices
 * often (PREMATCH_REFRESH_MS.rich); smaller ones keep to the lean schedule.
 */
export const RICH_PLAN = 30_000;

/**
 * How often each day's fixtures and pre-match prices are refreshed, today
 * first. Prices days out barely move, so they're fetched rarely.
 */
export const PREMATCH_REFRESH_MS = {
  /** 75,000 a day (Ultra): today every 10 minutes, tomorrow every 30, then every 2 hours, the last days every 4. */
  rich: [10 * 60_000, 30 * 60_000, 2 * 3_600_000, 2 * 3_600_000, 3 * 3_600_000, 4 * 3_600_000],
  /** 7,500 a day (Pro): today every 30 minutes, tomorrow every 2 hours, then every 6, the last two days every 12. */
  lean: [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 6 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000],
};
