import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventStatus } from "@prisma/client";
import Redis from "ioredis";
import { PrismaService } from "../prisma.service";
import { type FetchJson, httpFetchJson } from "./api-football";
import { type FeedGame, parseApiSportsOdds } from "./basketball";
import { saveScoredGame } from "./basketball-sync.service";
import { NFL_LEAGUE_ID, NFL_PROVIDER, type RawNflGame, parseNflGame } from "./nfl";
import { OddsSyncService } from "./odds-sync.service";

const LOCK_KEY = "nfl:sync";
/** Bet365 in API-Sports' American football bookmaker list. */
const DEFAULT_BOOKMAKER = 4;
/** Requests kept in hand each day: below this, prices aren't fetched, only games and results. */
const QUOTA_RESERVE = 12;
/** A game's prices are fetched when it first appears and once more in the last hours before kick-off. */
const LAST_LOOK_MS = 4 * 3_600_000;
/** An NFL game lasts over three hours: its result isn't looked for before this. */
const RESULT_AFTER_MS = 2.5 * 3_600_000;
/** Started games are checked for their result for this long. */
const RESULT_WINDOW_MS = 24 * 3_600_000;

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Keeps the NFL up to date (see nfl.ts), on API-Sports' free plan (100
 * requests a day, yesterday to tomorrow only, so a game is listed from the
 * day before it's played):
 * - every NFL_SYNC_INTERVAL_MS (3 hours): today's and tomorrow's games in
 *   NFL_LEAGUES (two requests), and their prices, one request a game, twice
 *   per game (when it first appears and once in the last 4 hours before
 *   kick-off), while more than QUOTA_RESERVE are left;
 * - every NFL_RESULTS_INTERVAL_MS (30 minutes), only while a game that
 *   started over 2½ hours ago has no result: that day's games again, for the
 *   final scores.
 * A full Sunday (about 14 games) stays near 70 requests.
 */
@Injectable()
export class NflSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NflSyncService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly get?: FetchJson;
  private readonly leagues = new Set((process.env.NFL_LEAGUES ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0));
  private readonly bookmakerId = Number(process.env.NFL_BOOKMAKER) || DEFAULT_BOOKMAKER;
  /** Per game: how many times its prices were fetched, and when last. */
  private readonly priced = new Map<string, { times: number; at: number }>();
  private redis?: Redis;
  private running = false;
  private quotaLeft: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly odds: OddsSyncService,
  ) {
    if (this.leagues.size === 0) this.leagues.add(NFL_LEAGUE_ID);
    const key = process.env.NFL_API_KEY?.trim() || (process.env.API_FOOTBALL_HOST?.includes("rapidapi") ? "" : process.env.API_FOOTBALL_KEY?.trim());
    if (key && process.env.NFL_FEED !== "off") this.get = httpFetchJson(process.env.NFL_API_HOST?.trim() || "v1.american-football.api-sports.io", key, (left) => (this.quotaLeft = left));
  }

  get enabled() {
    return this.get !== undefined;
  }

  onModuleInit() {
    if (!this.get) {
      this.logger.log("NFL is off: set API_FOOTBALL_KEY (direct API-Sports) or NFL_API_KEY");
      return;
    }
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    this.redis.on("error", () => undefined);
    this.redis.connect().catch(() => undefined);
    this.timers.push(setTimeout(() => void this.scheduled("games"), 25_000));
    this.timers.push(setInterval(() => void this.scheduled("games"), Number(process.env.NFL_SYNC_INTERVAL_MS) || 3 * 3_600_000));
    this.timers.push(setInterval(() => void this.scheduled("results"), Number(process.env.NFL_RESULTS_INTERVAL_MS) || 30 * 60_000));
  }

  onModuleDestroy() {
    this.timers.forEach(clearTimeout);
    this.redis?.disconnect();
  }

  private async scheduled(kind: "games" | "results") {
    try {
      await this.withLock<unknown>(() => (kind === "games" ? this.syncGames() : this.syncResults()));
    } catch (error) {
      this.logger.warn(`NFL ${kind} sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T | null> {
    if (this.running) return null;
    const token = `${process.pid}-${Date.now()}`;
    if (this.redis?.status === "ready" && (await this.redis.set(LOCK_KEY, token, "PX", 5 * 60_000, "NX").catch(() => "OK")) !== "OK") return null;
    this.running = true;
    try {
      return await task();
    } finally {
      this.running = false;
      if (this.redis?.status === "ready" && (await this.redis.get(LOCK_KEY).catch(() => null)) === token) await this.redis.del(LOCK_KEY).catch(() => undefined);
    }
  }

  /** Today's and tomorrow's games, and their prices when due. */
  async syncGames(): Promise<{ games: number; priced: number }> {
    let games = 0;
    let priced = 0;
    for (const offset of [0, 1]) {
      for (const item of (await this.get!("/games", { date: day(offset) })).response as RawNflGame[]) {
        const game = parseNflGame(item);
        if (!game || !this.leagues.has(game.leagueId)) continue;
        const id = await this.saveGame(game);
        if (!id) continue;
        games++;
        if (game.status === "upcoming" && this.pricesDue(game) && (await this.priceGame(id, game))) priced++;
      }
    }
    return { games, priced };
  }

  /** Twice per game: when it first appears, and once in its last hours before kick-off; never into the day's reserve. */
  private pricesDue(game: FeedGame): boolean {
    if (this.quotaLeft !== null && this.quotaLeft <= QUOTA_RESERVE) return false;
    const seen = this.priced.get(game.externalId);
    if (!seen) return true;
    return seen.times < 2 && game.startsAt.getTime() - Date.now() < LAST_LOOK_MS && Date.now() - seen.at > LAST_LOOK_MS / 2;
  }

  private async priceGame(eventId: string, game: FeedGame): Promise<boolean> {
    const seen = this.priced.get(game.externalId);
    this.priced.set(game.externalId, { times: (seen?.times ?? 0) + 1, at: Date.now() });
    if (this.priced.size > 2_000) for (const [id, entry] of this.priced) if (Date.now() - entry.at > 2 * 86_400_000) this.priced.delete(id);
    const [raw] = (await this.get!("/odds", { game: game.externalId })).response as Array<Parameters<typeof parseApiSportsOdds>[0]>;
    const markets = raw ? parseApiSportsOdds(raw, game.home, game.away, this.bookmakerId) : [];
    if (markets.length === 0) return false;
    await this.odds.upsertMarkets(eventId, markets);
    return true;
  }

  /** Final scores for the days with a game that should be over and has none yet. */
  async syncResults(): Promise<number> {
    const now = Date.now();
    const waiting = await this.prisma.event.findMany({
      where: { provider: NFL_PROVIDER, status: { in: [EventStatus.UPCOMING, EventStatus.LIVE] }, startsAt: { lt: new Date(now - RESULT_AFTER_MS), gt: new Date(now - RESULT_WINDOW_MS) } },
      select: { startsAt: true },
    });
    let saved = 0;
    for (const date of new Set(waiting.map((event) => event.startsAt.toISOString().slice(0, 10)))) {
      for (const item of (await this.get!("/games", { date })).response as RawNflGame[]) {
        const game = parseNflGame(item);
        if (game && this.leagues.has(game.leagueId) && (await this.saveGame(game, false))) saved++;
      }
    }
    return saved;
  }

  /** Saves a game and, once it's over, its final score (see saveScoredGame). Returns the game's id. */
  saveGame(game: FeedGame, create = true): Promise<string | null> {
    return saveScoredGame(this.prisma, NFL_PROVIDER, "nfl", game, create);
  }
}
