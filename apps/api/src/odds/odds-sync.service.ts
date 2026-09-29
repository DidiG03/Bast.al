import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventStatus, Prisma } from "@prisma/client";
import Redis from "ioredis";
import { PrismaService } from "../prisma.service";
import { ApiFootballClient, FeedFixture, FeedLiveMarket, FeedMarket, httpFetchJson, parseLiveOdds, parseMarkets } from "./api-football";
import { mockFetchJson } from "./mock-feed";

/**
 * Leagues synced when API_FOOTBALL_LEAGUES isn't set: the top five European
 * leagues, the three UEFA club competitions, and the World Cup, Euros and
 * Nations League. Every league from the countries in API_FOOTBALL_COUNTRIES
 * (Albania by default) is synced as well.
 */
const DEFAULT_LEAGUES = [39, 140, 135, 78, 61, 2, 3, 848, 1, 4, 5];
const DEFAULT_COUNTRIES = ["Albania"];
/** API-Football's id for Bet365, the bookmaker whose prices we start from. */
const DEFAULT_BOOKMAKER = 8;

export type FeedMode = "api-football" | "mock" | "off";

type SyncSummary = { events: number; markets: number; live: number };

const LOCK_KEY = "bastal:odds-sync";

/**
 * Keeps events, markets and feed prices up to date:
 * - every ODDS_SYNC_INTERVAL_MS (10 minutes by default): fixtures and
 *   pre-match odds for today and the next ODDS_SYNC_DAYS - 1 days;
 * - every ODDS_LIVE_INTERVAL_MS (30 seconds): scores for matches that are
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
  private readonly leagues: Set<number>;
  private readonly countries: Set<string>;
  private readonly days: number;

  constructor(private readonly prisma: PrismaService) {
    const key = process.env.API_FOOTBALL_KEY?.trim();
    if (key) {
      this.mode = "api-football";
      this.client = new ApiFootballClient(httpFetchJson(process.env.API_FOOTBALL_HOST?.trim() || "v3.football.api-sports.io", key));
    } else if (process.env.ODDS_FEED_MOCK === "true") {
      this.mode = "mock";
      this.client = new ApiFootballClient(mockFetchJson());
    } else {
      this.mode = "off";
    }
    this.bookmakerId = Number(process.env.API_FOOTBALL_BOOKMAKER) || DEFAULT_BOOKMAKER;
    this.leagues = new Set(listEnv("API_FOOTBALL_LEAGUES")?.map(Number).filter(Number.isInteger) ?? DEFAULT_LEAGUES);
    this.countries = new Set((listEnv("API_FOOTBALL_COUNTRIES") ?? DEFAULT_COUNTRIES).map((c) => c.toLowerCase()));
    this.days = Math.min(7, Math.max(1, Number(process.env.ODDS_SYNC_DAYS) || 3));
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
    const liveEvery = Number(process.env.ODDS_LIVE_INTERVAL_MS) || 30_000;
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
    const full = await this.withLock(() => this.syncFull());
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

  private wanted(fixture: FeedFixture): boolean {
    return this.mode === "mock" || this.leagues.has(fixture.leagueId) || this.countries.has(fixture.country.toLowerCase());
  }

  private async syncFull(): Promise<SyncSummary> {
    const client = this.client!;
    let events = 0;
    let markets = 0;
    for (let day = 0; day < this.days; day++) {
      const date = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
      const fixtures = (await client.fixturesByDate(date)).filter((f) => this.wanted(f));
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
    }
    const live = await this.syncLive();
    await this.recordStatus(`Synced ${events} matches and ${markets} markets`, true);
    return { events, markets, live };
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
    return updated;
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
      }
    });
  }

  private async recordStatus(status: string, succeeded: boolean) {
    const data = { oddsSyncStatus: status.slice(0, 300), ...(succeeded ? { oddsSyncedAt: new Date() } : {}) };
    await this.prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data }).catch(() => undefined);
  }
}

function listEnv(name: string): string[] | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}
