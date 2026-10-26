import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { BetStatus, EventStatus, Prisma } from "@prisma/client";
import Redis from "ioredis";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { GOAL_MARKET_KEYS } from "../bets/goals";
import type { FeedMark, LateTimeline } from "../bets/late";
import { ApiFootballClient, FeedFixture, FeedLeague, FeedLiveMarket, FeedLiveOdds, FeedMarket, feedMarkOf, httpFetchJson, parseGoalRecord, parseLateTimeline, parseLiveOdds, parseLiveTimeline, parseMarkets, parseMatchCentre } from "./api-football";
import { feedDelay, goalForScore, goalLag } from "./feed-delay";
import { savedCrests, savedMarks } from "./crest";
import { PREMATCH_REFRESH_MS, RICH_PLAN, isDailyLimitError, msUntilReset, pacedInterval, quotaReserve } from "./feed-budget";
import { EVENT_PAUSES, GOAL_COOLDOWN_MS, LIVE_CUTOFF_MINUTE, type CooldownReason, type MarketPause, type MarketPauseReason, bigSwing, cooldownFor, eventPause, freshBlocker, freshUntil, hitBy, laterCooldown, mergePause, scoreChanged } from "./live-guard";
import { marketStale } from "./pricing";
import { mockFetchJson } from "./mock-feed";
import { LIVE_HOT_MS, PollingStats, hotMatches, minuteRoom } from "./live-polling";

/**
 * Leagues synced when API_FOOTBALL_LEAGUES isn't set (API-Football ids), picked
 * so there's football every day of the year, international breaks included.
 * Every league from the countries in API_FOOTBALL_COUNTRIES (Albania and
 * Kosovo by default) is synced as well. The first sync logs any id the feed
 * doesn't know.
 */
const DEFAULT_LEAGUES = [
  // England, Spain, Italy, Germany, France: top two divisions and main cup
  39, 40, 45, 48, 140, 141, 143, 135, 136, 137, 78, 79, 81, 61, 62, 66,
  // England's League One and Two, Germany's 3. Liga, and the second divisions of the Netherlands, Portugal, Turkey, Scotland and Belgium
  41, 42, 80, 89, 95, 204, 180, 145,
  // The rest of Europe's top divisions
  88, 94, 203, 144, 179, 197, 207, 218, 119, 113, 103, 106, 210, 286, 283, 345, 333,
  // Near Albania and Kosovo: North Macedonia, Montenegro, Bosnia, Slovenia, Bulgaria, Hungary, Cyprus, Israel, Slovakia
  371, 355, 315, 373, 172, 271, 318, 383, 332,
  // Women: Champions League, England, Germany, France
  525, 44, 82, 64,
  // UEFA club competitions
  2, 3, 848, 531,
  // National teams: tournaments, qualifiers and friendlies
  1, 4, 5, 6, 9, 10, 32, 34, 29, 30, 31, 960,
  // Americas
  253, 71, 72, 128, 262, 239, 265, 13, 11,
  // Africa, Asia and Oceania
  233, 200, 307, 98, 292, 169, 188, 17,
];
const DEFAULT_COUNTRIES = ["Albania", "Kosovo"];

/** API-Football's id for Bet365, the bookmaker whose prices we start from. */
const DEFAULT_BOOKMAKER = 8;

export type FeedMode = "api-football" | "mock" | "off";

type SyncSummary = { events: number; markets: number; live: number };

/** Which competitions are synced: league ids, plus countries whose every league is. */
export type CompetitionChoice = { leagues: number[]; countries: string[] };

const LOCK_KEY = "bastal:odds-sync";
/** Live prices and live scores have locks of their own, so a long pre-match sync never holds them up. */
const LIVE_LOCK_KEY = "bastal:odds-sync:live";
const SCORES_LOCK_KEY = "bastal:odds-sync:scores";
/** The priority lane (live-polling.ts) has its own, so it never waits for the whole board's reading. */
const HOT_LOCK_KEY = "bastal:odds-sync:hot";
/** How often the polling is summed up in the log (each live match: how often it was read, how old its prices were). */
const POLLING_LOG_MS = 5 * 60_000;
/**
 * In-play prices for every live match (one request): every 5 seconds while
 * someone is on the site or looked at live matches lately, every 20 when
 * nobody is. The feed updates them about that often. Paced by the day's
 * budget (feed-budget.ts).
 */
const LIVE_ODDS_WATCHED_MS = Number(process.env.LIVE_ODDS_INTERVAL_MS) || 5_000;
const LIVE_ODDS_IDLE_MS = 20_000;
/** Live scores, minutes and finished matches: every 15 seconds, how often the feed updates them. */
const LIVE_SCORES_MS = Number(process.env.ODDS_LIVE_INTERVAL_MS) || 15_000;
/** Match centres of matches with bets or someone watching: every 30 seconds, up to 3 requests a run. */
const MATCH_CENTRE_EVERY_MS = 30_000;
/**
 * The part of what's left today each live task may use. Scores (results,
 * settlement) may use what's kept in reserve; prices and match centres stop
 * at the reserve.
 */
const SHARE = { odds: 0.45, scores: 0.25, centres: 0.15, hot: 0.1 };
/** While nothing can be afforded or the day's requests are used up, the loops look again this often. */
const BUDGET_RECHECK_MS = 60_000;
/** After the feed says the day's requests are used up, nothing is asked for this long; then one request checks. */
const LIMIT_PAUSE_MS = 10 * 60_000;
const LIVE_INTEREST_MS = 2 * 60_000;
/** How long after a match ends its match centre is fetched once more, for the final numbers. */
const MATCH_CENTRE_AFTER_MS = 15 * 60_000;
/** Matches whose match centre is fetched on one run: 3 requests' worth. */
const MATCH_CENTRE_MAX = 60;
/** A match someone opened the stats of stays on the live sync's list this long after they last looked. */
const MATCH_CENTRE_INTEREST_MS = 2 * 60_000;
/** Before kick-off, the match centre (the team sheets) is fetched from this long before, at most every 10 minutes. */
const LINEUPS_BEFORE_MS = 90 * 60_000;
const LINEUPS_EVERY_MS = 10 * 60_000;
/** A market's last priced reading is written at most this often (Market.liveQuotedAt). */
const QUOTED_EVERY_MS = 30_000;
/** Live matches saved at the same time on each reading; each takes one database connection. */
const LIVE_WRITERS = 6;
/** A match's score comes from the live odds while they're this fresh; the fixtures list lags behind them. */
const LIVE_SCORE_SOURCE_MS = 60_000;
/**
 * A live match whose goal certainly reached the site later than this after it
 * went in (GoalSeen.lagMinMs) takes no more live bets: no wait a Player
 * would sit through covers that feed. LIVE_SLOW_MATCH_MS=0 turns it off.
 */
const LIVE_SLOW_MATCH_MS = process.env.LIVE_SLOW_MATCH_MS === "0" ? Infinity : Number(process.env.LIVE_SLOW_MATCH_MS) || 30_000;
/** Bets placed on the same match within this long share one check with the feed. */
const VERIFY_SHARE_MS = 2_000;
/** Markets settled from match statistics rather than the score. */
const STATS_MARKET_PREFIXES = ["corners_", "home_corners_", "away_corners_", "cards_", "home_cards_", "away_cards_"];
/**
 * A match not played within this long of its kick-off (postponed, abandoned
 * without word from the feed, or moved to a later date) has its open bets
 * refunded; see SettlementService.
 */
export const UNPLAYED_VOID_MS = (Number(process.env.UNPLAYED_VOID_HOURS) || 48) * 3_600_000;

/** A match moved more than UNPLAYED_VOID_MS later: bets placed for the old date are refunded (see SettlementService.refundUnplayed). */
export const movedLater = (before: Date | null | undefined, after: Date) => !!before && after.getTime() - before.getTime() > UNPLAYED_VOID_MS;
/** Finished matches with bets are asked about again for this long after kick-off, in case the feed corrects the score. */
const RESULT_RECHECK_MS = 48 * 3_600_000;
/** How often each of those is asked about. */
const RESULT_RECHECK_EVERY_MS = 60 * 60_000;

/**
 * Keeps events, markets and feed prices up to date:
 * - every ODDS_SYNC_INTERVAL_MS (10 minutes by default) it checks which days
 *   are due (see PREMATCH_REFRESH_MS) and fetches their fixtures and pre-match
 *   odds, for today and the next ODDS_SYNC_DAYS - 1 days;
 * - every LIVE_SCORES_MS (15 seconds) while matches are live or should have
 *   kicked off: their scores (one request), and every MATCH_CENTRE_EVERY_MS
 *   the match centres of those with bets or someone watching;
 * - every LIVE_ODDS_WATCHED_MS (5 seconds) while anyone is around, otherwise
 *   every LIVE_ODDS_IDLE_MS: in-play prices for every live match (one request);
 * - on every live bet: that match's odds straight from the feed (verifyLive).
 * The live tasks are spaced out when the day's requests wouldn't last at
 * their speed (feed-budget.ts). Redis locks make sure only one API instance
 * syncs at a time; pre-match, live prices and live scores lock separately.
 */
