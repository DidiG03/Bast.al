import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { EventStatus } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { fetchLiveScores, fetchMatchScore, type SportScoreScore } from "./sportscore-scores";
import { OddsSyncService } from "./odds-sync.service";

/** Lets tests hand in their own fetch. */
export const EARLY_GOAL_FETCH = "EARLY_GOAL_FETCH";

/**
 * How often SportScore's live scores are read while one of our live football
 * matches is linked to it: every 2 s with a SportScore key (6,000 requests a
 * minute), every 4 s without one, held to EARLY_GOAL_DAILY_BUDGET requests a
 * day (their anonymous tier allows about 10,000 per IP).
 */
const KEYED_MS = 2_000;
const ANONYMOUS_MS = 4_000;
const ANONYMOUS_DAILY_BUDGET = 9_000;
/** While nothing linked is live, the next look is this far off. */
const IDLE_MS = 30_000;
/** After a failed read, the next one waits this long, doubling up to the cap. */
const BACKOFF_MS = 10_000;
const BACKOFF_MAX_MS = 2 * 60_000;
/** A live slip's own check (checkNow) waits this long for SportScore, then goes ahead on what's known. */
const CHECK_TIMEOUT_MS = 2_000;
/** Slips on the same match within this long share one check. */
const CHECK_SHARE_MS = 1_000;
/**
 * Linked live matches missing from the day's live list (SportScore's
 * status=live filter has come back empty while matches were live) are read
 * one by one from their own page, this many in one timed read at most, the
 * ones read longest ago first.
 */
const DETAILS_PER_READ_KEYED = 30;
const DETAILS_PER_READ_ANONYMOUS = 6;
/** Match pages are read at most this often (they never slow the live list's own reads). */
const DETAILS_EVERY_KEYED_MS = 4_000;
const DETAILS_EVERY_ANONYMOUS_MS = 30_000;
/**
 * Each kind of read has its share of the day's requests, so none starves
 * another: the live list (one request for every match, the one that catches
 * most goals first), the match pages of linked matches the list is missing,
 * and the live slips' own checks, which may also use anything left.
 */
const LIST_SHARE = 0.65;
const PAGES_SHARE = 0.1;
/** How often the pace is logged. */
const PACE_LOG_MS = 60 * 60_000;
/** The warning that the live list is missing linked matches is logged at most this often. */
const WARN_EVERY_MS = 10 * 60_000;

/**
 * Early goal signals. SportScore usually shows a goal some seconds before
 * API-Football, our odds feed, and takes back a disallowed one sooner too.
 * This reads SportScore's live scores and hands each linked live football
 * match's score to OddsSyncService.sourceScore: when it differs from our
 * board, every market of the match pauses at once, server-side, and live
 * slips on it are refused until our feed agrees (or the hold ends). The late
 * check counts a goal from when SportScore showed it (EarlyGoal), so a bet
 * placed after the real goal is voided, never paid.
 *
 * - The day's list is read on a timer, asked past SportScore's own cache (it
 *   refreshes it about once a minute otherwise).
 * - A live slip reads its matches' own scores at submission and again at the
 *   end of its wait (checkNow), so a click in the gap between two reads is
 *   refused even before the board has paused.
 *
 * A failed read changes nothing: our own feed's goal pauses and the late
 * check stand without it. EARLY_GOALS=off turns it off; SPORTSCORE_API_KEY
 * raises the rate limit; EARLY_GOAL_INTERVAL_MS and EARLY_GOAL_DAILY_BUDGET
 * set the pace.
 */
