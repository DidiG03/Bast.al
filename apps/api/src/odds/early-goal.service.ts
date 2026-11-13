import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { EventStatus } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { fetchLiveScores, type SportScoreScore } from "./sportscore-scores";
import { OddsSyncService } from "./odds-sync.service";

/** Lets tests hand in their own fetch. */
export const EARLY_GOAL_FETCH = "EARLY_GOAL_FETCH";

/**
 * How often SportScore's live scores are read while one of our live football
 * matches is linked to it: every 4 s with a SportScore key (6,000 requests a
 * minute), every 10 s without one (their anonymous tier allows about 10,000 a
 * day per IP, and this only runs while matches are live).
 */
const KEYED_MS = 4_000;
const ANONYMOUS_MS = 10_000;
/** While nothing linked is live, the next look is this far off. */
const IDLE_MS = 30_000;
/** After a failed read, the next one waits this long, doubling up to the cap. */
const BACKOFF_MS = 15_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Early goal signals. SportScore usually shows a goal some seconds before
 * API-Football, our odds feed. This reads SportScore's live scores (one
 * request for every live match) and, for each of our live football matches
 * linked to a SportScore match (the tracker's mapping), hands a score ahead
 * of our board to OddsSyncService.earlyGoal: every market of the match pauses
 * at once, server-side, and live slips on it are refused until our feed
 * catches up. The late check then counts the goal from when SportScore showed
 * it (EarlyGoal), so a bet placed after the real goal is voided, never paid.
 *
 * A failed read changes nothing: our own feed's goal pauses and the late
 * check stand without it. EARLY_GOALS=off turns it off; SPORTSCORE_API_KEY
 * raises the rate limit; EARLY_GOAL_INTERVAL_MS sets the pace.
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: OddsSyncService,
    @Optional() @Inject(EARLY_GOAL_FETCH) fetcher?: typeof fetch,
  ) {
    this.fetcher = fetcher ?? fetch;
  }

  onModuleInit() {
    if (process.env.NODE_ENV === "test" || process.env.EARLY_GOALS === "off" || this.sync.mode === "off") return;
    this.logger.log(`Early goal signals from SportScore: every ${this.everyMs / 1000} s while a linked football match is live`);
    this.schedule(IDLE_MS);
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
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
      if (linked > 0) next = this.everyMs;
    } catch (error) {
      this.failures += 1;
      next = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (this.failures - 1));
      if (this.failures <= 3 || this.failures % 20 === 0) this.logger.warn(`SportScore scores not read (${this.failures} in a row): ${error instanceof Error ? error.message : String(error)}`);
    }
    this.schedule(next);
  }

  /**
   * One read: our live football matches linked to SportScore, their scores
   * there, and an early goal for each one ahead of our board. Returns how
   * many linked matches are live (0: nothing was fetched).
   */
  async run(now: Date = new Date(), scores?: SportScoreScore[]): Promise<number> {
    await this.sync.settleEarlyScores(now);
    const live = await this.prisma.event.findMany({
      where: { sport: "football", status: EventStatus.LIVE, trackerMapping: { externalId: { not: null } } },
      select: { id: true, homeScore: true, awayScore: true, trackerMapping: { select: { externalId: true } } },
    });
    if (live.length === 0) return 0;
    const day = now.toISOString().slice(0, 10);
    const read = scores ?? (await fetchLiveScores(day, this.fetcher, this.apiKey));
    const bySlug = new Map(read.map((row) => [row.id, row]));
    for (const event of live) {
      const there = bySlug.get(event.trackerMapping!.externalId!);
      if (!there) continue;
      if (there.home + there.away <= (event.homeScore ?? 0) + (event.awayScore ?? 0)) continue;
      await this.sync.earlyGoal(event.id, { home: there.home, away: there.away }, "sportscore", now).catch((error) =>
        this.logger.warn(`Early goal on event ${event.id} not applied: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    return live.length;
  }
}
