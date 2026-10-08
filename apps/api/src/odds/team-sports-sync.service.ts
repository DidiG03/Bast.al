import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventStatus, Prisma } from "@prisma/client";
import Redis from "ioredis";
import { PrismaService } from "../prisma.service";
import { type FeedMarket, type FetchJson, httpFetchJson } from "./api-football";
import { HANDBALL_PROVIDER, type HandballGame, parseHandballGame, parseHandballOdds } from "./handball";
import { OddsSyncService, movedLater } from "./odds-sync.service";
import { type RawGameOdds, type RawTeamGame, type TeamGame } from "./team-sports";
import { VOLLEYBALL_PROVIDER, type VolleyballGame, parseVolleyballGame, parseVolleyballOdds } from "./volleyball";

/** Requests kept in hand each day: below this, prices aren't fetched, only games and results. */
const QUOTA_RESERVE = 12;
/** A game's prices are fetched when it first appears and once more in the last hours before it starts. */
const LAST_LOOK_MS = 4 * 3_600_000;
/** Started games are checked for their result for this long. */
const RESULT_WINDOW_MS = 24 * 3_600_000;
/** Bet365 in both APIs' bookmaker lists. */
const DEFAULT_BOOKMAKER = 4;

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** What a sport's game becomes in the database: its score now, and its result once it's over. */
type Stored = {
  /** The score shown now: sets won, or goals. */
  shown: { home: number; away: number } | null;
  /** The result bets settle on, once it's over. */
  result: { home: number; away: number } | null;
  half: { home: number; away: number } | null;
  /** Kept in Event.fightResult: a volleyball match's set points. */
  detail: Prisma.InputJsonValue | null;
};

type SportConfig<G extends TeamGame> = {
  sport: string;
  provider: string;
  label: string;
  host: string;
  hostEnv: string;
  keyEnv: string;
  feedEnv: string;
  leaguesEnv: string;
  bookmakerEnv: string;
  intervalEnv: string;
  resultsEnv: string;
  defaultLeagues: number[];
  parseGame: (raw: RawTeamGame) => G | null;
  parseOdds: (raw: RawGameOdds, home: string, away: string, bookmakerId: number) => FeedMarket[];
  stored: (game: G) => Stored;
};

/**
 * Keeps one of the API-Sports team sports up to date (volleyball, handball),
 * on API-Sports' free plan (100 requests a day per sport, yesterday to
 * tomorrow only), the same way as basketball:
 * - every {SPORT}_SYNC_INTERVAL_MS (3 hours): today's and tomorrow's games in
 *   {SPORT}_LEAGUES (two requests), and their prices, one request a game,
 *   twice per game (when it first appears and once in the last 4 hours
 *   before it starts), while more than QUOTA_RESERVE requests are left;
 * - every {SPORT}_RESULTS_INTERVAL_MS (30 minutes), only while a game that
 *   has started has no result: that day's games again, for the results.
 * Bets close when a game starts: there are no live prices.
 */
abstract class TeamSportSync<G extends TeamGame> implements OnModuleInit, OnModuleDestroy {
  protected readonly logger: Logger;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly get?: FetchJson;
  private readonly leagues: Set<number>;
  private readonly bookmakerId: number;
  /** Per game: how many times its prices were fetched, and when last. */
  private readonly priced = new Map<string, { times: number; at: number }>();
  private redis?: Redis;
  private running = false;
  quotaLeft: number | null = null;