@Injectable()
export class EarlyGoalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EarlyGoalService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private failures = 0;
  private readonly fetcher: typeof fetch;
  private readonly apiKey = process.env.SPORTSCORE_API_KEY?.trim() || null;
  private readonly everyMs = Number(process.env.EARLY_GOAL_INTERVAL_MS) || (this.apiKey ? KEYED_MS : ANONYMOUS_MS);
  /** Requests a UTC day; none without a key means the anonymous default, a key means no daily cap of ours. */
  private readonly dailyBudget = Number(process.env.EARLY_GOAL_DAILY_BUDGET) || (this.apiKey ? Infinity : ANONYMOUS_DAILY_BUDGET);
  private day = "";
  /** Requests made today (UTC), all kinds together and by kind. */
  private used = 0;
  private readonly usedBy = { list: 0, pages: 0, slip: 0 };
  private pagesAt = 0;
  private pacedAt = 0;
  /** When each linked match was last read from its own page. */
  private readonly detailAt = new Map<string, number>();
  private warnedAt = 0;
  /** Each match's last check for a slip: when, and the promise slips on it share. */
  private readonly checks = new Map<string, { at: number; done: Promise<SportScoreScore | null> }>();
  readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: OddsSyncService,
    @Optional() @Inject(EARLY_GOAL_FETCH) fetcher?: typeof fetch,
  ) {
    this.fetcher = fetcher ?? fetch;
    this.enabled = process.env.EARLY_GOALS !== "off";
  }

  onModuleInit() {
    if (process.env.NODE_ENV === "test" || !this.enabled || this.sync.mode === "off") return;
    this.logger.log(
      `Early goal signals from SportScore: every ${this.everyMs / 1000} s while a linked football match is live${Number.isFinite(this.dailyBudget) ? `, up to ${this.dailyBudget} requests a day` : ""}, and on each live slip`,
    );
    this.schedule(IDLE_MS);
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * Requests of this kind left today (UTC), counting `cost` more as used
   * when given. The live list and the match pages keep to their shares; a
   * slip's check may use whatever is left of the day.
   */
  private budget(kind: "list" | "pages" | "slip" = "slip", cost = 0): number {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
      this.usedBy.list = this.usedBy.pages = this.usedBy.slip = 0;
    }
    this.used += cost;
    this.usedBy[kind] += cost;
    const total = this.dailyBudget - this.used;
    if (kind === "slip") return total;
    return Math.min(total, this.dailyBudget * (kind === "list" ? LIST_SHARE : PAGES_SHARE) - this.usedBy[kind]);
  }

  /** The wait before the next read of the live list: the interval, spread out so its share of the day lasts. */
  private nextDelay(): number {
    const left = this.budget("list");
    if (!Number.isFinite(left)) return this.everyMs;
    if (left <= 0) return IDLE_MS;
    const msLeft = 86_400_000 - (Date.now() % 86_400_000);
    const delay = Math.max(this.everyMs, Math.ceil(msLeft / left));
    if (Date.now() - this.pacedAt >= PACE_LOG_MS) {
      this.pacedAt = Date.now();
      this.logger.log(
        `SportScore pace: the live list every ${(delay / 1000).toFixed(1)} s; today ${this.usedBy.list} list, ${this.usedBy.pages} match-page and ${this.usedBy.slip} slip reads of ${this.dailyBudget}${this.apiKey ? "" : " (no SPORTSCORE_API_KEY: a key allows a read every 2 s)"}`,
      );
    }
    return delay;
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  private async tick() {
    let next = IDLE_MS;
    try {
      const linked = await this.run();
      this.failures = 0;
      if (linked > 0) next = this.nextDelay();
    } catch (error) {
      this.failures += 1;
      next = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (this.failures - 1));
      if (this.failures <= 3 || this.failures % 20 === 0) this.logger.warn(`SportScore scores not read (${this.failures} in a row): ${error instanceof Error ? error.message : String(error)}`);
    }
    this.schedule(next);
  }

  /** Our live football matches linked to SportScore (the tracker's mapping), optionally only these. */
  private linked(eventIds?: string[]) {
    return this.prisma.event.findMany({
      where: { sport: "football", status: EventStatus.LIVE, trackerMapping: { externalId: { not: null } }, ...(eventIds ? { id: { in: eventIds } } : {}) },
      select: { id: true, homeScore: true, awayScore: true, trackerMapping: { select: { externalId: true } } },
    });
  }

  /**
   * One timed read: the day's live list and, for each linked live match, its
   * score there handed to sourceScore. Linked live matches the list doesn't
   * have (it has come back empty while matches were live) are read from
   * their own match page instead. Returns how many linked matches are live
   * (0: nothing was fetched).
   */
  async run(now: Date = new Date(), scores?: SportScoreScore[]): Promise<number> {
    await this.sync.settleEarlyScores(now);
    const live = await this.linked();
    if (live.length === 0) return 0;
    let read = scores;
    let listError: unknown = null;
    if (!read) {
      if (this.budget("list") <= 0) return live.length;
      this.budget("list", 1);
      try {
        read = await fetchLiveScores(now.toISOString().slice(0, 10), this.fetcher, this.apiKey, true);
      } catch (error) {
        listError = error;
        read = [];
      }
    }
    const bySlug = new Map(read.map((row) => [row.id, row]));
    for (const event of live) {
      const there = bySlug.get(event.trackerMapping!.externalId!);
      if (there) await this.apply(event.id, there, now);
    }
    if (scores) return live.length;
    const missing = live.filter((event) => !bySlug.has(event.trackerMapping!.externalId!));
    // Match pages at their own pace (every 30 s without a key), never slowing the list's reads; at once when the list failed or came back empty.
    const listDown = Boolean(listError) || read.length === 0;
    if (missing.length === 0 || (!listDown && Date.now() - this.pagesAt < (this.apiKey ? DETAILS_EVERY_KEYED_MS : DETAILS_EVERY_ANONYMOUS_MS))) return live.length;
    this.pagesAt = Date.now();
    if (Date.now() - this.warnedAt >= WARN_EVERY_MS) {
      this.warnedAt = Date.now();
      this.logger.warn(
        `SportScore's live list ${listError ? `failed (${listError instanceof Error ? listError.message : String(listError)})` : read.length === 0 ? "is empty" : `has ${read.length} matches`} while ${missing.length} of ${live.length} linked live matches aren't in it: reading their match pages`,
      );
    }
    const batch: typeof missing = [];
    for (const event of missing.sort((a, b) => (this.detailAt.get(a.id) ?? 0) - (this.detailAt.get(b.id) ?? 0))) {
      if (batch.length >= (this.apiKey ? DETAILS_PER_READ_KEYED : DETAILS_PER_READ_ANONYMOUS) || this.budget("pages") <= 0) break;
      this.budget("pages", 1);
      batch.push(event);
    }
    let readOne = false;
    await Promise.all(
      batch.map(async (event) => {
        this.detailAt.set(event.id, Date.now());
        const score = await fetchMatchScore(event.trackerMapping!.externalId!, this.fetcher, this.apiKey, true, CHECK_TIMEOUT_MS * 2).catch((error) => {
          this.logger.warn(`SportScore match page for event ${event.id} not read: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        if (!score) return;
        readOne = true;
        await this.apply(event.id, score, now);
      }),
    );
    if (this.detailAt.size > 500) for (const [id, at] of this.detailAt) if (Date.now() - at > 3_600_000) this.detailAt.delete(id);
    // Nothing read at all: a failure, so the next try backs off.
    if (listError && !readOne) throw listError;
    return live.length;
  }

  private apply(eventId: string, score: SportScoreScore, now: Date) {
    return this.sync.sourceScore(eventId, { home: score.home, away: score.away }, "sportscore", now).catch((error) => {
      this.logger.warn(`SportScore score on event ${eventId} not applied: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
  }

  /**
   * For a live slip: these matches' own scores straight from SportScore (each
   * read shared by slips within CHECK_SHARE_MS), applied like a timed read.
   * Returns the matches whose score there differs from ours: the slip is
   * refused on them. Gives up after CHECK_TIMEOUT_MS, or with the day's
   * budget spent, and returns what it has (a failed read refuses nothing).
   * `shareMs`: how old a read other slips started may be to be used; 0 for a
   * read of its own (the end of a slip's wait must not reuse the one from
   * when it came in).
   */
  async checkNow(eventIds: string[], now: Date = new Date(), shareMs = CHECK_SHARE_MS): Promise<Array<{ eventId: string; score: string }>> {
    if (!this.enabled || eventIds.length === 0) return [];
    const live = await this.linked(eventIds);
    const differing: Array<{ eventId: string; score: string }> = [];
    await Promise.all(
      live.map(async (event) => {
        const slug = event.trackerMapping!.externalId!;
        const shared = this.checks.get(slug);
        let done = shared && Date.now() - shared.at < shareMs ? shared.done : null;
        if (!done) {
          if (this.budget("slip") <= 0) {
            this.logger.warn(`SportScore check for event ${event.id} skipped: today's ${this.dailyBudget} requests are used (the late check still voids a bet placed after a goal)`);
            return;
          }
          this.budget("slip", 1);
          done = fetchMatchScore(slug, this.fetcher, this.apiKey, true, CHECK_TIMEOUT_MS).catch((error) => {
            this.logger.warn(`SportScore check for event ${event.id} failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          });
          this.checks.set(slug, { at: Date.now(), done });
          if (this.checks.size > 200) for (const [key, check] of this.checks) if (Date.now() - check.at > 60_000) this.checks.delete(key);
        }
        const score = await done;
        if (!score) return;
        await this.apply(event.id, score, now);
        if (score.home + score.away !== (event.homeScore ?? 0) + (event.awayScore ?? 0)) differing.push({ eventId: event.id, score: `${score.home}:${score.away}` });
      }),
    );
    return differing;
  }
}
