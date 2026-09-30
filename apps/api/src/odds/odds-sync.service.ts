import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { BetStatus, EventStatus, Prisma } from "@prisma/client";
import Redis from "ioredis";
import { PrismaService } from "../prisma.service";
import { ApiFootballClient, FeedFixture, FeedLeague, FeedLiveMarket, FeedMarket, httpFetchJson, parseLiveOdds, parseMarkets } from "./api-football";
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
  // The rest of Europe's top divisions
  88, 94, 203, 144, 179, 197, 207, 218, 119, 113, 103, 106, 210, 286, 283, 345, 333,
  // UEFA club competitions
  2, 3, 848, 531,
  // National teams: tournaments, qualifiers and friendlies
  1, 4, 5, 6, 9, 10, 32, 34, 29, 30, 31, 960,
  // Americas
  253, 71, 128, 262, 13, 11,
  // Asia and Oceania
  307, 98, 292, 188, 17,
];
const DEFAULT_COUNTRIES = ["Albania", "Kosovo"];

/**
 * How often each day's fixtures and pre-match prices are refreshed. Prices a
 * few days out barely move, so they're fetched rarely; that keeps a wide
 * league list inside API-Football's Pro plan (7,500 requests a day).
 */
const PREMATCH_REFRESH_MS = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
/** Below this many requests left today, only today's matches are refreshed. */
const QUOTA_RESERVE = Number(process.env.API_FOOTBALL_QUOTA_RESERVE) || 600;
/** API-Football's id for Bet365, the bookmaker whose prices we start from. */
const DEFAULT_BOOKMAKER = 8;

export type FeedMode = "api-football" | "mock" | "off";

type SyncSummary = { events: number; markets: number; live: number };

/** Which competitions are synced: league ids, plus countries whose every league is. */
export type CompetitionChoice = { leagues: number[]; countries: string[] };

const LOCK_KEY = "bastal:odds-sync";
/** Markets settled from match statistics rather than the score. */
const STATS_MARKET_PREFIXES = ["corners_", "home_corners_", "away_corners_", "cards_", "home_cards_", "away_cards_"];

/**
 * Keeps events, markets and feed prices up to date:
 * - every ODDS_SYNC_INTERVAL_MS (10 minutes by default) it checks which days
 *   are due (see PREMATCH_REFRESH_MS) and fetches their fixtures and pre-match
 *   odds, for today and the next ODDS_SYNC_DAYS - 1 days;
 * - every ODDS_LIVE_INTERVAL_MS (45 seconds): scores for matches that are
 *   live or should have kicked off, only while there are any, plus in-play
 *   odds for the live ones (one request for all of them).
 * A Redis lock makes sure only one API instance syncs at a time.
 */
