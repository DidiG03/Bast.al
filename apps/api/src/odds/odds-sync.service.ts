import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { BetStatus, EventStatus, Prisma } from "@prisma/client";
import Redis from "ioredis";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { GOAL_MARKET_KEYS } from "../bets/goals";
import { ApiFootballClient, FeedFixture, FeedLeague, FeedLiveMarket, FeedLiveOdds, FeedMarket, httpFetchJson, parseGoalRecord, parseLiveOdds, parseMarkets, parseMatchCentre } from "./api-football";
import { savedCrests, savedMarks } from "./crest";
import { bigSwing, cooldownFor, goalPauseOver, laterCooldown, scoreChanged } from "./live-guard";
import { mockFetchJson } from "./mock-feed";

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

/**
 * How often each day's fixtures and pre-match prices are refreshed: today
 * every 30 minutes, tomorrow every 2 hours, then every 6, and the last two of
 * the week every 12. Prices a few days out barely move, so they're fetched
 * rarely; that keeps a wide league list inside API-Football's Pro plan
 * (7,500 requests a day).
 */
const PREMATCH_REFRESH_MS = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 6 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];
/** Below this many requests left today, only today's matches are refreshed. */
const QUOTA_RESERVE = Number(process.env.API_FOOTBALL_QUOTA_RESERVE) || 600;
/** API-Football's id for Bet365, the bookmaker whose prices we start from. */
const DEFAULT_BOOKMAKER = 8;

export type FeedMode = "api-football" | "mock" | "off";

type SyncSummary = { events: number; markets: number; live: number };

/** Which competitions are synced: league ids, plus countries whose every league is. */
export type CompetitionChoice = { leagues: number[]; countries: string[] };

const LOCK_KEY = "bastal:odds-sync";
/** Live updates have a lock of their own, so a long pre-match sync never holds them up. */
const LIVE_LOCK_KEY = "bastal:odds-sync:live";
/**
 * While someone has looked at live matches in the last LIVE_INTEREST_MS, live
 * prices are fetched every LIVE_FAST_INTERVAL_MS (one request) instead of
 * waiting for the regular live sync, until LIVE_WATCH_FLOOR requests are left
 * for bet checks and the score list.
 */
const LIVE_FAST_INTERVAL_MS = Number(process.env.LIVE_FAST_INTERVAL_MS) || 15_000;
/** The open board keeps its 15s price refresh until only this many requests are left today. */
const LIVE_WATCH_FLOOR = 80;
/** The regular live sync skips a second odds request when one already landed this recently. Scores still update. */
const LIVE_ODDS_FRESH_MS = 20_000;
/** The regular live sync: scores and in-play prices, two requests a run. */
const LIVE_INTERVAL_MS = Number(process.env.ODDS_LIVE_INTERVAL_MS) || 45_000;
const LIVE_INTEREST_MS = 2 * 60_000;
/** How long after a match ends its match centre is fetched once more, for the final numbers. */
const MATCH_CENTRE_AFTER_MS = 15 * 60_000;
/** Matches whose match centre is fetched on one live sync: 3 requests' worth. */
const MATCH_CENTRE_MAX = 60;
/** A match someone opened the stats of stays on the live sync's list this long after they last looked. */
const MATCH_CENTRE_INTEREST_MS = 2 * 60_000;
/** Before kick-off, the match centre (the team sheets) is fetched from this long before, at most every 10 minutes. */
const LINEUPS_BEFORE_MS = 90 * 60_000;
const LINEUPS_EVERY_MS = 10 * 60_000;
/** Live matches saved at the same time on each reading; each takes one database connection. */
const LIVE_WRITERS = 6;
/** A match's score comes from the live odds while they're this fresh; the fixtures list lags behind them. */
const LIVE_SCORE_SOURCE_MS = 60_000;
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
 * - every ODDS_LIVE_INTERVAL_MS (45 seconds): scores for matches that are
 *   live or should have kicked off, only while there are any, plus in-play
 *   odds for the live ones (one request for all of them);
 * - every LIVE_FAST_INTERVAL_MS (15 seconds) while someone is watching live
 *   matches: the in-play odds again (one request), until LIVE_WATCH_FLOOR
 *   requests are left;
 * - on every live bet: that match's odds straight from the feed (verifyLive).
 * Redis locks make sure only one API instance syncs at a time; pre-match and
 * live syncs lock separately.
 */