@Injectable()
export class OddsSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OddsSyncService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  /** Stops each repeating live loop (see loop). */
  private readonly loopStops: Array<() => void> = [];
  private redis?: Redis;
  private stopped = false;
  /** Syncs running on this instance, by lock key. */
  private readonly runningLocks = new Set<string>();
  /** When a Player or admin last looked at live matches. */
  private liveInterestAt = 0;
  /** When in-play prices were last fetched for the whole live board. */
  private lastLiveOddsAt = 0;
  /** When match centres were last fetched on the live loop. */
  private lastCentresAt = 0;
  /** Until when nothing is asked of the feed: it said the day's requests are used up. */
  private limitPausedUntil = 0;
  /** Starts the live price loop early (someone just opened live matches after a quiet spell). */
  private wakeOdds?: () => void;
  /**
   * Called with the matches whose live prices were just saved, after they're
   * committed. OddsService sends each team its new prices from here; when
   * nothing is listening, every open page is told to fetch them.
   */
  onLiveSaved?: (eventIds: string[]) => Promise<void>;
  /** Called when matches just finished, once their stats and goals are in: SettlementService pays their bets now, not at its next round. */
  onFinished?: () => Promise<unknown>;
  /**
   * Called as soon as the site sees a new goal on a live match, with the
   * feed's timeline so far if it could be fetched: SettlementService voids
   * the open live bets placed after it on a score without it (bets/late.ts).
   */
  onGoalSeen?: (eventId: string, timeline: LateTimeline | null) => Promise<unknown>;
  /** Called with finished matches whose timeline just came in: SettlementService looks again at their live bets that already settled. */
  onTimeline?: (eventIds: string[]) => Promise<unknown>;
  /** Checks with the feed for one match, shared by bets placed at the same moment. */
  private readonly verifying = new Map<string, { at: number; done: Promise<void> }>();
  /** Each live match's latest price reading: when it came, the bookmaker's own update time and the match clock (for a live bet's record). */
  private readonly readings = new Map<string, { at: Date; bookmakerUpdate: string | null; clock: string | null }>();
  /** The same for reading live matches' timelines straight from the feed (readMarks). */
  private readonly verifyingCards = new Map<string, { at: number; done: Promise<Map<string, FeedMark>> }>();
  readonly mode: FeedMode;
  private readonly client?: ApiFootballClient;
  private readonly bookmakerId: number;
  /** From API_FOOTBALL_LEAGUES / API_FOOTBALL_COUNTRIES, or the built-in lists; used until Super Admin picks. */
  readonly defaults: CompetitionChoice;
  /** What the running sync uses: Super Admin's pick, or the defaults. Reloaded at the start of every full sync. */
  private leagues = new Set<number>();
  private countries = new Set<string>();
  private custom = false;
  private leagueList: { at: number; leagues: FeedLeague[] } | null = null;
  private readonly days: number;
  /** Requests left on today's API-Football quota, and the plan's daily total, from its last answer. */
  private quotaLeft: number | null = null;
  private quotaLimit: number | null = null;
  /** The same for the plan's limit a minute. */
  private minuteLeft: number | null = null;
  private minuteLimit: number | null = null;
  /** How often each live match's prices were read, and how far behind the bookmaker (live-polling.ts). */
  readonly polling = new PollingStats();
  /** Requests the priority lane made on its last run, and when the polling was last logged. */
  private lastHotCount = 0;
  private lastPollingLog = Date.now();
  /** Matches whose stats someone has open, and when they last asked. */
  private readonly centreInterest = new Map<string, number>();
  /** Match centres being fetched for someone right now, so viewers who ask together share one request. */
  private readonly centreFetches = new Map<string, Promise<boolean>>();
  private leaguesChecked = false;
  /** When each day was last refreshed, if Redis is down. */
  private readonly refreshedAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {
    const key = process.env.API_FOOTBALL_KEY?.trim();
    if (key) {
      this.mode = "api-football";
      this.client = new ApiFootballClient(httpFetchJson(process.env.API_FOOTBALL_HOST?.trim() || "v3.football.api-sports.io", key, (left, limit, minute) => {
        this.quotaLeft = left;
        const planChanged = (limit !== null && limit !== this.quotaLimit) || (minute !== undefined && minute.limit !== null && minute.limit !== this.minuteLimit);
        if (limit !== null) this.quotaLimit = limit;
        if (minute) {
          this.minuteLeft = minute.left;
          if (minute.limit !== null) this.minuteLimit = minute.limit;
        }
        if (planChanged) this.logger.log(`API-Football plan: ${this.quotaLimit ?? "unknown"} requests a day, ${this.minuteLimit ?? "unknown"} a minute`);
      }));
    } else if (process.env.ODDS_FEED_MOCK === "true") {
      this.mode = "mock";
      this.client = new ApiFootballClient(mockFetchJson());
    } else {
      this.mode = "off";
    }
    this.bookmakerId = Number(process.env.API_FOOTBALL_BOOKMAKER) || DEFAULT_BOOKMAKER;
    this.defaults = {
      leagues: listEnv("API_FOOTBALL_LEAGUES")?.map(Number).filter(Number.isInteger) ?? DEFAULT_LEAGUES,
      countries: listEnv("API_FOOTBALL_COUNTRIES") ?? DEFAULT_COUNTRIES,
    };
    this.useChoice(this.defaults, false);
    this.days = Math.min(7, Math.max(1, Number(process.env.ODDS_SYNC_DAYS) || 7));
  }

  onModuleInit() {
    if (this.mode === "off") {
      this.logger.log("Odds feed is off: set API_FOOTBALL_KEY (or ODDS_FEED_MOCK=true for local testing)");
      return;
    }
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    this.redis.on("error", () => undefined);
    this.redis.connect().catch(() => undefined);
    const fullEvery = Number(process.env.ODDS_SYNC_INTERVAL_MS) || 10 * 60_000;
    // First full sync shortly after boot, then on the interval.
    this.timers.push(setTimeout(() => void this.scheduled("full"), 5_000));
    this.timers.push(setInterval(() => void this.scheduled("full"), fullEvery));
    this.loop("live scores", 8_000, () => this.liveScoresRun(), () => this.liveScoresDelay());
    this.loop("live odds", 10_000, () => this.liveOddsRun(), () => this.liveOddsDelay(), (wake) => (this.wakeOdds = wake));
    this.loop("live odds priority", 12_000, () => this.liveHotRun(), () => this.liveHotDelay());
  }

  /**
   * Someone is looking at live matches: their prices are fetched every
   * LIVE_ODDS_WATCHED_MS for a while, starting now if the last fetch was
   * from the slower pace.
   */
  noteLiveInterest() {
    const quiet = !this.watched(Date.now());
    this.liveInterestAt = Date.now();
    if (quiet && Date.now() - this.lastLiveOddsAt > LIVE_ODDS_WATCHED_MS) this.wakeOdds?.();
  }

  /** Someone has the site open (a live stream) or looked at live matches lately. */
  private watched(now: number): boolean {
    return now - this.liveInterestAt <= LIVE_INTEREST_MS || (this.realtime?.listenerCount() ?? 0) > 0;
  }

  /**
   * Runs `run` again and again, waiting `delay()` after each run ends (so a
   * slow run never overlaps the next), first after `firstMs`. `onWake` gets
   * a function that starts the next run now.
   */
  private loop(name: string, firstMs: number, run: () => Promise<void>, delay: () => number, onWake?: (wake: () => void) => void) {
    let timer: NodeJS.Timeout | undefined;
    let busy = false;
    const tick = async () => {
      timer = undefined;
      busy = true;
      try {
        if (Date.now() >= this.limitPausedUntil) await run();
      } catch (error) {
        this.feedFailed(`Odds ${name} sync failed`, error);
      } finally {
        busy = false;
      }
      if (this.stopped) return;
      const wait = Date.now() < this.limitPausedUntil ? Math.min(BUDGET_RECHECK_MS, this.limitPausedUntil - Date.now()) : delay();
      timer = setTimeout(() => void tick(), Number.isFinite(wait) ? wait : BUDGET_RECHECK_MS);
    };
    timer = setTimeout(() => void tick(), firstMs);
    this.loopStops.push(() => clearTimeout(timer));
    onWake?.(() => {
      if (busy || !timer || this.stopped) return;
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), 0);
    });
  }

  /** Logs a failed feed call; if the day's requests are used up, stops asking for LIMIT_PAUSE_MS. */
  private feedFailed(what: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (isDailyLimitError(error)) {
      const first = Date.now() >= this.limitPausedUntil;
      this.quotaLeft = 0;
      this.limitPausedUntil = Date.now() + LIMIT_PAUSE_MS;
      if (first) this.logger.warn(`API-Football's requests for today are used up; asking again in ${LIMIT_PAUSE_MS / 60_000} minutes`);
      return;
    }
    this.logger.warn(`${what}: ${message}`);
  }

  /** Requests left above the reserve kept for scores and results. */
  private spare(): number | null {
    return this.quotaLeft === null ? null : this.quotaLeft - quotaReserve(this.quotaLimit);
  }

  private liveOddsDelay(): number {
    const want = this.watched(Date.now()) ? LIVE_ODDS_WATCHED_MS : LIVE_ODDS_IDLE_MS;
    return pacedInterval({ wantMs: want, perRun: 1, share: SHARE.odds, left: this.spare(), msLeft: msUntilReset(Date.now()) });
  }

  /** The priority lane wants LIVE_HOT_MS; its share of the day paces it by the requests it actually made last time. */
  private liveHotDelay(): number {
    return pacedInterval({ wantMs: LIVE_HOT_MS, perRun: Math.max(1, this.lastHotCount), share: SHARE.hot, left: this.spare(), msLeft: msUntilReset(Date.now()) });
  }

  private liveScoresDelay(): number {
    return pacedInterval({ wantMs: LIVE_SCORES_MS, perRun: 1, share: SHARE.scores, left: this.quotaLeft, msLeft: msUntilReset(Date.now()) });
  }

  private centresDelay(): number {
    return pacedInterval({ wantMs: MATCH_CENTRE_EVERY_MS, perRun: 3, share: SHARE.centres, left: this.spare(), msLeft: msUntilReset(Date.now()) });
  }

  /** In-play prices for every live match. */
  private async liveOddsRun() {
    await this.withLock(() => this.syncLiveOdds(), LIVE_LOCK_KEY);
  }

  /** The matches that matter most, read on their own when the board hasn't been read for them lately (live-polling.ts). */
  private async liveHotRun() {
    this.lastHotCount = (await this.withLock(() => this.syncHotOdds(), HOT_LOCK_KEY)) ?? 0;
    if (Date.now() - this.lastPollingLog >= POLLING_LOG_MS) await this.logPolling().catch(() => undefined);
  }

  /**
   * Reads on their own (one request each) the live matches waiting for fresh
   * prices to reopen paused markets and those with the most riding on them in
   * open bets, when the board hasn't been read for them within LIVE_HOT_MS
   * (hotMatches), while this minute's requests have room. Returns how many
   * requests it made.
   */
  private async syncHotOdds(): Promise<number> {
    if (!this.client || this.mode === "off") return 0;
    const now = new Date();
    const live = await this.prisma.event.findMany({
      where: { provider: this.provider(), externalId: { not: null }, status: EventStatus.LIVE },
      select: { id: true, externalId: true, homeTeam: true, awayTeam: true, name: true },
    });
    if (live.length === 0) return 0;
    const ids = live.map((event) => event.id);
    const [exposures, waiting] = await Promise.all([this.liveExposure(ids), this.prisma.market.groupBy({ by: ["eventId"], where: { eventId: { in: ids }, livePausedUntil: { gt: now } } })]);
    const waitingIds = new Set(waiting.map((row) => row.eventId));
    const picked = hotMatches(
      live.map((event) => ({ eventId: event.id, exposure: exposures.get(event.id) ?? 0, waiting: waitingIds.has(event.id), lastRead: this.polling.lastRead(event.id) })),
      now.getTime(),
    );
    if (picked.length === 0 || !minuteRoom(this.minuteLeft, this.minuteLimit, picked.length)) return 0;
    const byId = new Map(live.map((event) => [event.id, event]));
    const read: string[] = [];
    for (const { eventId } of picked) {
      const event = byId.get(eventId)!;
      const raw = await this.client.liveOddsFor(event.externalId!);
      // Not priced by the feed right now: the board's reading decides what that means.
      if (!raw) continue;
      await this.applyLiveOdds(event.id, parseLiveOdds(raw, event.homeTeam ?? event.name, event.awayTeam ?? "")).catch((error) =>
        this.logger.warn(`Live odds for event ${event.id} not saved: ${error instanceof Error ? error.message : String(error)}`),
      );
      read.push(event.id);
    }
    if (read.length > 0) await this.announceLive(read);
    return picked.length;
  }

  /** What open bets on each of these matches would pay out (stake times price), singles and combined legs alike. */
  private async liveExposure(eventIds: string[]): Promise<Map<string, number>> {
    if (eventIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ event_id: string; exposure: number }>>`
      SELECT event_id, SUM(exposure)::float AS exposure FROM (
        SELECT m.event_id, b.stake * COALESCE(b.odds, 1) AS exposure
        FROM bets b JOIN selections s ON s.id = b.selection_id JOIN markets m ON m.id = s.market_id
        WHERE b.status = 'OPEN' AND m.event_id = ANY(${eventIds}::text[])
        UNION ALL
        SELECT m.event_id, b.stake * COALESCE(b.odds, 1) AS exposure
        FROM bet_legs l JOIN bets b ON b.id = l.bet_id JOIN selections s ON s.id = l.selection_id JOIN markets m ON m.id = s.market_id
        WHERE b.status = 'OPEN' AND m.event_id = ANY(${eventIds}::text[])
      ) AS open_bets GROUP BY event_id`;
    return new Map(rows.map((row) => [row.event_id, Number(row.exposure)]));
  }

  /** Sums up the last POLLING_LOG_MS of live polling in the log: each match's reading interval and how far behind the bookmaker it was. */
  private async logPolling() {
    this.lastPollingLog = Date.now();
    const { since, matches } = this.polling.take();
    if (matches.length === 0) return;
    const names = new Map((await this.prisma.event.findMany({ where: { id: { in: matches.map((m) => m.eventId) } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
    const seconds = (ms: number | null) => (ms === null ? "unknown" : `${(ms / 1000).toFixed(1)} s`);
    const plan = `plan ${this.quotaLimit ?? "unknown"} a day / ${this.minuteLimit ?? "unknown"} a minute, ${this.quotaLeft ?? "unknown"} left today`;
    this.logger.log(`Live polling over the last ${Math.round((Date.now() - since) / 60_000)} min (board every ${seconds(this.liveOddsDelay())}, priority lane every ${seconds(this.liveHotDelay())}, ${plan}):`);
    for (const match of matches.sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0))) {
      this.logger.log(`  ${names.get(match.eventId) ?? match.eventId}: read every ${seconds(match.everyMs)} (${match.reads} readings), prices ${seconds(match.ageMs)} behind the bookmaker on average, ${seconds(match.ageMaxMs)} at most`);
    }
  }

  /** The feed plan and how the live polling is going, for the live health page. */
  pollingHealth() {
    const current = this.polling.current();
    return {
      mode: this.mode,
      plan: { perDay: this.quotaLimit, leftToday: this.quotaLeft, perMinute: this.minuteLimit, leftThisMinute: this.minuteLeft },
      intervals: { boardMs: finiteOr(this.liveOddsDelay()), priorityMs: finiteOr(this.liveHotDelay()), scoresMs: finiteOr(this.liveScoresDelay()) },
      matches: current.length > 0 ? current : this.polling.last(),
    };
  }

  /**
   * Scores and the minute for matches that are live or should have kicked
   * off; when due, the match centres; and when a match just finished, its
   * corners, cards and goals for settlement.
   */
  private async liveScoresRun() {
    // Scores first, under the lock; match centres and settlement checks after it's free.
    const finished = await this.withLock(() => this.syncLive(), SCORES_LOCK_KEY);
    if (finished === null) return;
    if (Date.now() - this.lastCentresAt >= this.centresDelay()) {
      this.lastCentresAt = Date.now();
      await this.syncMatchCentres().catch((error) => this.feedFailed("Match centres not updated", error));
    }
    if (finished > 0) {
      await this.syncStats();
      await this.syncGoals();
      await this.syncLateChecks().catch((error) => this.logger.warn(`Timelines for the late-bet check not fetched: ${error instanceof Error ? error.message : String(error)}`));
      await this.onFinished?.().catch((error) => this.logger.warn(`Settling just-finished matches failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Checks the given live matches with the feed right now (one request each)
   * and saves what it says, so a live bet is confirmed against the
   * bookmaker's current prices, score and blocked flag rather than our last
   * copy. A match the feed isn't pricing any more is marked stopped. Throws if
   * the feed can't be reached; the bet is refused then.
   */
  async verifyLive(eventIds: string[]): Promise<void> {
    if (!this.client || eventIds.length === 0) return;
    const events = await this.prisma.event.findMany({
      where: { id: { in: [...new Set(eventIds)] }, status: EventStatus.LIVE, externalId: { not: null } },
      select: { id: true, externalId: true, homeTeam: true, awayTeam: true, name: true },
    });
    await Promise.all(
      events.map((event) => {
        const shared = this.verifying.get(event.id);
        if (shared && Date.now() - shared.at < VERIFY_SHARE_MS) return shared.done;
        const done = (async () => {
          const raw = await this.client!.liveOddsFor(event.externalId!);
          if (!raw) {
            await this.prisma.event.update({ where: { id: event.id }, data: { liveStopped: true, liveVersion: { increment: 1 } } });
            return;
          }
          await this.applyLiveOdds(event.id, parseLiveOdds(raw, event.homeTeam ?? event.name, event.awayTeam ?? ""));
        })();
        const entry = { at: Date.now(), done };
        this.verifying.set(event.id, entry);
        // Shared only for VERIFY_SHARE_MS; drop it after, so the map doesn't keep every live match ever bet on.
        const forget = () => {
          if (this.verifying.get(event.id) === entry) this.verifying.delete(event.id);
        };
        done.then(() => setTimeout(forget, VERIFY_SHARE_MS).unref(), forget);
        return done;
      }),
    );
    if (events.length > 0) await this.announceLive(events.map((event) => event.id));
  }

  /**
   * Reads the given live football matches straight from the feed (their
   * fixtures by id, one request for up to 20), saves their centres, and
   * returns the feed's record of each (FeedMark): its score and how many
   * goals, cards, VAR checks and penalties its timeline has. A live bet reads
   * this when it comes in and again at the end of its wait, so anything that
   * happened in between refuses it, whatever our saved copy says; and its
   * cards are recorded for the late check (bets/late.ts). A read already
   * running for a match is shared. Throws if the feed can't be reached or
   * leaves a match out.
   */
  async readMarks(eventIds: string[]): Promise<Map<string, FeedMark>> {
    const marks = new Map<string, FeedMark>();
    if (this.mode !== "api-football" || !this.client || eventIds.length === 0) return marks;
    const events = await this.prisma.event.findMany({
      where: { id: { in: [...new Set(eventIds)] }, status: EventStatus.LIVE, sport: "football", provider: this.provider(), externalId: { not: null } },
      select: { id: true, externalId: true },
    });
    const waits = new Set<Promise<Map<string, FeedMark>>>();
    const fresh: typeof events = [];
    for (const event of events) {
      const shared = this.verifyingCards.get(event.id);
      if (shared && Date.now() - shared.at < VERIFY_SHARE_MS) waits.add(shared.done);
      else fresh.push(event);
    }
    for (let i = 0; i < fresh.length; i += 20) {
      const batch = fresh.slice(i, i + 20);
      // A match the feed left out keeps its older centre, so it doesn't count as read.
      const done = this.saveMatchCentres(batch).then(({ saved, marks: read }) => {
        if (saved < batch.length) throw new Error("The feed didn't send every match's events");
        return read;
      });
      const entry = { at: Date.now(), done };
      for (const event of batch) this.verifyingCards.set(event.id, entry);
      const forget = () => batch.forEach((event) => this.verifyingCards.get(event.id) === entry && this.verifyingCards.delete(event.id));
      done.then(() => setTimeout(forget, VERIFY_SHARE_MS).unref(), forget);
      waits.add(done);
    }
    for (const read of await Promise.all(waits)) for (const [id, mark] of read) if (events.some((event) => event.id === id)) marks.set(id, mark);
    return marks;
  }

  /** Tells the pages about live prices just saved: each team gets its own (OddsService), or everyone is asked to fetch them. */
  private async announceLive(eventIds: string[]) {
    if (this.onLiveSaved) {
      try {
        await this.onLiveSaved(eventIds);
        return;
      } catch (error) {
        this.logger.warn(`Live prices not sent to the pages: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.realtime?.publishAll({ type: "odds.changed" });
  }

  async onModuleDestroy() {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
    this.loopStops.forEach((stop) => stop());
    this.redis?.disconnect();
  }

  /** Runs a full sync now (Super Admin's "Sync now"). */
  async syncNow(): Promise<SyncSummary> {
    if (!this.client) throw new Error("The odds feed isn't connected");
    const full = await this.withLock(() => this.syncFull(true));
    if (!full) throw new Error("A sync is already running. Try again in a minute.");
    return full;
  }

  private async scheduled(kind: "full") {
    if (Date.now() < this.limitPausedUntil) return;
    try {
      await this.withLock(() => this.syncFull());
    } catch (error) {
      this.feedFailed(`Odds ${kind} sync failed`, error);
      const message = error instanceof Error ? error.message : String(error);
      await this.recordStatus(isDailyLimitError(error) ? "API-Football's requests for today are used up" : `Failed: ${message}`, false);
    }
  }

  /**
   * Runs `task` unless the same kind of sync (here or on another instance) is
   * running. Pre-match, live prices and live scores have separate locks.
   */
  private async withLock<T>(task: () => Promise<T>, key: string = LOCK_KEY): Promise<T | null> {
    if (this.runningLocks.has(key)) return null;
    const token = `${process.pid}-${Date.now()}`;
    let locked = true;
    if (this.redis?.status === "ready") {
      locked = (await this.redis.set(key, token, "PX", key === LOCK_KEY ? 5 * 60_000 : 60_000, "NX").catch(() => "OK")) === "OK";
    }
    if (!locked) return null;
    this.runningLocks.add(key);
    try {
      return await task();
    } finally {
      this.runningLocks.delete(key);
      if (this.redis?.status === "ready") {
        const current = await this.redis.get(key).catch(() => null);
        if (current === token) await this.redis.del(key).catch(() => undefined);
      }
    }
  }

  /**
   * A fixture from a chosen competition, or one already listed: a match from
   * a league Super Admin turned off keeps fresh prices until it's played, so
   * nobody bets on it at a stale price. In mock mode every made-up league is
   * taken until Super Admin picks.
   */
  private wanted(fixture: FeedFixture, listed: Set<string>): boolean {
    if (listed.has(fixture.externalId)) return true;
    if (this.mode === "mock" && !this.custom) return true;
    return this.leagues.has(fixture.leagueId) || this.countries.has(fixture.country.toLowerCase());
  }

  private useChoice(choice: CompetitionChoice, custom: boolean) {
    this.leagues = new Set(choice.leagues);
    this.countries = new Set(choice.countries.map((c) => c.toLowerCase()));
    this.custom = custom;
  }

  /** Super Admin's pick, or null while the defaults apply. */
  async savedChoice(): Promise<CompetitionChoice | null> {
    const row = await this.prisma.platformSettings.findUnique({ where: { id: "default" }, select: { oddsCompetitions: true } });
    return parseChoice(row?.oddsCompetitions);
  }

  /** Saves Super Admin's pick (null goes back to the defaults). The next sync uses it; nothing needs a restart. */
  async saveChoice(choice: CompetitionChoice | null) {
    const value = choice ?? Prisma.DbNull;
    await this.prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default", oddsCompetitions: value }, update: { oddsCompetitions: value } });
    this.useChoice(choice ?? this.defaults, choice !== null);
  }

  /** Every competition with a season in progress, for the picker. One request, kept for 12 hours. */
  async availableLeagues(): Promise<FeedLeague[] | null> {
    if (!this.client) return null;
    if (this.leagueList && Date.now() - this.leagueList.at < 12 * 3_600_000) return this.leagueList.leagues;
    const leagues = await this.client.currentLeagues();
    this.leagueList = { at: Date.now(), leagues };
    return leagues;
  }

  /** Requests left on today's API-Football plan, as of its last answer. */
  get requestsLeft(): number | null {
    return this.quotaLeft;
  }

  /** How many requests a day the plan allows, as of its last answer. */
  get requestsLimit(): number | null {
    return this.quotaLimit;
  }

  /**
   * Fetches fixtures and pre-match odds for every day that's due, or for all
   * of them when `force` is set (Super Admin's "Sync now").
   */
  private async syncFull(force = false): Promise<SyncSummary> {
    const client = this.client!;
    const saved = await this.savedChoice().catch(() => null);
    this.useChoice(saved ?? this.defaults, saved !== null);
    await this.checkLeagues();
    let events = 0;
    let markets = 0;
    let refreshed = 0;
    let saving = false;
    const schedule = (this.quotaLimit ?? 0) >= RICH_PLAN ? PREMATCH_REFRESH_MS.rich : PREMATCH_REFRESH_MS.lean;
    for (let day = 0; day < this.days; day++) {
      const date = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
      if (day > 0 && this.quotaLeft !== null && this.quotaLeft < quotaReserve(this.quotaLimit)) {
        saving = true;
        continue;
      }
      if (!force && !(await this.isDue(date))) continue;
      const all = await client.fixturesByDate(date);
      const kickOffs = new Map(
        (await this.prisma.event.findMany({ where: { provider: this.provider(), externalId: { in: all.map((f) => f.externalId) } }, select: { externalId: true, startsAt: true } })).map((e) => [e.externalId!, e.startsAt]),
      );
      const fixtures = all.filter((f) => this.wanted(f, new Set(kickOffs.keys())));
      const ids = new Map<string, string>();
      for (const fixture of fixtures) ids.set(fixture.externalId, await this.upsertEvent(fixture, kickOffs.get(fixture.externalId)));
      events += fixtures.length;

      // Odds are fetched per league, only for matches that haven't started.
      const byLeague = new Map<string, FeedFixture[]>();
      for (const fixture of fixtures.filter((f) => f.status === EventStatus.UPCOMING)) {
        const key = `${fixture.leagueId}:${fixture.season}`;
        byLeague.set(key, [...(byLeague.get(key) ?? []), fixture]);
      }
      for (const [key, leagueFixtures] of byLeague) {
        const [leagueId, season] = key.split(":").map(Number);
        const odds = await client.odds(leagueId, season, date, this.bookmakerId);
        for (const raw of odds) {
          const fixture = leagueFixtures.find((f) => f.externalId === String(raw.fixture.id));
          const eventId = fixture && ids.get(fixture.externalId);
          if (!fixture || !eventId) continue;
          const parsed = parseMarkets(raw, fixture.homeTeam, fixture.awayTeam, this.bookmakerId);
          await this.upsertMarkets(eventId, parsed);
          markets += parsed.length;
        }
      }
      await this.markRefreshed(date, schedule[Math.min(day, schedule.length - 1)]);
      refreshed++;
    }
    const live = (await this.syncLive()) ?? 0;
    await this.syncMatchCentres().catch((error) => this.feedFailed("Match centres not updated", error));
    await this.syncStats();
    await this.syncGoals();
    await this.syncLateChecks().catch((error) => this.logger.warn(`Timelines for the late-bet check not fetched: ${error instanceof Error ? error.message : String(error)}`));
    await this.recheckResults();
    if (saving) {
      this.logger.warn(`Only ${this.quotaLeft} API-Football requests left today, so only today's matches are refreshed`);
      await this.recordStatus(`Only ${this.quotaLeft} API-Football requests left today, so only today's matches are refreshed`, refreshed > 0);
    } else if (refreshed > 0) {
      await this.recordStatus(`Synced ${events} matches and ${markets} markets`, true);
    }
    return { events, markets, live };
  }

  /** Whether a day's fixtures and odds are older than its refresh interval. */
  private async isDue(date: string): Promise<boolean> {
    if (this.redis?.status === "ready") {
      const exists = await this.redis.exists(`${LOCK_KEY}:day:${date}`).catch(() => null);
      if (exists !== null) return exists === 0;
    }
    const at = this.refreshedAt.get(date);
    return at === undefined || Date.now() >= at;
  }

  private async markRefreshed(date: string, validFor: number) {
    this.refreshedAt.set(date, Date.now() + validFor);
    for (const [key, until] of this.refreshedAt) if (until < Date.now() - 86_400_000) this.refreshedAt.delete(key);
    if (this.redis?.status === "ready") await this.redis.set(`${LOCK_KEY}:day:${date}`, "1", "PX", validFor).catch(() => undefined);
  }

  /**
   * Logs, once per start, which configured leagues the feed knows, so a wrong
   * id in API_FOOTBALL_LEAGUES doesn't go unnoticed. Costs one request.
   */
  private async checkLeagues() {
    if (this.leaguesChecked || this.mode !== "api-football") return;
    this.leaguesChecked = true;
    const known = await this.client!.currentLeagues().catch(() => null);
    if (!known) return;
    this.leagueList = { at: Date.now(), leagues: known };
    const byId = new Map(known.map((league) => [league.id, league]));
    const missing = [...this.leagues].filter((id) => !byId.has(id));
    const countries = [...this.countries].filter((country) => !known.some((league) => league.country.toLowerCase() === country));
    this.logger.log(`Syncing ${this.leagues.size - missing.length} leagues and every league in: ${[...this.countries].join(", ") || "no countries"}`);
    if (missing.length > 0) this.logger.warn(`API-Football has no current season for league ids ${missing.join(", ")}; check ${this.custom ? "the Leagues list on the Odds page" : "API_FOOTBALL_LEAGUES / API_FOOTBALL_COUNTRIES"}`);
    if (countries.length > 0) this.logger.warn(`API-Football has no current leagues for ${countries.join(", ")}; check ${this.custom ? "the Leagues list on the Odds page" : "API_FOOTBALL_LEAGUES / API_FOOTBALL_COUNTRIES"}`);
  }

  /**
   * Updates scores and the minute for matches that are live or should have
   * started (in-play prices are syncLiveOdds'). Null when there is nothing to update. The count is how many
   * tracked matches had dropped off the live list (just finished).
   */
  private async syncLive(): Promise<number | null> {
    const client = this.client!;
    const provider = this.provider();
    const tracked = await this.prisma.event.findMany({
      where: { provider, externalId: { not: null }, OR: [{ status: EventStatus.LIVE }, { status: EventStatus.UPCOMING, startsAt: { lte: new Date() } }] },
      select: { id: true, externalId: true, status: true, elapsed: true, homeScore: true, awayScore: true, liveStopped: true, liveOddsAt: true, liveCooldownUntil: true, liveCooldownReason: true, period: true, finishedAt: true },
    });
    if (tracked.length === 0) return null;
    const live = await client.liveFixtures();
    const seen = new Set(live.map((f) => f.externalId));
    const trackedIds = new Set(tracked.map((e) => e.externalId!));
    const trackedBy = new Map(tracked.map((e) => [e.externalId!, e]));
    // Matches that dropped off the live list have finished (or been stopped): fetch them by id for the final state.
    const missing = [...trackedIds].filter((id) => !seen.has(id));
    const finished: FeedFixture[] = [];
    for (let i = 0; i < missing.length; i += 20) finished.push(...(await client.fixturesByIds(missing.slice(i, i + 20))));
    /** Matches whose state the pages show changed here (kick-off, full time, the minute, a score): pushed to them below. */
    const changed: string[] = [];
    for (const fixture of [...live.filter((f) => trackedIds.has(f.externalId)), ...finished]) {
      const saved = trackedBy.get(fixture.externalId)!;
      // While the live odds are fresh they carry the newer score; the fixtures list lags and would flip it back and forth.
      const oddsHaveScore = fixture.status === EventStatus.LIVE && saved.liveOddsAt !== null && Date.now() - saved.liveOddsAt.getTime() < LIVE_SCORE_SOURCE_MS;
      const score = oddsHaveScore ? {} : { homeScore: fixture.homeScore, awayScore: fixture.awayScore };
      const cooldown = oddsHaveScore
        ? null
        : cooldownFor(
            { homeScore: saved.homeScore, awayScore: saved.awayScore, stopped: saved.liveStopped },
            { homeScore: fixture.homeScore, awayScore: fixture.awayScore, stopped: saved.liveStopped },
            false,
          );
      const pause = laterCooldown({ until: saved.liveCooldownUntil, reason: saved.liveCooldownReason }, cooldown);
      if (!oddsHaveScore && fixture.status === EventStatus.LIVE) await this.noteGoal(saved.id, saved, fixture, fixture.elapsed, "scores", await this.pricesBeforeGoal(saved.id, saved, fixture));
      const period = saved.period === "FT" && fixture.status === EventStatus.LIVE ? "FT" : fixture.period;
      const scoreMoved = !oddsHaveScore && (saved.homeScore !== fixture.homeScore || saved.awayScore !== fixture.awayScore);
      if (saved.status !== fixture.status || saved.elapsed !== fixture.elapsed || saved.period !== period || scoreMoved) changed.push(saved.id);
      // A goal seen here pauses the goal markets; the others wait for prices made after it.
      const paused = cooldown && fixture.status === EventStatus.LIVE ? (await this.pauseMarkets(saved.id, { reason: cooldown.reason, pricedSinceEvent: new Set() }, null, new Date())).started : false;
      // A new score or a new pause is a change in the live match that a bet being confirmed must not go through (Event.liveVersion).
      const stateMoved = scoreMoved || paused;
      await this.prisma.event.update({
        where: { provider_externalId: { provider, externalId: fixture.externalId } },
        data: {
          status: fixture.status,
          elapsed: fixture.elapsed,
          ...(saved.elapsed !== fixture.elapsed ? { elapsedAt: new Date() } : {}),
          // The live odds can say full time before the fixtures list catches up; don't flip it back to "2H".
          period,
          ...(fixture.status === EventStatus.COMPLETED && !saved.finishedAt ? { finishedAt: new Date() } : {}),
          ...score,
          ...savedCrests(fixture.homeLogo, fixture.awayLogo),
          ...savedMarks(fixture.leagueLogo, fixture.countryFlag),
          liveCooldownUntil: pause.until,
          liveCooldownReason: pause.reason,
          ...(stateMoved ? { liveVersion: { increment: 1 } } : {}),
          syncedAt: new Date(),
        },
      });
      await this.recordResult(provider, fixture);
    }
    if (changed.length > 0) await this.announceLive(changed);
    return finished.length;
  }

  /**
   * Corners and cards for finished matches, which the corner and card
   * markets settle on. Only matches with open bets on those markets are
   * asked about (one request each), at most every 10 minutes and for 3 days
   * after kick-off, since the feed can take a while to publish statistics.
   * A match that went to extra time is skipped: its statistics include extra
   * time, so Super Admin enters the 90-minute numbers by hand.
   */
  /**
   * The match centre (timeline and numbers) of each football match a Player
   * has a bet on, while it's live and once more in the first minutes after
   * it ends, so their bet shows who scored, who was booked and the corners.
   * Up to 20 matches per request (fixtures by id carry their events and
   * statistics), every MATCH_CENTRE_EVERY_MS, while the day's quota has room.
   */
  private async syncMatchCentres(): Promise<number> {
    const now = Date.now();
    if (!this.centreQuotaOk(now)) return 0;
    for (const [id, at] of this.centreInterest) if (now - at > MATCH_CENTRE_INTEREST_MS) this.centreInterest.delete(id);
    // Matches a Player has a bet on, and those someone has the stats of open.
    const withBets = { markets: { some: { selections: { some: { OR: [{ bets: { some: {} } }, { legs: { some: {} } }] } } } } } satisfies Prisma.EventWhereInput;
    const watched = { id: { in: [...this.centreInterest.keys()] } } satisfies Prisma.EventWhereInput;
    const due = await this.prisma.event.findMany({
      where: {
        provider: this.provider(),
        sport: "football",
        externalId: { not: null },
        AND: [
          {
            OR: [
              { status: EventStatus.LIVE },
              // Just finished: a few more times, for the final numbers (the feed can take a minute to complete them).
              { status: EventStatus.COMPLETED, finishedAt: { gte: new Date(now - MATCH_CENTRE_AFTER_MS) }, OR: [{ matchCentreAt: null }, { matchCentreAt: { lt: new Date(now - 60_000) } }] },
            ],
          },
          this.centreInterest.size > 0 ? { OR: [withBets, watched] } : withBets,
        ],
      },
      select: { id: true, externalId: true },
      orderBy: { startsAt: "asc" },
      take: MATCH_CENTRE_MAX,
    });
    let saved = 0;
    for (let i = 0; i < due.length; i += 20) saved += (await this.saveMatchCentres(due.slice(i, i + 20))).saved;
    return saved;
  }

  /**
   * Fetches up to 20 matches' centres in one request and saves them, with the
   * feed's record of each (FeedMark). Something new in a live match's
   * timeline pauses the whole match at once, like a goal in its prices: a red
   * card, a VAR check or a penalty, and a goal its score doesn't have yet
   * (which counts as the site seeing that goal, GoalSeen).
   */
  private async saveMatchCentres(batch: Array<{ id: string; externalId: string | null }>): Promise<{ saved: number; marks: Map<string, FeedMark> }> {
    const byExternal = new Map(batch.map((event) => [event.externalId!, event.id]));
    const savedBefore = await this.prisma.event.findMany({
      where: { id: { in: batch.map((event) => event.id) } },
      select: { id: true, name: true, status: true, elapsed: true, homeScore: true, awayScore: true, matchCentre: true, liveCooldownUntil: true, liveCooldownReason: true },
    });
    const before = new Map(savedBefore.map((event) => [event.id, event]));
    let saved = 0;
    const marks = new Map<string, FeedMark>();
    const paused: string[] = [];
    for (const raw of await this.client!.fixtureDetails(batch.map((event) => event.externalId!))) {
      const eventId = byExternal.get(String(raw.fixture.id));
      if (!eventId) continue;
      const centre = parseMatchCentre(raw);
      const mark = feedMarkOf(raw);
      marks.set(eventId, mark);
      const was = before.get(eventId);
      const kinds = (value: unknown, ...wanted: string[]) => ((value as { moments?: Array<{ kind: string }> } | null)?.moments ?? []).filter((moment) => wanted.includes(moment.kind)).length;
      // Only a live match with a centre saved before can have something new.
      const live = was?.status === EventStatus.LIVE && was.matchCentre !== null;
      const goalAhead = was?.status === EventStatus.LIVE && was.homeScore !== null && was.awayScore !== null && mark.home !== null && mark.away !== null && mark.home + mark.away > was.homeScore + was.awayScore;
      let reason: CooldownReason | null = null;
      if (goalAhead) reason = "ahead";
      else if (live && kinds(centre, "red") > kinds(was.matchCentre, "red")) reason = "red";
      else if (live && kinds(centre, "var", "missed_penalty", "penalty") > kinds(was.matchCentre, "var", "missed_penalty", "penalty")) reason = "var";
      const pause = reason && GOAL_COOLDOWN_MS > 0 ? laterCooldown({ until: was!.liveCooldownUntil, reason: was!.liveCooldownReason }, { until: new Date(Date.now() + GOAL_COOLDOWN_MS), reason }) : null;
      // Not noted as a goal until the score on the board changes. A timeline that's briefly ahead (a disallowed goal) must not be stored as the moment we saw it.
      // The markets it changes pause; the others wait for prices made after it (this read isn't the bookmaker's).
      if (reason) await this.pauseMarkets(eventId, { reason, pricedSinceEvent: new Set() }, null, new Date());
      else if (was?.matchCentre) await this.prisma.market.updateMany({ where: { eventId, livePauseReason: "ahead", livePausedUntil: { gt: new Date() } }, data: { livePausedUntil: new Date() } });
      await this.prisma.event.update({
        where: { id: eventId },
        data: {
          matchCentre: centre as unknown as Prisma.InputJsonValue,
          matchCentreAt: new Date(),
          ...(pause ? { liveCooldownUntil: pause.until, liveCooldownReason: pause.reason } : {}),
          ...(reason ? { liveVersion: { increment: 1 } } : {}),
          // A goal its prices don't have yet: paused markets don't reopen on prices without it.
          ...(was?.status === EventStatus.LIVE && mark.home !== null && mark.away !== null ? { liveScoreAhead: goalAhead ? `${mark.home}:${mark.away}` : null } : {}),
        },
      });
      if (reason) {
        this.logger.log(`Live betting paused on ${was!.name} (${reason} in the feed's timeline${goalAhead ? `: ${mark.home}–${mark.away} before its prices had it` : ""}) until ${pause?.until?.toISOString() ?? "now"}`);
        paused.push(eventId);
      }
      saved++;
    }
    if (paused.length > 0) await this.announceLive(paused);
    return { saved, marks };
  }

  /** Room on today's quota for match centres: above the reserve kept for scores and results, and the feed not paused. */
  private centreQuotaOk(now: number): boolean {
    if (now < this.limitPausedUntil) return false;
    const spare = this.spare();
    return spare === null || spare > 0;
  }

  /**
   * Someone opened a football match's stats. While they keep looking, the
   * live sync refreshes it with the matches that have bets; and if what's
   * saved is out of date (never fetched, or older than a live sync, or not
   * yet the final numbers), it's fetched now, once for everyone asking.
   * Before kick-off only the team sheets come, from 90 minutes before.
   * Without quota to spare, what's saved is what they get. True when it
   * fetched.
   */
  async refreshMatchCentre(event: { id: string; sport: string; provider: string; externalId: string | null; status: EventStatus; startsAt: Date; finishedAt: Date | null; matchCentreAt: Date | null }): Promise<boolean> {
    if (this.mode !== "api-football" || !this.client || event.sport !== "football" || event.provider !== this.provider() || !event.externalId) return false;
    const now = Date.now();
    const fetchedAt = event.matchCentreAt?.getTime() ?? null;
    let stale: boolean;
    if (event.status === EventStatus.LIVE) {
      this.centreInterest.set(event.id, now);
      stale = fetchedAt === null || now - fetchedAt > MATCH_CENTRE_EVERY_MS + 15_000;
    } else if (event.status === EventStatus.COMPLETED) {
      // The final numbers: fetched after the 15 minutes the feed takes to complete them, then kept.
      const final = event.finishedAt ? event.finishedAt.getTime() + MATCH_CENTRE_AFTER_MS : null;
      stale = fetchedAt === null || (final !== null && fetchedAt < final && now - fetchedAt > 60_000);
    } else if (event.status === EventStatus.UPCOMING) {
      stale = event.startsAt.getTime() - now < LINEUPS_BEFORE_MS && (fetchedAt === null || now - fetchedAt > LINEUPS_EVERY_MS);
    } else {
      stale = false;
    }
    if (!stale || !this.centreQuotaOk(now)) return false;
    let running = this.centreFetches.get(event.id);
    if (!running) {
      running = this.saveMatchCentres([event])
        .then(({ saved }) => saved > 0)
        .catch((error) => {
          this.logger.warn(`Match centre for event ${event.id} not updated: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        })
        .finally(() => this.centreFetches.delete(event.id));
      this.centreFetches.set(event.id, running);
    }
    return running;
  }

  private async syncStats(): Promise<number> {
    const provider = this.provider();
    const now = Date.now();
    const openOnStats = {
      OR: STATS_MARKET_PREFIXES.map((prefix) => ({ key: { startsWith: prefix } })),
      selections: { some: { OR: [{ bets: { some: { status: BetStatus.OPEN } } }, { legs: { some: { result: null, voidReason: null } } }] } },
    };
    const due = await this.prisma.event.findMany({
      where: {
        provider,
        externalId: { not: null },
        status: EventStatus.COMPLETED,
        extraTime: false,
        statsSource: null,
        startsAt: { gte: new Date(now - 3 * 86_400_000) },
        OR: [{ statsCheckedAt: null }, { statsCheckedAt: { lt: new Date(now - 10 * 60_000) } }],
        markets: { some: openOnStats },
      },
      select: { id: true, externalId: true, homeTeam: true, name: true },
      take: 20,
    });
    let found = 0;
    for (const event of due) {
      const stats = await this.client!.statistics(event.externalId!, event.homeTeam ?? event.name).catch(() => null);
      await this.prisma.event.updateMany({
        // Re-checked here so numbers Super Admin typed in meanwhile are never overwritten.
        where: { id: event.id, statsSource: null },
        data: stats
          ? {
              resultCornersHome: stats.cornersHome,
              resultCornersAway: stats.cornersAway,
              resultCardsHome: stats.cardsHome,
              resultCardsAway: stats.cardsAway,
              statsSource: "feed",
              statsCheckedAt: new Date(),
            }
          : { statsCheckedAt: new Date() },
      });
      if (stats) found++;
    }
    return found;
  }

  /**
   * The goals in order and who took part, for finished matches with open bets
   * on the goal-event markets (first/last team to score, win from behind,
   * goalscorers). The feed sends them with a fixture fetched by id, 20
   * matches a request. A match is asked about at most every 10 minutes for 3
   * days after kick-off; goals that don't add up to the score yet (the feed
   * still correcting them) are asked for again, and after that the bets wait
   * for Super Admin.
   */
  /**
   * Notes when the site first saw a goal: the score went up from `before` to
   * `after`. A goal taken back isn't one. `beforeGoal` is who scored and the
   * match-result prices just before, for live bets on prices that haven't
   * caught up with it. When the goal is new, the open live bets on the match
   * are checked straight away (onGoalSeen, without holding up the sync), and
   * how far behind the feed was is logged; the goals noted also measure the
   * feed's delay over time (feedDelay). Never holds up the live sync.
   */
  private async noteGoal(
    eventId: string,
    before: { homeScore: number | null; awayScore: number | null },
    after: { homeScore: number | null; awayScore: number | null },
    elapsed: number | null,
    source: "scores" | "odds" | "centre",
    beforeGoal: Record<string, unknown> | null = null,
  ) {
    if (before.homeScore === null || before.awayScore === null || after.homeScore === null || after.awayScore === null) return;
    if (after.homeScore + after.awayScore <= before.homeScore + before.awayScore) return;
    const seenAt = new Date();
    const row = { eventId, homeScore: after.homeScore, awayScore: after.awayScore, elapsed, source, seenAt };
    try {
      // Without the prices from before the goal if they can't be saved: when the site saw the goal is what voids late bets.
      const { count } = await this.prisma.goalSeen
        .createMany({ data: [{ ...row, ...(beforeGoal ? { beforeGoal: beforeGoal as Prisma.InputJsonValue } : {}) }], skipDuplicates: true })
        .catch((error) => {
          if (!beforeGoal) throw error;
          this.logger.error(`Goal on event ${eventId} saved without the prices from before it: ${error instanceof Error ? error.message : String(error)}`);
          return this.prisma.goalSeen.createMany({ data: [row], skipDuplicates: true });
        });
      if (count === 0) return;
      this.logger.log(`Goal seen on event ${eventId}: ${after.homeScore}–${after.awayScore} at ${elapsed ?? "?"}' from the ${source} feed`);
      void this.goalArrived(eventId, { home: after.homeScore, away: after.awayScore }, source, seenAt).catch((error) =>
        this.logger.warn(`Late check on event ${eventId}'s new goal failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    } catch (error) {
      // Without it, the late check can only go by the feed's timeline after full time.
      this.logger.error(`Goal on event ${eventId} (${after.homeScore}–${after.awayScore}) not noted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Who scored, and the match-result prices we had just before the goal (still the pre-goal ones), or null when it isn't a goal. */
  private async pricesBeforeGoal(eventId: string, before: { homeScore: number | null; awayScore: number | null }, after: { homeScore: number | null; awayScore: number | null }) {
    if (before.homeScore === null || before.awayScore === null || after.homeScore === null || after.awayScore === null) return null;
    if (after.homeScore + after.awayScore <= before.homeScore + before.awayScore) return null;
    const rows = await this.prisma.selection.findMany({ where: { market: { eventId, key: "match_winner" } }, select: { key: true, liveOdds: true } });
    const price = (key: string) => {
      const value = rows.find((row) => row.key === key)?.liveOdds;
      return value === null || value === undefined ? null : Number(value);
    };
    return { side: after.homeScore > before.homeScore ? "home" : "away", home: price("home"), draw: price("draw"), away: price("away") };
  }

  /**
   * A new goal reached the site: fetches the match's timeline so far (one
   * request) to tell when it really went in, and has the open live bets
   * placed after it voided (onGoalSeen; that happens even if the timeline
   * can't be had). The goal's delay is kept with it (GoalSeen.lagMs) and
   * logged; a match whose goal certainly reached the site more than
   * LIVE_SLOW_MATCH_MS after it went in takes no more live bets.
   */
  private async goalArrived(eventId: string, score: { home: number; away: number }, source: string, seenAt: Date) {
    let timeline: LateTimeline | null = null;
    try {
      if (this.mode === "api-football" && this.client && this.centreQuotaOk(Date.now())) {
        const event = await this.prisma.event.findUnique({ where: { id: eventId }, select: { name: true, league: true, provider: true, externalId: true, sport: true } });
        if (event?.externalId && event.sport === "football") {
          const [raw] = await this.client.fixtureDetails([event.externalId]).catch(() => []);
          timeline = raw ? parseLiveTimeline(raw) : null;
          const goal = timeline ? goalForScore(timeline, score.home, score.away) : null;
          const lag = goal && timeline ? goalLag(goal, timeline, seenAt) : null;
          if (lag) {
            await this.saveLag(eventId, score, lag);
            this.logger.log(`Feed lag on ${event.name} (${event.provider}, ${event.league}): ${score.home}–${score.away} (${goal!.minute}${goal!.extra ? `+${goal!.extra}` : ""}') reached the site about ${Math.round(lag.lagMs / 1000)} s after it went in, at least ${Math.max(0, Math.round(lag.lagMinMs / 1000))} s (${source} feed)`);
            if (lag.lagMinMs > LIVE_SLOW_MATCH_MS) await this.stopSlowMatch(eventId, event.name, lag.lagMinMs);
          } else {
            this.logger.log(`Feed lag on ${event.name}: ${score.home}–${score.away} not timed yet (${timeline ? "the feed's timeline doesn't have it" : "no timeline from the feed"})`);
          }
        }
      }
    } finally {
      await this.onGoalSeen?.(eventId, timeline);
    }
  }

  /** Keeps a goal's delay with it (feed-delay.ts goalLag). */
  private async saveLag(eventId: string, score: { home: number; away: number }, lag: { eventAt: number; lagMs: number; lagMinMs: number }) {
    await this.prisma.goalSeen.updateMany({
      where: { eventId, homeScore: score.home, awayScore: score.away },
      data: { eventAt: new Date(lag.eventAt), lagMs: Math.round(lag.lagMs), lagMinMs: Math.round(lag.lagMinMs) },
    });
  }

  /** No more live bets on a match whose feed is further behind than any wait can cover (Event.liveSlowFeed). */
  private async stopSlowMatch(eventId: string, name: string, lagMinMs: number) {
    const { count } = await this.prisma.event.updateMany({ where: { id: eventId, liveSlowFeed: false }, data: { liveSlowFeed: true, liveVersion: { increment: 1 } } });
    if (count === 0) return;
    this.logger.warn(`Live betting stopped on ${name}: a goal reached the site at least ${Math.round(lagMinMs / 1000)} s after it went in, longer than the ${LIVE_SLOW_MATCH_MS / 1000} s a live bet can wait`);
    await this.announceLive([eventId]);
  }

  /**
   * Finished matches' timelines (bets/late.ts LateTimeline): each goal's and
   * card's minute and when each half kicked off. Fetched for matches with live
   * bets still to settle, so the late ones are found, and for matches whose
   * goals the site noted, to measure the feed's delay. 20 matches a request,
   * at most 40 a run; one the feed can't give is tried again 10 minutes later.
   */
  private async syncLateChecks(only?: string[], notify = true): Promise<number> {
    const provider = this.provider();
    const now = Date.now();
    // A month of goals is plenty to measure the delay on.
    await this.prisma.goalSeen.deleteMany({ where: { seenAt: { lt: new Date(now - 30 * 86_400_000) } } });
    const liveBet = { not: Prisma.DbNull };
    const due = await this.prisma.event.findMany({
      where: only
        ? { id: { in: only }, provider, sport: "football", externalId: { not: null }, status: EventStatus.COMPLETED, resultHome: { not: null }, resultAway: { not: null }, lateCheck: { equals: Prisma.DbNull } }
        : {
        provider,
        sport: "football",
        externalId: { not: null },
        status: EventStatus.COMPLETED,
        resultHome: { not: null },
        resultAway: { not: null },
        lateCheck: { equals: Prisma.DbNull },
        startsAt: { gte: new Date(now - 3 * 86_400_000) },
        AND: [
          { OR: [{ lateCheckedAt: null }, { lateCheckedAt: { lt: new Date(now - 10 * 60_000) } }] },
          {
            OR: [
              { goalsSeen: { some: {} } },
              {
                markets: {
                  some: {
                    selections: {
                      some: { OR: [{ bets: { some: { status: BetStatus.OPEN, live: liveBet } } }, { legs: { some: { result: null, voidReason: null, live: liveBet } } }] },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
      select: { id: true, name: true, externalId: true, resultHome: true, resultAway: true },
      orderBy: { startsAt: "desc" },
      take: 40,
    });
    const found: string[] = [];
    for (let i = 0; i < due.length; i += 20) {
      const batch = due.slice(i, i + 20);
      const details = await this.client!.fixtureDetails(batch.map((e) => e.externalId!)).catch(() => []);
      for (const event of batch) {
        const raw = details.find((d) => String(d.fixture.id) === event.externalId);
        const timeline = raw ? parseLateTimeline(raw, { home: event.resultHome!, away: event.resultAway! }) : null;
        await this.prisma.event.update({
          where: { id: event.id },
          data: timeline ? { lateCheck: timeline as unknown as Prisma.InputJsonValue, lateCheckedAt: new Date() } : { lateCheckedAt: new Date() },
        });
        if (!timeline) {
          this.logger.warn(`No timeline for the late check on ${event.name} yet: ${raw ? "its goals don't add up to the result" : "the feed didn't send it"}`);
          continue;
        }
        found.push(event.id);
        await this.logFeedLag(event.id, event.name, timeline);
      }
    }
    if (found.length > 0 && notify) await this.onTimeline?.(found).catch((error) => this.logger.warn(`Settled live bets not checked again: ${error instanceof Error ? error.message : String(error)}`));
    return found.length;
  }

  /**
   * Fetches the timelines of these finished matches now, whatever the usual
   * schedule, for Super Admin's late re-check (SettlementService.recheckLate),
   * which then decides on the bets itself (so a dry run changes nothing).
   * Matches that already have one are left as they are.
   */
  async refreshLateChecks(eventIds: string[]): Promise<number> {
    if (this.mode !== "api-football" || !this.client || eventIds.length === 0) return 0;
    return this.syncLateChecks(eventIds, false);
  }

  /**
   * Logs how far behind the ground the feed was on each goal of a finished
   * match, from when the site saw it (feed-delay.ts), with its provider and
   * competition, and keeps each goal's delay that wasn't kept as it arrived.
   */
  private async logFeedLag(eventId: string, name: string, timeline: LateTimeline) {
    const [rows, event] = await Promise.all([
      this.prisma.goalSeen.findMany({ where: { eventId }, select: { homeScore: true, awayScore: true, source: true, seenAt: true, lagMs: true } }),
      this.prisma.event.findUnique({ where: { id: eventId }, select: { provider: true, league: true } }),
    ]);
    if (rows.length === 0) return;
    for (const row of rows.filter((r) => r.lagMs === null)) {
      const goal = goalForScore(timeline, row.homeScore, row.awayScore);
      const lag = goal ? goalLag(goal, timeline, row.seenAt) : null;
      if (lag) await this.saveLag(eventId, { home: row.homeScore, away: row.awayScore }, lag);
    }
    const delay = feedDelay(rows.map((row) => ({ eventName: name, ...row, timeline })));
    if (delay.goals === 0) return;
    const each = [...delay.recent].reverse().map((goal) => `${goal.score} (${goal.minute}') ${goal.seconds} s via ${goal.source}`).join("; ");
    this.logger.log(`Feed lag on ${name} (${event?.provider ?? "?"}, ${event?.league ?? "?"}): ${delay.goals} goal(s), average ${delay.average} s, slowest ${delay.slowest} s: ${each}`);
  }

  private async syncGoals(): Promise<number> {
    const provider = this.provider();
    const now = Date.now();
    const due = await this.prisma.event.findMany({
      where: {
        provider,
        externalId: { not: null },
        status: EventStatus.COMPLETED,
        resultHome: { not: null },
        resultAway: { not: null },
        resultGoals: { equals: Prisma.DbNull },
        startsAt: { gte: new Date(now - 3 * 86_400_000) },
        OR: [{ goalsCheckedAt: null }, { goalsCheckedAt: { lt: new Date(now - 10 * 60_000) } }],
        markets: {
          some: {
            key: { in: GOAL_MARKET_KEYS },
            selections: { some: { OR: [{ bets: { some: { status: BetStatus.OPEN } } }, { legs: { some: { result: null, voidReason: null } } }] } },
          },
        },
      },
      select: { id: true, externalId: true, resultHome: true, resultAway: true },
      take: 40,
    });
    let found = 0;
    for (let i = 0; i < due.length; i += 20) {
      const batch = due.slice(i, i + 20);
      const details = await this.client!.fixtureDetails(batch.map((e) => e.externalId!)).catch(() => []);
      for (const event of batch) {
        const raw = details.find((d) => String(d.fixture.id) === event.externalId);
        const record = raw ? parseGoalRecord(raw, { home: event.resultHome!, away: event.resultAway! }) : null;
        await this.prisma.event.update({
          where: { id: event.id },
          data: record ? { resultGoals: record as unknown as Prisma.InputJsonValue, goalsCheckedAt: new Date() } : { goalsCheckedAt: new Date() },
        });
        if (record) found++;
      }
    }
    return found;
  }

  /**
   * Asks the feed again about matches that finished in the last two days and
   * have bets, each at most once an hour, so a score it corrects after the
   * day's fixture list stopped covering the match still reaches the bets
   * (see recordResult). Today's matches are covered by the day's own refresh;
   * this is for the ones before. At most 60 matches (3 requests) a run.
   */
  private async recheckResults(): Promise<number> {
    const provider = this.provider();
    const now = Date.now();
    const due = await this.prisma.event.findMany({
      where: {
        provider,
        externalId: { not: null },
        status: EventStatus.COMPLETED,
        resultSource: "feed",
        startsAt: { gte: new Date(now - RESULT_RECHECK_MS) },
        OR: [{ syncedAt: null }, { syncedAt: { lt: new Date(now - RESULT_RECHECK_EVERY_MS) } }],
        markets: { some: { selections: { some: { OR: [{ bets: { some: {} } }, { legs: { some: {} } }] } } } },
      },
      orderBy: { syncedAt: "asc" },
      select: { id: true, externalId: true },
      take: 60,
    });
    for (let i = 0; i < due.length; i += 20) {
      const batch = due.slice(i, i + 20);
      const fixtures = await this.client!.fixturesByIds(batch.map((event) => event.externalId!));
      // Only the score is taken: a finished match's bets were settled at full time, whatever the feed says about it later.
      for (const fixture of fixtures) await this.recordResult(provider, fixture);
      await this.prisma.event.updateMany({ where: { id: { in: batch.map((event) => event.id) } }, data: { syncedAt: new Date() } });
    }
    return due.length;
  }

  /**
   * In-play prices for the matches that are live now. A market the feed drops
   * or suspends is suspended here too, and a match missing from the feed stops
   * getting fresh prices, so its live bets pause once the prices go stale.
   */
  private async syncLiveOdds(): Promise<number> {
    const provider = this.provider();
    const live = await this.prisma.event.findMany({
      where: { provider, externalId: { not: null }, status: EventStatus.LIVE },
      select: { id: true, externalId: true, homeTeam: true, awayTeam: true, name: true },
    });
    if (live.length === 0) return 0;
    const byExternal = new Map(live.map((e) => [e.externalId!, e]));
    const feed = await this.client!.liveOdds();
    const readings = feed.flatMap((raw) => {
      const event = byExternal.get(String(raw.fixture.id));
      return event ? [{ eventId: event.id, odds: parseLiveOdds(raw, event.homeTeam ?? event.name, event.awayTeam ?? "") }] : [];
    });
    // A few matches at a time: one after another, a busy evening's readings took longer than the time between them.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(LIVE_WRITERS, readings.length) }, async () => {
        while (next < readings.length) {
          const reading = readings[next++];
          // One match failing to save doesn't hold up the others.
          await this.applyLiveOdds(reading.eventId, reading.odds).catch((error) =>
            this.logger.warn(`Live odds for event ${reading.eventId} not saved: ${error instanceof Error ? error.message : String(error)}`),
          );
        }
      }),
    );
    this.lastLiveOddsAt = Date.now();
    if (readings.length > 0) await this.announceLive(readings.map((reading) => reading.eventId));
    return readings.length;
  }

  /**
   * Saves one reading of a live match: its prices, whether the bookmaker has
   * it blocked, the score and minute, and a pause (live-guard.ts) if a goal
   * went in, the match-result prices jumped, or the bookmaker just reopened it.
   */
  /** The latest live price reading for a match, or null if none came since the API started. */
  liveReading(eventId: string) {
    return this.readings.get(eventId) ?? null;
  }

  private async applyLiveOdds(eventId: string, odds: FeedLiveOdds) {
    const now = new Date();
    const parsedUpdate = odds.bookmakerUpdate ? new Date(odds.bookmakerUpdate) : null;
    const bookmakerUpdate = parsedUpdate && !Number.isNaN(parsedUpdate.getTime()) ? parsedUpdate : null;
    this.readings.set(eventId, { at: now, bookmakerUpdate: odds.bookmakerUpdate ?? null, clock: odds.clock ?? null });
    this.polling.note(eventId, now, bookmakerUpdate);
    // A match not read for an hour is over; the map keeps only the live ones.
    if (this.readings.size > 500) for (const [id, reading] of this.readings) if (Date.now() - reading.at.getTime() > 3_600_000) this.readings.delete(id);
    const before = await this.prisma.event.findUniqueOrThrow({
      where: { id: eventId },
      select: { homeScore: true, awayScore: true, elapsed: true, liveStopped: true, liveSlowFeed: true, liveCooldownUntil: true, liveCooldownReason: true, liveScoreAhead: true, liveOddsAt: true, status: true, startsAt: true, period: true },
    });
    const scored = odds.homeScore !== null && odds.awayScore !== null;
    const after = { homeScore: scored ? odds.homeScore : before.homeScore, awayScore: scored ? odds.awayScore : before.awayScore, stopped: odds.stopped };
    // Read before the new prices are saved: still the ones from before the goal.
    const beforeGoal = scored ? await this.pricesBeforeGoal(eventId, before, after) : null;
    const { swing, priced } = await this.upsertLiveMarkets(eventId, odds.markets, now);
    const saved = { homeScore: before.homeScore, awayScore: before.awayScore, stopped: before.liveStopped };
    const cooldown = cooldownFor(saved, after, swing, now);
    if (scored) await this.noteGoal(eventId, before, after, odds.elapsed, "odds", beforeGoal);
    let pause = laterCooldown({ until: before.liveCooldownUntil, reason: before.liveCooldownReason }, cooldown);
    // A goal the timeline or fixture had first: paused markets wait for prices with it.
    const ahead = scoreOf(before.liveScoreAhead);
    const caughtUp = !ahead || (scored && odds.homeScore! + odds.awayScore! >= ahead.home + ahead.away);
    const goal = scoreChanged(saved, after);
    const elapsed = odds.elapsed ?? null;
    const matchOpen = !odds.stopped && !before.liveSlowFeed && !(LIVE_CUTOFF_MINUTE > 0 && (elapsed ?? 0) >= LIVE_CUTOFF_MINUTE);
    // The event's pause on the markets it changes (the reading brought it, so a market it prices was made after it), and the
    // paused markets this reading is fresh for reopened.
    const markets = await this.pauseMarkets(
      eventId,
      cooldown ? { reason: cooldown.reason, pricedSinceEvent: priced } : null,
      { stopped: odds.stopped, scoreKnown: scored && caughtUp, bookmakerUpdate, priced },
      now,
      { status: before.status, startsAt: before.startsAt, period: odds.finished ? "FT" : before.period, open: matchOpen },
    );
    // The match keeps its latest pause, ending when its main market reopened.
    if (markets.mainReopen && pause.until && EVENT_PAUSES.has(pause.reason ?? "") && markets.mainReopen < pause.until) pause = { ...pause, until: markets.mainReopen };
    // The score, a pause starting, or the bookmaker blocking or reopening the match: a change a bet being confirmed must not go through (Event.liveVersion).
    const stateMoved = goal || odds.stopped !== before.liveStopped || markets.started;
    // Market-time since the last reading, for the share of it the board was open (capped: a gap means the readings stopped).
    const seconds = before.liveOddsAt ? Math.min(60, Math.max(0, (now.getTime() - before.liveOddsAt.getTime()) / 1000)) : 0;
    await this.prisma.event.update({
      where: { id: eventId },
      data: {
        liveOddsAt: now,
        liveStopped: odds.stopped,
        ...(stateMoved ? { liveVersion: { increment: 1 } } : {}),
        ...(odds.finished ? { period: "FT" } : {}),
        ...(scored ? { homeScore: odds.homeScore, awayScore: odds.awayScore } : {}),
        ...(odds.elapsed !== null ? { elapsed: odds.elapsed, ...(odds.elapsed !== before.elapsed ? { elapsedAt: new Date() } : {}) } : {}),
        ...(ahead && caughtUp ? { liveScoreAhead: null } : {}),
        liveCooldownUntil: pause.until,
        liveCooldownReason: pause.reason,
        ...(seconds > 0 ? { liveMarketSec: { increment: seconds * markets.total }, liveShownSec: { increment: seconds * markets.shown }, liveOpenSec: { increment: seconds * markets.open } } : {}),
      },
    });
  }

  /**
   * Puts an event's pause on the markets of a live match it changes
   * (live-guard.ts eventPause, mergePause), and reopens the paused markets a
   * new reading is fresh for (freshUntil). `event.pricedSinceEvent`: the
   * markets a reading made after the event prices, which stay open if the
   * event doesn't change them. Returns whether a pause began or got longer
   * (a change a live bet being confirmed must not go through), when the main
   * market (the match result) reopens early if it does, and with `state`, how
   * many markets the match has, how many are on the board (not stale) and how
   * many take bets, for the metrics. Each event's pause is kept (LivePause).
   */
  private async pauseMarkets(
    eventId: string,
    event: { reason: MarketPauseReason; pricedSinceEvent: ReadonlySet<string> } | null,
    reading: { stopped: boolean; scoreKnown: boolean; bookmakerUpdate: Date | null; priced: ReadonlySet<string> } | null,
    now: Date,
    state?: { status: EventStatus; startsAt: Date; period: string | null; open: boolean },
  ): Promise<{ started: boolean; mainReopen: Date | null; total: number; shown: number; open: number }> {
    const markets = await this.prisma.market.findMany({
      where: { eventId },
      select: { id: true, key: true, liveSuspended: true, livePausedAt: true, livePausedUntil: true, liveReopenFrom: true, livePauseReason: true, liveMovedAt: true, liveQuotedAt: true },
    });
    const main = markets.find((market) => market.key === "match_winner") ?? (event ? markets.find((market) => hitBy(event.reason, market.key)) : undefined);
    const writes = new Map<string, { pause: MarketPause; ids: string[] }>();
    let started = false;
    let paused = 0;
    let reopened = 0;
    let mainReopen: Date | null = null;
    let mainStarted: MarketPause | null = null;
    const counts = { total: 0, shown: 0, open: 0 };
    for (const market of markets) {
      const was: MarketPause = { pausedAt: market.livePausedAt, until: market.livePausedUntil, reopenFrom: market.liveReopenFrom, reason: market.livePauseReason };
      let pause = was;
      if (event) {
        pause = mergePause(was, eventPause({ reason: event.reason, marketKey: market.key, pricedSinceEvent: event.pricedSinceEvent.has(market.key), now }), now);
        if (pause !== was) {
          started = true;
          paused++;
          if (market === main) mainStarted = pause;
        }
      }
      if (reading && pause.until && pause.until > now) {
        const sample = { stopped: reading.stopped, scoreKnown: reading.scoreKnown, priced: reading.priced.has(market.key), bookmakerUpdate: reading.bookmakerUpdate, movedAt: market.liveMovedAt };
        const until = freshUntil(pause, sample, now);
        if (!until && market === main) {
          const why = freshBlocker(pause, sample, now);
          if (why) this.logger.log(`Live market ${market.key} on event ${eventId} stays paused (${pause.reason}): ${why}`);
        }
        if (until) {
          pause = { ...pause, until };
          reopened++;
          if (market === main) mainReopen = until;
        }
      }
      if (pause !== was) {
        const key = JSON.stringify(pause);
        const write = writes.get(key) ?? { pause, ids: [] };
        write.ids.push(market.id);
        writes.set(key, write);
      }
      if (state) {
        counts.total++;
        const shown = !marketStale(state, market, now, market.liveMovedAt !== null);
        if (shown) counts.shown++;
        if (shown && state.open && !market.liveSuspended && (reading?.priced.has(market.key) ?? true) && !(pause.until && pause.until > now)) counts.open++;
      }
    }
    for (const { pause, ids } of writes.values()) {
      await this.prisma.market.updateMany({
        where: { id: { in: ids } },
        data: { livePausedAt: pause.pausedAt, livePausedUntil: pause.until, liveReopenFrom: pause.reopenFrom, livePauseReason: pause.reason },
      });
    }
    if (event && started) {
      this.logger.log(`Live markets paused on event ${eventId} (${event.reason}): ${paused} of ${markets.length}${mainStarted ? `, the match result until ${(mainStarted as MarketPause).until?.toISOString()} at the latest` : ""}`);
    }
    if (mainStarted) {
      const { pausedAt, until } = mainStarted as MarketPause;
      if (pausedAt && until) await this.prisma.livePause.create({ data: { eventId, reason: event!.reason, startedAt: pausedAt, endsAt: until, markets: paused } }).catch(() => undefined);
    }
    if (reopened > 0) this.logger.log(`Live markets reopening on event ${eventId}: ${reopened} had fresh prices after the ${main?.livePauseReason ?? "event"}${mainReopen ? `; the match result at ${(mainReopen as Date).toISOString()}` : ""}`);
    if (mainReopen && main?.livePausedAt) {
      await this.prisma.livePause.updateMany({ where: { eventId, startedAt: main.livePausedAt }, data: { endsAt: mainReopen, fresh: true } }).catch(() => undefined);
    }
    return { started, mainReopen, ...counts };
  }

  private provider(): string {
    return this.mode === "mock" ? "mock" : "api-football";
  }

  /** `previousStart` is the kick-off already saved for this match, if it's listed. */
  private async upsertEvent(fixture: FeedFixture, previousStart?: Date): Promise<string> {
    // Moved more than UNPLAYED_VOID_MS later: bets placed for the old date are refunded.
    const rescheduled = movedLater(previousStart, fixture.startsAt);
    if (rescheduled) this.logger.log(`Match ${fixture.externalId} moved from ${previousStart!.toISOString()} to ${fixture.startsAt.toISOString()}`);
    const data = {
      name: `${fixture.homeTeam} v ${fixture.awayTeam}`,
      league: fixture.league,
      country: fixture.country,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      ...savedCrests(fixture.homeLogo, fixture.awayLogo),
      ...savedMarks(fixture.leagueLogo, fixture.countryFlag),
      startsAt: fixture.startsAt,
      status: fixture.status,
      elapsed: fixture.elapsed,
      period: fixture.period,
      homeScore: fixture.homeScore,
      awayScore: fixture.awayScore,
      syncedAt: new Date(),
    };
    const provider = this.provider();
    const event = await this.prisma.event.upsert({
      where: { provider_externalId: { provider, externalId: fixture.externalId } },
      create: { ...data, provider, externalId: fixture.externalId },
      // hidden and suspended are Super Admin's and never overwritten by the feed.
      update: { ...data, ...(rescheduled ? { rescheduledAt: new Date() } : {}) },
      select: { id: true },
    });
    await this.recordResult(provider, fixture);
    return event.id;
  }

  /**
   * Saves the score bets settle on once a match has finished. A result Super
   * Admin corrected by hand is never overwritten. SettlementService pays the
   * bets out from here, and re-settles them if the feed later changes a
   * score it already sent (resultChangedAt).
   */
  private async recordResult(provider: string, fixture: FeedFixture) {
    if (!fixture.result) return;
    const where = { provider, externalId: fixture.externalId, OR: [{ resultSource: null }, { resultSource: "feed" }] };
    const saved = await this.prisma.event.findFirst({ where, select: { resultHome: true, resultAway: true, resultHalfHome: true, resultHalfAway: true } });
    if (!saved) return;
    const next = {
      resultHome: fixture.result.home,
      resultAway: fixture.result.away,
      resultHalfHome: fixture.halfTime?.home ?? null,
      resultHalfAway: fixture.halfTime?.away ?? null,
    };
    // A score arriving for the first time (the half-time one can come later) is news, not a change.
    const changed =
      (saved.resultHome !== null && (saved.resultHome !== next.resultHome || saved.resultAway !== next.resultAway)) ||
      (saved.resultHalfHome !== null && next.resultHalfHome !== null && (saved.resultHalfHome !== next.resultHalfHome || saved.resultHalfAway !== next.resultHalfAway));
    if (changed) this.logger.warn(`The feed changed match ${fixture.externalId} from ${saved.resultHome}-${saved.resultAway} to ${next.resultHome}-${next.resultAway}`);
    await this.prisma.event.updateMany({
      where,
      // A changed score means the goals saved for it are out of date: they're fetched again.
      data: { ...next, extraTime: fixture.extraTime, resultSource: "feed", ...(changed ? { resultChangedAt: new Date(), resultGoals: Prisma.DbNull, goalsCheckedAt: null } : {}) },
    });
  }

  /**
   * Saves pre-match prices. Selections are never deleted, because bets point at them. Only what changed is written: new outcomes are
   * added, moved prices updated (with a snapshot for the movement chart), and
   * outcomes the feed stopped pricing within a market it still sends are
   * withdrawn, so nobody bets on a stale price (a player left out of the
   * squad, a line taken down). One that comes back is reopened.
   */
  /** Saves a match's (or fight's) pre-match prices; also used by the MMA sync. */
  async upsertMarkets(eventId: string, markets: FeedMarket[]) {
    for (const market of markets) {
      await this.prisma.$transaction(async (tx) => {
        const row = await tx.market.upsert({
          where: { eventId_key: { eventId, key: market.key } },
          create: { eventId, key: market.key, name: market.name, sortOrder: market.sortOrder },
          update: { name: market.name, sortOrder: market.sortOrder },
          select: { id: true },
        });
        const existing = new Map(
          (await tx.selection.findMany({ where: { marketId: row.id }, select: { id: true, key: true, name: true, feedOdds: true, sortOrder: true, withdrawn: true } })).map((s) => [s.key, s]),
        );
        const added = market.selections.filter((selection) => !existing.has(selection.key));
        if (added.length > 0) {
          await tx.selection.createMany({
            data: added.map((selection) => ({ marketId: row.id, key: selection.key, name: selection.name, feedOdds: new Prisma.Decimal(selection.odds.toFixed(2)), sortOrder: selection.sortOrder })),
            skipDuplicates: true,
          });
          const created = await tx.selection.findMany({ where: { marketId: row.id, key: { in: added.map((s) => s.key) } }, select: { id: true, feedOdds: true } });
          await tx.oddsSnapshot.createMany({ data: created.map((s) => ({ selectionId: s.id, price: s.feedOdds })) });
        }
        for (const selection of market.selections) {
          const before = existing.get(selection.key);
          if (!before) continue;
          const feedOdds = new Prisma.Decimal(selection.odds.toFixed(2));
          const moved = !before.feedOdds.equals(feedOdds);
          if (!moved && before.name === selection.name && before.sortOrder === selection.sortOrder && !before.withdrawn) continue;
          await tx.selection.update({ where: { id: before.id }, data: { name: selection.name, feedOdds, sortOrder: selection.sortOrder, withdrawn: false } });
          // A sparse change log for the movement chart, not a row on every sync.
          if (moved) await tx.oddsSnapshot.create({ data: { selectionId: before.id, price: feedOdds } });
        }
        const sent = new Set(market.selections.map((s) => s.key));
        const gone = [...existing.values()].filter((s) => !sent.has(s.key) && !s.withdrawn).map((s) => s.id);
        if (gone.length > 0) await tx.selection.updateMany({ where: { id: { in: gone } }, data: { withdrawn: true } });
      });
    }
  }

  /**
   * Saves in-play prices; markets the feed didn't send this time are
   * suspended. Returns whether the match-result prices jumped (bigSwing).
   */
  /**
   * Saves one live reading's markets and prices, writing only what changed:
   * the match's markets and prices are read in one query and compared, new
   * ones are added, and changed prices go in one statement. A reading is
   * mostly the same as the last (taken seconds ago), and writing every price
   * of every live match on every reading took longer than the time between
   * readings, which slowed them all down, a goal's reopening included.
   * Each market priced on this reading has it noted (Market.liveQuotedAt),
   * and each whose prices moved too (liveMovedAt). Returns whether the
   * match-result prices jumped (bigSwing) and the keys of the markets this
   * reading prices.
   */
  private async upsertLiveMarkets(eventId: string, markets: FeedLiveMarket[], now: Date = new Date()): Promise<{ swing: boolean; priced: Set<string> }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.market.findMany({
        where: { eventId },
        select: { id: true, key: true, liveSuspended: true, liveQuotedAt: true, selections: { select: { id: true, key: true, liveOdds: true } } },
      });
      const byKey = new Map(existing.map((market) => [market.key, market]));
      const priceOf = (odds: number) => (odds > 1 ? odds.toFixed(2) : null);

      const main = markets.find((m) => m.key === "match_winner");
      const previous = byKey.get("match_winner")?.selections ?? [];
      const swing = main
        ? bigSwing(
            main.selections.map((s) => {
              const old = previous.find((p) => p.key === s.key)?.liveOdds;
              return old === null || old === undefined ? null : Number(old);
            }),
            main.selections.map((s) => (s.odds > 1 ? s.odds : null)),
          )
        : false;

      // Markets the feed stopped sending are suspended.
      const sent = new Set(markets.map((m) => m.key));
      const suspend = existing.filter((market) => !sent.has(market.key) && !market.liveSuspended).map((market) => market.id);
      const reopen: string[] = [];
      const quoted: string[] = [];
      const moved: string[] = [];
      const pricedMarkets = new Set<string>();
      const prices: Array<{ id: string; price: string | null }> = [];
      const added: Prisma.SelectionCreateManyInput[] = [];
      for (const market of markets) {
        const row = byKey.get(market.key);
        if (!market.suspended) pricedMarkets.add(market.key);
        if (!row) {
          // A market first seen live has no pre-match price; the live one stands in.
          await tx.market.create({
            data: {
              eventId,
              key: market.key,
              name: market.name,
              sortOrder: market.sortOrder,
              liveSuspended: market.suspended,
              liveMovedAt: now,
              liveQuotedAt: market.suspended ? null : now,
              selections: {
                create: market.selections.map((selection) => {
                  const price = priceOf(selection.odds);
                  return { key: selection.key, name: selection.name, feedOdds: new Prisma.Decimal(price ?? "1.01"), liveOdds: price === null ? null : new Prisma.Decimal(price), sortOrder: selection.sortOrder };
                }),
              },
            },
          });
          continue;
        }
        if (row.liveSuspended !== market.suspended) (market.suspended ? suspend : reopen).push(row.id);
        // When it was last priced only matters to the minute (marketStale): not written on every reading.
        if (!market.suspended && (!row.liveQuotedAt || now.getTime() - row.liveQuotedAt.getTime() > QUOTED_EVERY_MS)) quoted.push(row.id);
        const old = new Map(row.selections.map((selection) => [selection.key, selection]));
        let movedHere = false;
        for (const selection of market.selections) {
          const price = priceOf(selection.odds);
          const was = old.get(selection.key);
          if (!was) {
            added.push({ marketId: row.id, key: selection.key, name: selection.name, feedOdds: new Prisma.Decimal(price ?? "1.01"), liveOdds: price === null ? null : new Prisma.Decimal(price), sortOrder: selection.sortOrder });
            if (price !== null) movedHere = true;
          } else if ((was.liveOdds === null ? null : was.liveOdds.toFixed(2)) !== price) {
            prices.push({ id: was.id, price });
            if (price !== null) movedHere = true;
          }
        }
        if (movedHere) moved.push(row.id);
        // An outcome the feed no longer prices (0–0 once a goal is in) loses its live price, so it can't be bet on.
        const priced = new Set(market.selections.map((selection) => selection.key));
        for (const was of row.selections) if (!priced.has(was.key) && was.liveOdds !== null) prices.push({ id: was.id, price: null });
      }
      // Suspended or back, priced, prices moved: one statement for the match's markets.
      const touched = [...new Set([...suspend, ...reopen, ...quoted, ...moved])];
      if (touched.length) {
        await tx.$executeRaw`
          UPDATE markets SET
            live_suspended = CASE WHEN id = ANY(${suspend}::text[]) THEN true WHEN id = ANY(${reopen}::text[]) THEN false ELSE live_suspended END,
            live_quoted_at = CASE WHEN id = ANY(${quoted}::text[]) THEN ${now} ELSE live_quoted_at END,
            live_moved_at = CASE WHEN id = ANY(${moved}::text[]) THEN ${now} ELSE live_moved_at END,
            updated_at = NOW()
          WHERE id = ANY(${touched}::text[])`;
      }
      if (added.length) await tx.selection.createMany({ data: added, skipDuplicates: true });
      if (prices.length) {
        // One JSON value rather than arrays: a connection whose first array held only missing prices kept that
        // array's type, and every later price not exactly 4 characters long ("12.00") failed on it.
        await tx.$executeRaw`
          UPDATE selections AS s SET live_odds = v.price, updated_at = NOW()
          FROM json_to_recordset(${JSON.stringify(prices)}::json) AS v(id text, price numeric)
          WHERE s.id = v.id`;
      }
      return { swing, priced: pricedMarkets };
    });
  }

  private async recordStatus(status: string, succeeded: boolean) {
    const data = { oddsSyncStatus: status.slice(0, 300), ...(succeeded ? { oddsSyncedAt: new Date() } : {}) };
    await this.prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data }).catch(() => undefined);
  }
}

function parseChoice(value: unknown): CompetitionChoice | null {
  if (!value || typeof value !== "object") return null;
  const { leagues, countries } = value as Record<string, unknown>;
  if (!Array.isArray(leagues) || !Array.isArray(countries)) return null;
  return { leagues: leagues.map(Number).filter(Number.isInteger), countries: countries.map(String) };
}

/** Infinity (nothing affordable) as null, for JSON. */
const finiteOr = (ms: number) => (Number.isFinite(ms) ? Math.round(ms) : null);

/** A score kept as "2:1" (Event.liveScoreAhead), or null. */
function scoreOf(value: string | null): { home: number; away: number } | null {
  const match = value ? /^(\d+):(\d+)$/.exec(value) : null;
  return match ? { home: Number(match[1]), away: Number(match[2]) } : null;
}

function listEnv(name: string): string[] | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}