  protected constructor(
    private readonly config: SportConfig<G>,
    private readonly prisma: PrismaService,
    private readonly odds: OddsSyncService,
  ) {
    this.logger = new Logger(`${config.label}SyncService`);
    const listed = (process.env[config.leaguesEnv] ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
    this.leagues = new Set(listed.length > 0 ? listed : config.defaultLeagues);
    this.bookmakerId = Number(process.env[config.bookmakerEnv]) || DEFAULT_BOOKMAKER;
    const key = process.env[config.keyEnv]?.trim() || (process.env.API_FOOTBALL_HOST?.includes("rapidapi") ? "" : process.env.API_FOOTBALL_KEY?.trim());
    if (key && process.env[config.feedEnv] !== "off") this.get = httpFetchJson(process.env[config.hostEnv]?.trim() || config.host, key, (left) => (this.quotaLeft = left));
  }

  get enabled() {
    return this.get !== undefined;
  }

  onModuleInit() {
    if (!this.get) {
      this.logger.log(`${this.config.label} is off: set API_FOOTBALL_KEY (direct API-Sports) or ${this.config.keyEnv}`);
      return;
    }
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    this.redis.on("error", () => undefined);
    this.redis.connect().catch(() => undefined);
    this.timers.push(setTimeout(() => void this.scheduled("games"), 25_000));
    this.timers.push(setInterval(() => void this.scheduled("games"), Number(process.env[this.config.intervalEnv]) || 3 * 3_600_000));
    this.timers.push(setInterval(() => void this.scheduled("results"), Number(process.env[this.config.resultsEnv]) || 30 * 60_000));
  }

  onModuleDestroy() {
    this.timers.forEach(clearTimeout);
    this.redis?.disconnect();
  }

  private async scheduled(kind: "games" | "results") {
    try {
      await this.withLock<unknown>(() => (kind === "games" ? this.syncGames() : this.syncResults()));
    } catch (error) {
      this.logger.warn(`${this.config.label} ${kind} sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T | null> {
    if (this.running) return null;
    const lockKey = `${this.config.sport}:sync`;
    const token = `${process.pid}-${Date.now()}`;
    if (this.redis?.status === "ready" && (await this.redis.set(lockKey, token, "PX", 5 * 60_000, "NX").catch(() => "OK")) !== "OK") return null;
    this.running = true;
    try {
      return await task();
    } finally {
      this.running = false;
      if (this.redis?.status === "ready" && (await this.redis.get(lockKey).catch(() => null)) === token) await this.redis.del(lockKey).catch(() => undefined);
    }
  }

  /** Today's and tomorrow's games in the chosen leagues, and their prices when due. */
  async syncGames(): Promise<{ games: number; priced: number }> {
    let games = 0;
    let priced = 0;
    for (let offset = 0; offset < 2; offset++) {
      for (const item of (await this.get!("/games", { date: day(offset) })).response as RawTeamGame[]) {
        const game = this.config.parseGame(item);
        if (!game || !this.leagues.has(game.leagueId)) continue;
        const id = await this.saveGame(game);
        if (!id) continue;
        games++;
        if (game.status === "upcoming" && this.pricesDue(game) && (await this.priceGame(id, game))) priced++;
      }
    }
    return { games, priced };
  }

  /** Twice per game: when it first appears, and once in its last hours before it starts; never into the day's reserve. */
  private pricesDue(game: G): boolean {
    if (this.quotaLeft !== null && this.quotaLeft <= QUOTA_RESERVE) return false;
    const seen = this.priced.get(game.externalId);
    if (!seen) return true;
    return seen.times < 2 && game.startsAt.getTime() - Date.now() < LAST_LOOK_MS && Date.now() - seen.at > LAST_LOOK_MS / 2;
  }

  private async priceGame(eventId: string, game: G): Promise<boolean> {
    const seen = this.priced.get(game.externalId);
    this.priced.set(game.externalId, { times: (seen?.times ?? 0) + 1, at: Date.now() });
    if (this.priced.size > 2_000) for (const [id, entry] of this.priced) if (Date.now() - entry.at > 2 * 86_400_000) this.priced.delete(id);
    const [raw] = (await this.get!("/odds", { game: game.externalId })).response as RawGameOdds[];
    const markets = raw ? this.config.parseOdds(raw, game.home, game.away, this.bookmakerId) : [];
    if (markets.length === 0) return false;
    await this.odds.upsertMarkets(eventId, markets);
    return true;
  }

  /** Results for the days with a started game that has none yet. */
  async syncResults(): Promise<number> {
    const now = Date.now();
    const waiting = await this.prisma.event.findMany({
      where: { provider: this.config.provider, status: { in: [EventStatus.UPCOMING, EventStatus.LIVE] }, startsAt: { lt: new Date(now), gt: new Date(now - RESULT_WINDOW_MS) } },
      select: { startsAt: true },
    });
    let saved = 0;
    for (const date of new Set(waiting.map((event) => event.startsAt.toISOString().slice(0, 10)))) {
      for (const item of (await this.get!("/games", { date })).response as RawTeamGame[]) {
        const game = this.config.parseGame(item);
        if (game && this.leagues.has(game.leagueId) && (await this.saveGame(game, false))) saved++;
      }
    }
    return saved;
  }

  /**
   * Saves a game and, once it's over, its result. A result that changes after
   * it was settled is marked, so settlement settles the game's bets again; a
   * result Super Admin set by hand is left alone. Returns the game's id.
   */
  async saveGame(game: G, create = true): Promise<string | null> {
    const { provider, sport } = this.config;
    const where = { provider_externalId: { provider, externalId: game.externalId } };
    const before = await this.prisma.event.findUnique({
      where,
      select: { id: true, status: true, startsAt: true, resultHome: true, resultAway: true, resultHalfHome: true, resultHalfAway: true, resultSource: true, fightResult: true },
    });
    if ((!before && !create) || before?.resultSource === "manual") return before?.id ?? null;
    const stored = this.config.stored(game);
    const status =
      game.status === "cancelled" ? EventStatus.CANCELLED
      : game.status === "postponed" ? EventStatus.POSTPONED
      : stored.result ? EventStatus.COMPLETED
      : game.status === "upcoming" ? EventStatus.UPCOMING
      : EventStatus.LIVE;
    const changed =
      before?.status === EventStatus.COMPLETED &&
      stored.result !== null &&
      (before.resultHome !== stored.result.home ||
        before.resultAway !== stored.result.away ||
        (stored.half !== null && (before.resultHalfHome !== stored.half.home || before.resultHalfAway !== stored.half.away)) ||
        (stored.detail !== null && before.fightResult !== null && JSON.stringify(before.fightResult) !== JSON.stringify(stored.detail)));
    const data = {
      name: `${game.home} v ${game.away}`,
      league: game.league,
      country: game.country,
      homeTeam: game.home,
      awayTeam: game.away,
      startsAt: game.startsAt,
      status,
      syncedAt: new Date(),
      ...(stored.shown ? { homeScore: stored.shown.home, awayScore: stored.shown.away } : {}),
      ...(stored.result
        ? {
            resultHome: stored.result.home,
            resultAway: stored.result.away,
            ...(stored.half ? { resultHalfHome: stored.half.home, resultHalfAway: stored.half.away } : {}),
            ...(stored.detail ? { fightResult: stored.detail } : {}),
            resultSource: "feed",
            ...(before?.status !== EventStatus.COMPLETED ? { finishedAt: new Date() } : {}),
          }
        : {}),
      ...(changed ? { resultChangedAt: new Date() } : {}),
    };
    // Moved days later, like a football match: bets placed for the old date are refunded.
    const rescheduled = movedLater(before?.startsAt, game.startsAt);
    const event = await this.prisma.event.upsert({ where, create: { provider, externalId: game.externalId, sport, ...data }, update: { ...data, ...(rescheduled ? { rescheduledAt: new Date() } : {}) }, select: { id: true } });
    return event.id;
  }
}

/** Men's and women's top leagues and the European cups and championships (API-Sports' volleyball league ids). */
export const DEFAULT_VOLLEYBALL_LEAGUES = [
  // CEV Champions League, CEV Cup (men and women), Nations League, World and European Championships, Olympics.
  248, 251, 255, 256, 183, 184, 185, 186, 244, 245, 189, 190,
  // Italy SuperLega, Serie A1 Women, Coppa Italia A1; Poland PlusLiga, TAURON Liga; Turkey Efeler Ligi, Sultanlar Ligi, Turkish Cup.
  97, 89, 93, 92, 113, 120, 172, 174, 170,
  // Russia Superleague (men, women), Russia Cup; Brazil SuperLiga (men, women); Germany 1. Bundesliga; France Ligue A (men, women); Greece A1; Japan SV.League (men, women).
  132, 133, 134, 25, 24, 66, 63, 65, 77, 252, 253,
];

/** Men's and women's top leagues and the European cups and championships (API-Sports' handball league ids). */
export const DEFAULT_HANDBALL_LEAGUES = [
  // EHF Champions League, European League (men and women), European and World Championships, Olympics.
  131, 132, 145, 146, 177, 133, 153, 154, 155, 156,
  // Germany Bundesliga, DHB Pokal, Bundesliga Women; France Starligue, Division 1 Women; Spain Liga ASOBAL; Denmark Herre Handbold Ligaen, Kvindeligaen.
  39, 41, 42, 34, 29, 103, 23, 25,
  // Hungary NB I (men, women); Poland Superliga; Norway REMA 1000-ligaen (men, women); Sweden Handbollsligan; Portugal Andebol 1.
  49, 50, 78, 75, 76, 113, 84,
  // Slovenia 1. NLB Liga; Croatia Premijer liga; North Macedonia Superleague; Romania Liga Nationala (men, women); SEHA Liga; MOL Liga Women.
  100, 10, 37, 87, 88, 136, 140,
];

@Injectable()
export class VolleyballSyncService extends TeamSportSync<VolleyballGame> {
  constructor(prisma: PrismaService, odds: OddsSyncService) {
    super(
      {
        sport: "volleyball",
        provider: VOLLEYBALL_PROVIDER,
        label: "Volleyball",
        host: "v1.volleyball.api-sports.io",
        hostEnv: "VOLLEYBALL_API_HOST",
        keyEnv: "VOLLEYBALL_API_KEY",
        feedEnv: "VOLLEYBALL_FEED",
        leaguesEnv: "VOLLEYBALL_LEAGUES",
        bookmakerEnv: "VOLLEYBALL_BOOKMAKER",
        intervalEnv: "VOLLEYBALL_SYNC_INTERVAL_MS",
        resultsEnv: "VOLLEYBALL_RESULTS_INTERVAL_MS",
        defaultLeagues: DEFAULT_VOLLEYBALL_LEAGUES,
        parseGame: parseVolleyballGame,
        parseOdds: parseVolleyballOdds,
        // Sets won, and every set's points for the points markets.
        stored: (game) => ({ shown: game.score ?? game.live, result: game.score, half: null, detail: game.sets as unknown as Prisma.InputJsonValue | null }),
      },
      prisma,
      odds,
    );
  }
}

@Injectable()
export class HandballSyncService extends TeamSportSync<HandballGame> {
  constructor(prisma: PrismaService, odds: OddsSyncService) {
    super(
      {
        sport: "handball",
        provider: HANDBALL_PROVIDER,
        label: "Handball",
        host: "v1.handball.api-sports.io",
        hostEnv: "HANDBALL_API_HOST",
        keyEnv: "HANDBALL_API_KEY",
        feedEnv: "HANDBALL_FEED",
        leaguesEnv: "HANDBALL_LEAGUES",
        bookmakerEnv: "HANDBALL_BOOKMAKER",
        intervalEnv: "HANDBALL_SYNC_INTERVAL_MS",
        resultsEnv: "HANDBALL_RESULTS_INTERVAL_MS",
        defaultLeagues: DEFAULT_HANDBALL_LEAGUES,
        parseGame: parseHandballGame,
        parseOdds: parseHandballOdds,
        // The 60-minute score and the first half's, as a football match keeps them.
        stored: (game) => ({ shown: game.score ?? game.live, result: game.score, half: game.half, detail: null }),
      },
      prisma,
      odds,
    );
  }
}