@Injectable()
export class OddsSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OddsSyncService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private redis?: Redis;
  private running = false;
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
  private leaguesChecked = false;
  /** When each day was last refreshed, if Redis is down. */
  private readonly refreshedAt = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {
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
    this.days = Math.min(7, Math.max(1, Number(process.env.ODDS_SYNC_DAYS) || 5));
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
    const liveEvery = Number(process.env.ODDS_LIVE_INTERVAL_MS) || 45_000;
    // First full sync shortly after boot, then on the interval.
    this.timers.push(setTimeout(() => void this.scheduled("full"), 5_000));
    this.timers.push(setInterval(() => void this.scheduled("full"), fullEvery));
    this.timers.push(setInterval(() => void this.scheduled("live"), liveEvery));
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
      await this.withLock<unknown>(() => (kind === "full" ? this.syncFull() : this.syncLive()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Odds ${kind} sync failed: ${message}`);
      if (kind === "full") await this.recordStatus(`Failed: ${message}`, false);
    }
  }

  /** Runs `task` unless another sync (here or on another instance) is running. */
  private async withLock<T>(task: () => Promise<T>): Promise<T | null> {
    if (this.running) return null;
    const token = `${process.pid}-${Date.now()}`;
    let locked = true;
    if (this.redis?.status === "ready") {
      locked = (await this.redis.set(LOCK_KEY, token, "PX", 5 * 60_000, "NX").catch(() => "OK")) === "OK";
    }
    if (!locked) return null;
    this.running = true;
    try {
      return await task();
    } finally {
      this.running = false;
      if (this.redis?.status === "ready") {
        const current = await this.redis.get(LOCK_KEY).catch(() => null);
        if (current === token) await this.redis.del(LOCK_KEY).catch(() => undefined);
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
      const listed = new Set(
        (await this.prisma.event.findMany({ where: { provider: this.provider(), externalId: { in: all.map((f) => f.externalId) } }, select: { externalId: true } })).map((e) => e.externalId!),
      );
      const fixtures = all.filter((f) => this.wanted(f, listed));
      const ids = new Map<string, string>();
      for (const fixture of fixtures) ids.set(fixture.externalId, await this.upsertEvent(fixture));
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
    const live = await this.syncLive();
    await this.syncStats();
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

  /** Updates scores and status for matches that are live or should have started. */
  private async syncLive(): Promise<number> {
    const client = this.client!;
    const provider = this.provider();
    const tracked = await this.prisma.event.findMany({
      where: { provider, externalId: { not: null }, OR: [{ status: EventStatus.LIVE }, { status: EventStatus.UPCOMING, startsAt: { lte: new Date() } }] },
      select: { externalId: true },
    });
    if (tracked.length === 0) return 0;
    const live = await client.liveFixtures();
    const seen = new Set(live.map((f) => f.externalId));
    const trackedIds = new Set(tracked.map((e) => e.externalId!));
    // Matches that dropped off the live list have finished (or been stopped): fetch them by id for the final state.
    const missing = [...trackedIds].filter((id) => !seen.has(id));
    const finished: FeedFixture[] = [];
    for (let i = 0; i < missing.length; i += 20) finished.push(...(await client.fixturesByIds(missing.slice(i, i + 20))));
    let updated = 0;
    for (const fixture of [...live.filter((f) => trackedIds.has(f.externalId)), ...finished]) {
      await this.prisma.event.update({
        where: { provider_externalId: { provider, externalId: fixture.externalId } },
        data: { status: fixture.status, elapsed: fixture.elapsed, homeScore: fixture.homeScore, awayScore: fixture.awayScore, syncedAt: new Date() },
      });
      await this.recordResult(provider, fixture);
      updated++;
    }
    await this.syncLiveOdds();
    if (finished.length > 0) await this.syncStats();
    return updated;
  }

  /**
   * Corners and cards for finished matches, which the corner and card
   * markets settle on. Only matches with open bets on those markets are
   * asked about (one request each), at most every 10 minutes and for 3 days
   * after kick-off, since the feed can take a while to publish statistics.
   * A match that went to extra time is skipped: its statistics include extra
   * time, so Super Admin enters the 90-minute numbers by hand.
   */
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
    let priced = 0;
    for (const raw of feed) {
      const event = byExternal.get(String(raw.fixture.id));
      if (!event) continue;
      const odds = parseLiveOdds(raw, event.homeTeam ?? event.name, event.awayTeam ?? "");
      await this.upsertLiveMarkets(event.id, odds.markets);
      await this.prisma.event.update({ where: { id: event.id }, data: { liveOddsAt: new Date(), liveStopped: odds.stopped } });
      priced++;
    }
    return priced;
  }

  private provider(): string {
    return this.mode === "mock" ? "mock" : "api-football";
  }

  private async upsertEvent(fixture: FeedFixture): Promise<string> {
    const data = {
      name: `${fixture.homeTeam} v ${fixture.awayTeam}`,
      league: fixture.league,
      country: fixture.country,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      startsAt: fixture.startsAt,
      status: fixture.status,
      elapsed: fixture.elapsed,
      homeScore: fixture.homeScore,
      awayScore: fixture.awayScore,
      syncedAt: new Date(),
    };
    const provider = this.provider();
    const event = await this.prisma.event.upsert({
      where: { provider_externalId: { provider, externalId: fixture.externalId } },
      create: { ...data, provider, externalId: fixture.externalId },
      // hidden and suspended are Super Admin's and never overwritten by the feed.
      update: data,
      select: { id: true },
    });
    await this.recordResult(provider, fixture);
    return event.id;
  }

  /**
   * Saves the score bets settle on once a match has finished. A result Super
   * Admin corrected by hand is never overwritten. SettlementService pays the
   * bets out from here.
   */
  private async recordResult(provider: string, fixture: FeedFixture) {
    if (!fixture.result) return;
    await this.prisma.event.updateMany({
      where: { provider, externalId: fixture.externalId, OR: [{ resultSource: null }, { resultSource: "feed" }] },
      data: {
        resultHome: fixture.result.home,
        resultAway: fixture.result.away,
        resultHalfHome: fixture.halfTime?.home ?? null,
        resultHalfAway: fixture.halfTime?.away ?? null,
        extraTime: fixture.extraTime,
        resultSource: "feed",
      },
    });
  }

  /**
   * Saves feed prices. Selections are never deleted, because bets point at
   * them; one the feed stops pricing simply keeps its last price.
   */
  private async upsertMarkets(eventId: string, markets: FeedMarket[]) {
    for (const market of markets) {
      await this.prisma.$transaction(async (tx) => {
        const row = await tx.market.upsert({
          where: { eventId_key: { eventId, key: market.key } },
          create: { eventId, key: market.key, name: market.name, sortOrder: market.sortOrder },
          update: { name: market.name, sortOrder: market.sortOrder },
          select: { id: true },
        });
        for (const selection of market.selections) {
          const feedOdds = new Prisma.Decimal(selection.odds.toFixed(2));
          // Read the prior price first so we only log a snapshot on an actual
          // change — this is a sparse "change log" for the movement chart, not
          // a row every 10 minutes regardless of whether the price moved.
          const existing = await tx.selection.findUnique({
            where: { marketId_key: { marketId: row.id, key: selection.key } },
            select: { id: true, feedOdds: true },
          });
          const saved = await tx.selection.upsert({
            where: { marketId_key: { marketId: row.id, key: selection.key } },
            create: { marketId: row.id, key: selection.key, name: selection.name, feedOdds, sortOrder: selection.sortOrder },
            update: { name: selection.name, feedOdds, sortOrder: selection.sortOrder },
            select: { id: true },
          });
          if (!existing || !existing.feedOdds.equals(feedOdds)) {
            await tx.oddsSnapshot.create({ data: { selectionId: saved.id, price: feedOdds } });
          }
        }
      });
    }
  }

  /** Saves in-play prices; markets the feed didn't send this time are suspended. */
  private async upsertLiveMarkets(eventId: string, markets: FeedLiveMarket[]) {
    await this.prisma.$transaction(async (tx) => {
      await tx.market.updateMany({ where: { eventId, key: { notIn: markets.map((m) => m.key) } }, data: { liveSuspended: true } });
      for (const market of markets) {
        const row = await tx.market.upsert({
          where: { eventId_key: { eventId, key: market.key } },
          create: { eventId, key: market.key, name: market.name, sortOrder: market.sortOrder, liveSuspended: market.suspended },
          update: { liveSuspended: market.suspended },
          select: { id: true },
        });
        for (const selection of market.selections) {
          const liveOdds = selection.odds > 1 ? new Prisma.Decimal(selection.odds.toFixed(2)) : null;
          await tx.selection.upsert({
            where: { marketId_key: { marketId: row.id, key: selection.key } },
            // A market first seen live has no pre-match price; the live one stands in.
            create: { marketId: row.id, key: selection.key, name: selection.name, feedOdds: liveOdds ?? new Prisma.Decimal(1.01), liveOdds, sortOrder: selection.sortOrder },
            update: { liveOdds },
          });
        }
        // An outcome the feed no longer prices (0–0 once a goal is in) loses its live price, so it can't be bet on.
        await tx.selection.updateMany({ where: { marketId: row.id, key: { notIn: market.selections.map((s) => s.key) } }, data: { liveOdds: null } });
      }
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
