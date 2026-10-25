/**
 * Reading live prices more often where it matters. The whole live board
 * comes in one request (`/odds/live`) as often as the day's budget allows
 * (OddsSyncService.liveOddsDelay); on top of that, the matches that matter
 * most are read on their own (`/odds/live?fixture=`) whenever the board
 * hasn't been read for them lately: those with markets paused after
 * something in the match (fresh prices reopen them, live-guard.ts
 * freshUntil), and those with the most riding on them in open bets.
 */

const envNumber = (name: string, fallback: number) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);

/** A match that matters is read at least this often, from the board or on its own. */
export const LIVE_HOT_MS = envNumber("LIVE_ODDS_HOT_MS", 5_000);
/** At most this many matches are read on their own each time (one request each). */
export const LIVE_HOT_MAX = envNumber("LIVE_ODDS_HOT_MAX", 4);
/** What's kept back of each minute's requests (API-Football also limits requests a minute). */
export const MINUTE_RESERVE = envNumber("API_FOOTBALL_MINUTE_RESERVE", 0.2);

export type HotCandidate = {
  eventId: string;
  /** What open bets on it would pay out (stake times price), ALL. */
  exposure: number;
  /** It has markets paused, waiting for fresh prices. */
  waiting: boolean;
  /** When its prices were last read, ms; null if never. */
  lastRead: number | null;
};

/**
 * The matches to read on their own now, most important first: those waiting
 * for fresh prices to reopen markets, then the most exposed. A match read
 * within LIVE_HOT_MS (by the board or on its own) waits its turn; one with
 * nothing paused and nothing riding on it is left to the board.
 */
export function hotMatches(candidates: HotCandidate[], now: number, max = LIVE_HOT_MAX, everyMs = LIVE_HOT_MS): HotCandidate[] {
  return candidates
    .filter((candidate) => (candidate.waiting || candidate.exposure > 0) && (candidate.lastRead === null || now - candidate.lastRead >= everyMs))
    .sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.exposure - a.exposure || (a.lastRead ?? 0) - (b.lastRead ?? 0))
    .slice(0, Math.max(0, max));
}

/** Whether this minute's requests leave room for `count` more, keeping MINUTE_RESERVE of the minute's limit back. Unknown limits leave room. */
export function minuteRoom(left: number | null, limit: number | null, count: number): boolean {
  if (left === null || limit === null) return true;
  return left - count >= Math.ceil(limit * MINUTE_RESERVE);
}

type Window = { reads: number; first: number; last: number; ageSum: number; ageCount: number; ageMax: number };

export type PollingSummary = {
  eventId: string;
  reads: number;
  /** The average time between readings, ms (null with one reading). */
  everyMs: number | null;
  /** How old the bookmaker's prices were when they came in (when it says when it made them), ms. */
  ageMs: number | null;
  ageMaxMs: number | null;
};

/**
 * How often each live match's prices were read and how far behind the
 * bookmaker they were when they arrived, over a window (logged and shown on
 * the live health page, so the polling can be tuned).
 */
export class PollingStats {
  private window = new Map<string, Window>();
  private previous: PollingSummary[] = [];
  private windowStart = Date.now();
  private readonly lastAt = new Map<string, number>();

  note(eventId: string, at: Date, bookmakerUpdate: Date | null) {
    const time = at.getTime();
    this.lastAt.set(eventId, time);
    const entry = this.window.get(eventId) ?? { reads: 0, first: time, last: time, ageSum: 0, ageCount: 0, ageMax: 0 };
    entry.reads++;
    entry.last = time;
    if (bookmakerUpdate) {
      const age = Math.max(0, time - bookmakerUpdate.getTime());
      entry.ageSum += age;
      entry.ageCount++;
      entry.ageMax = Math.max(entry.ageMax, age);
    }
    this.window.set(eventId, entry);
    if (this.lastAt.size > 1_000) for (const [id, last] of this.lastAt) if (time - last > 3_600_000) this.lastAt.delete(id);
  }

  lastRead(eventId: string): number | null {
    return this.lastAt.get(eventId) ?? null;
  }

  /** The current window, by match. */
  current(): PollingSummary[] {
    return [...this.window].map(([eventId, w]) => ({
      eventId,
      reads: w.reads,
      everyMs: w.reads > 1 ? Math.round((w.last - w.first) / (w.reads - 1)) : null,
      ageMs: w.ageCount > 0 ? Math.round(w.ageSum / w.ageCount) : null,
      ageMaxMs: w.ageCount > 0 ? w.ageMax : null,
    }));
  }

  /** Ends the window: returns it and starts a new one. */
  take(): { since: number; matches: PollingSummary[] } {
    const matches = this.current();
    const since = this.windowStart;
    this.previous = matches;
    this.window = new Map();
    this.windowStart = Date.now();
    return { since, matches };
  }

  /** The last full window, for when the current one has only just started. */
  last(): PollingSummary[] {
    return this.previous;
  }
}