@Injectable()
export class OddsSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OddsSyncService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private redis?: Redis;
  private running = false;
  private liveRunning = false;
  /** When a Player or admin last looked at live matches. */
  private liveInterestAt = 0;
  /** When in-play prices were last fetched for the whole live board. */
  private lastLiveOddsAt = 0;
  /** Checks with the feed for one match, shared by bets placed at the same moment. */
  private readonly verifying = new Map<string, { at: number; done: Promise<void> }>();
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
  /** Requests left on today's API-Football quota, from its last answer. */
  private quotaLeft: number | null = null;
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
      this.client = new ApiFootballClient(httpFetchJson(process.env.API_FOOTBALL_HOST?.trim() || "v3.football.api-sports.io", key, (left) => (this.quotaLeft = left)));
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
    this.timers.push(setInterval(() => void this.scheduled("live"), LIVE_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.fastLive(), LIVE_FAST_INTERVAL_MS));
  }

  /** Someone is looking at live matches: fetch their prices more often for a while. */
  noteLiveInterest() {
    this.liveInterestAt = Date.now();
  }

  /**
   * The quick in-between live update: in-play prices only (one request),
   * while someone is watching. It keeps going below the pre-match reserve so
   * an open board stays current, and stops at a small floor so bet checks
   * and the score list still have requests left.
   */
  private async fastLive() {
    if (Date.now() - this.liveInterestAt > LIVE_INTEREST_MS) return;
    if (this.quotaLeft !== null && this.quotaLeft < LIVE_WATCH_FLOOR) return;
    try {
      await this.withLock(() => this.syncLiveOdds(), LIVE_LOCK_KEY);
    } catch (error) {
      this.logger.warn(`Quick live odds update failed: ${error instanceof Error ? error.message : String(error)}`);
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
            await this.prisma.event.update({ where: { id: event.id }, data: { liveStopped: true } });
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
    if (events.length > 0) await this.realtime?.publishAll({ type: "odds.changed" });
  }

  async onModuleDestroy() {
    this.timers.forEach(clearTimeout);
    this.redis?.disconnect();
  }

  /** Runs a full sync now (Super Admin's "Sync now"). */
  async syncNow(): Promise<SyncSummary> {
    if (!this.client) throw new Error("The odds feed isn't connected");
    const full = await this.withLock(() => this.syncFull(true));
    if (!full) throw new Error("A sync is already running. Try again in a minute.");
    return full;
  }

  private async scheduled(kind: "full" | "live") {
    try {
      if (kind === "full") {
        await this.withLock(() => this.syncFull());
        return;
      }
      // Prices first, under the lock. Match centres and settlement checks wait
      // until the lock is free, so a goal's new prices aren't stuck behind them.
      const finished = await this.withLock(() => this.syncLive(), LIVE_LOCK_KEY);
      if (finished === null) return;
      await this.syncMatchCentres().catch((error) => this.logger.warn(`Match centres not updated: ${error instanceof Error ? error.message : String(error)}`));
      if (finished > 0) {
        await this.syncStats();
        await this.syncGoals();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Odds ${kind} sync failed: ${message}`);
      if (kind === "full") await this.recordStatus(`Failed: ${message}`, false);
    }
  }

  /**
   * Runs `task` unless the same kind of sync (here or on another instance) is
   * running. Pre-match and live syncs have separate locks.
   */
  private async withLock<T>(task: () => Promise<T>, key: string = LOCK_KEY): Promise<T | null> {
    const live = key === LIVE_LOCK_KEY;
    if (live ? this.liveRunning : this.running) return null;
    const token = `${process.pid}-${Date.now()}`;
    let locked = true;
    if (this.redis?.status === "ready") {
      locked = (await this.redis.set(key, token, "PX", live ? 60_000 : 5 * 60_000, "NX").catch(() => "OK")) === "OK";
    }
    if (!locked) return null;
    if (live) this.liveRunning = true;
    else this.running = true;
    try {
      return await task();
    } finally {
      if (live) this.liveRunning = false;
      else this.running = false;
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
    for (let day = 0; day < this.days; day++) {
      const date = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
      if (day > 0 && this.quotaLeft !== null && this.quotaLeft < QUOTA_RESERVE) {
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
      await this.markRefreshed(date, PREMATCH_REFRESH_MS[Math.min(day, PREMATCH_REFRESH_MS.length - 1)]);
      refreshed++;
    }
    const live = (await this.syncLive()) ?? 0;
    await this.syncMatchCentres().catch((error) => this.logger.warn(`Match centres not updated: ${error instanceof Error ? error.message : String(error)}`));
    await this.syncStats();
    await this.syncGoals();
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
   * Updates scores and in-play prices for matches that are live or should have
   * started. Null when there is nothing to update. The count is how many
   * tracked matches had dropped off the live list (just finished).
   */
  private async syncLive(): Promise<number | null> {
    const client = this.client!;
    const provider = this.provider();
    const tracked = await this.prisma.event.findMany({
      where: { provider, externalId: { not: null }, OR: [{ status: EventStatus.LIVE }, { status: EventStatus.UPCOMING, startsAt: { lte: new Date() } }] },
      select: { id: true, externalId: true, homeScore: true, awayScore: true, liveStopped: true, liveOddsAt: true, liveCooldownUntil: true, liveCooldownReason: true, period: true, finishedAt: true },
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
      await this.prisma.event.update({
        where: { provider_externalId: { provider, externalId: fixture.externalId } },
        data: {
          status: fixture.status,
          elapsed: fixture.elapsed,
          // The live odds can say full time before the fixtures list catches up; don't flip it back to "2H".
          period: saved.period === "FT" && fixture.status === EventStatus.LIVE ? "FT" : fixture.period,
          ...(fixture.status === EventStatus.COMPLETED && !saved.finishedAt ? { finishedAt: new Date() } : {}),
          ...score,
          ...savedCrests(fixture.homeLogo, fixture.awayLogo),
          ...savedMarks(fixture.leagueLogo, fixture.countryFlag),
          liveCooldownUntil: pause.until,
          liveCooldownReason: pause.reason,
          syncedAt: new Date(),
        },
      });
      await this.recordResult(provider, fixture);
    }
    // A fast refresh a moment ago already has these prices. Scores above still update.
    if (Date.now() - this.lastLiveOddsAt >= LIVE_ODDS_FRESH_MS) await this.syncLiveOdds();
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
   * statistics), on every live sync, while the day's quota has room.
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
    for (let i = 0; i < due.length; i += 20) saved += await this.saveMatchCentres(due.slice(i, i + 20));
    return saved;
  }

  /** Fetches up to 20 matches' centres in one request and saves them. */
  private async saveMatchCentres(batch: Array<{ id: string; externalId: string | null }>): Promise<number> {
    const byExternal = new Map(batch.map((event) => [event.externalId!, event.id]));
    let saved = 0;
    for (const raw of await this.client!.fixtureDetails(batch.map((event) => event.externalId!))) {
      const eventId = byExternal.get(String(raw.fixture.id));
      if (!eventId) continue;
      await this.prisma.event.update({ where: { id: eventId }, data: { matchCentre: parseMatchCentre(raw) as unknown as Prisma.InputJsonValue, matchCentreAt: new Date() } });
      saved++;
    }
    return saved;
  }

  /**
   * Room on today's quota for match centres: what the regular live sync
   * still needs before the quota resets at midnight UTC is kept back, plus
   * room for checking bets.
   */
  private centreQuotaOk(now: number): boolean {
    const liveRunsLeft = Math.ceil((86_400_000 - (now % 86_400_000)) / LIVE_INTERVAL_MS);
    return this.quotaLeft === null || this.quotaLeft >= Math.min(QUOTA_RESERVE, 2 * liveRunsLeft + 200);
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
      stale = fetchedAt === null || now - fetchedAt > LIVE_INTERVAL_MS + 15_000;
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
        .then((saved) => saved > 0)
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
    if (readings.length > 0) await this.realtime?.publishAll({ type: "odds.changed" });
    return readings.length;
  }

  /**
   * Saves one reading of a live match: its prices, whether the bookmaker has
   * it blocked, the score and minute, and a pause (live-guard.ts) if a goal
   * went in, the match-result prices jumped, or the bookmaker just reopened it.
   */
  private async applyLiveOdds(eventId: string, odds: FeedLiveOdds) {
    const before = await this.prisma.event.findUniqueOrThrow({
      where: { id: eventId },
      select: { homeScore: true, awayScore: true, liveStopped: true, liveCooldownUntil: true, liveCooldownReason: true },
    });
    const swing = await this.upsertLiveMarkets(eventId, odds.markets);
    const scored = odds.homeScore !== null && odds.awayScore !== null;
    const after = { homeScore: scored ? odds.homeScore : before.homeScore, awayScore: scored ? odds.awayScore : before.awayScore, stopped: odds.stopped };
    const cooldown = cooldownFor({ homeScore: before.homeScore, awayScore: before.awayScore, stopped: before.liveStopped }, after, swing);
    let pause = laterCooldown({ until: before.liveCooldownUntil, reason: before.liveCooldownReason }, cooldown);
    if (cooldown && pause.until === cooldown.until) this.logger.log(`Live betting paused on event ${eventId} (${cooldown.reason}) until ${cooldown.until.toISOString()}`);
    // After a goal: reopen once the bookmaker is taking bets again and the minimum has passed.
    // A price jump, or the bookmaker switching back on, is those prices arriving — not another pause.
    const now = new Date();
    if (goalPauseOver(pause, { hasScore: scored, stopped: odds.stopped, pausesItself: scoreChanged({ homeScore: before.homeScore, awayScore: before.awayScore, stopped: before.liveStopped }, after) }, now)) {
      this.logger.log(`Live betting reopened on event ${eventId}: the prices have caught up with the goal`);
      pause = { until: now, reason: null };
    }
    await this.prisma.event.update({
      where: { id: eventId },
      data: {
        liveOddsAt: new Date(),
        liveStopped: odds.stopped,
        ...(odds.finished ? { period: "FT" } : {}),
        ...(scored ? { homeScore: odds.homeScore, awayScore: odds.awayScore } : {}),
        ...(odds.elapsed !== null ? { elapsed: odds.elapsed } : {}),
        liveCooldownUntil: pause.until,
        liveCooldownReason: pause.reason,
      },
    });
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
   * Returns whether the match-result prices jumped (bigSwing).
   */
  private async upsertLiveMarkets(eventId: string, markets: FeedLiveMarket[]): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.market.findMany({
        where: { eventId },
        select: { id: true, key: true, liveSuspended: true, selections: { select: { id: true, key: true, liveOdds: true } } },
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
      const prices: Array<{ id: string; price: string | null }> = [];
      const added: Prisma.SelectionCreateManyInput[] = [];
      for (const market of markets) {
        const row = byKey.get(market.key);
        if (!row) {
          // A market first seen live has no pre-match price; the live one stands in.
          await tx.market.create({
            data: {
              eventId,
              key: market.key,
              name: market.name,
              sortOrder: market.sortOrder,
              liveSuspended: market.suspended,
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
        const old = new Map(row.selections.map((selection) => [selection.key, selection]));
        for (const selection of market.selections) {
          const price = priceOf(selection.odds);
          const was = old.get(selection.key);
          if (!was) {
            added.push({ marketId: row.id, key: selection.key, name: selection.name, feedOdds: new Prisma.Decimal(price ?? "1.01"), liveOdds: price === null ? null : new Prisma.Decimal(price), sortOrder: selection.sortOrder });
          } else if ((was.liveOdds === null ? null : was.liveOdds.toFixed(2)) !== price) {
            prices.push({ id: was.id, price });
          }
        }
        // An outcome the feed no longer prices (0–0 once a goal is in) loses its live price, so it can't be bet on.
        const priced = new Set(market.selections.map((selection) => selection.key));
        for (const was of row.selections) if (!priced.has(was.key) && was.liveOdds !== null) prices.push({ id: was.id, price: null });
      }
      if (suspend.length) await tx.market.updateMany({ where: { id: { in: suspend } }, data: { liveSuspended: true } });
      if (reopen.length) await tx.market.updateMany({ where: { id: { in: reopen } }, data: { liveSuspended: false } });
      if (added.length) await tx.selection.createMany({ data: added, skipDuplicates: true });
      if (prices.length) {
        // One JSON value rather than arrays: a connection whose first array held only missing prices kept that
        // array's type, and every later price not exactly 4 characters long ("12.00") failed on it.
        await tx.$executeRaw`
          UPDATE selections AS s SET live_odds = v.price, updated_at = NOW()
          FROM json_to_recordset(${JSON.stringify(prices)}::json) AS v(id text, price numeric)
          WHERE s.id = v.id`;
      }
      return swing;
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

function listEnv(name: string): string[] | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}
