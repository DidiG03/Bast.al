import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventStatus } from "@prisma/client";
import Redis from "ioredis";
import { PrismaService } from "../prisma.service";
import { type FetchJson, httpFetchJson } from "./api-football";
import { BASKETBALL_PROVIDER, type FeedGame, NBA_LEAGUE_ID, type OddsApiEvent, type RawGame, parseApiSportsOdds, parseGame, parseOddsApiEvent, teamKey } from "./basketball";
import { OddsSyncService, movedLater } from "./odds-sync.service";

const LOCK_KEY = "basketball:sync";
/** NBA, Euroleague, ABA League, and the top leagues of Italy, Spain, Turkey, Greece, France, Germany and Kosovo. */
export const DEFAULT_BASKETBALL_LEAGUES = [NBA_LEAGUE_ID, 120, 198, 52, 117, 104, 45, 2, 40, 59];
/** Bet365 in API-Sports' basketball bookmaker list. */
const DEFAULT_BOOKMAKER = 4;
/** Requests kept in hand each day: below this, prices aren't fetched, only games and results. */
const QUOTA_RESERVE = 12;
/** A game's prices are fetched when it first appears and once more in the last hours before tip-off. */
const LAST_LOOK_MS = 4 * 3_600_000;
/** Started games are checked for their result for this long. */
const RESULT_WINDOW_MS = 24 * 3_600_000;
/** An NBA game from The Odds API is the same game when the teams match and tip-off is this close. */
const SAME_GAME_MS = 6 * 3_600_000;

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Keeps basketball up to date (see basketball.ts), on API-Sports' free plan
 * (100 requests a day, yesterday to tomorrow only) and The Odds API's free
 * plan (500 credits a month):
 * - every BASKETBALL_SYNC_INTERVAL_MS (3 hours): today's and tomorrow's games
 *   in BASKETBALL_LEAGUES (two requests), and the prices of the European ones,
 *   one request a game, twice per game (when it first appears and once in the
 *   last 4 hours before tip-off), while more than QUOTA_RESERVE are left;
 * - every NBA_ODDS_INTERVAL_MS (6 hours), with ODDS_API_KEY: every NBA game's
 *   prices in one request (3 credits) while one of ours is coming up, about
 *   360 credits a month (see syncNbaOdds);
 * - every BASKETBALL_RESULTS_INTERVAL_MS (30 minutes), only while a game that
 *   has started has no result: that day's games again, for the final scores.
 */
@Injectable()
export class BasketballSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BasketballSyncService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly get?: FetchJson;
  private readonly oddsApiKey = process.env.ODDS_API_KEY?.trim() || null;
  private readonly leagues = new Set((process.env.BASKETBALL_LEAGUES ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0));
  private readonly bookmakerId = Number(process.env.BASKETBALL_BOOKMAKER) || DEFAULT_BOOKMAKER;
  private readonly days = Math.min(14, Math.max(1, Number(process.env.BASKETBALL_DAYS) || 2));
  /** Per game: how many times its prices were fetched, and when last. */
  private readonly priced = new Map<string, { times: number; at: number }>();
  private redis?: Redis;
  private running = false;
  private quotaLeft: number | null = null;
  /** The Odds API's credits left this month, from its last answer. */
  oddsApiLeft: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly odds: OddsSyncService,
  ) {
    if (this.leagues.size === 0) DEFAULT_BASKETBALL_LEAGUES.forEach((id) => this.leagues.add(id));
    const key = process.env.BASKETBALL_API_KEY?.trim() || (process.env.API_FOOTBALL_HOST?.includes("rapidapi") ? "" : process.env.API_FOOTBALL_KEY?.trim());
    if (key && process.env.BASKETBALL_FEED !== "off") this.get = httpFetchJson(process.env.BASKETBALL_API_HOST?.trim() || "v1.basketball.api-sports.io", key, (left) => (this.quotaLeft = left));
  }

  get enabled() {
    return this.get !== undefined;
  }

  onModuleInit() {
    if (!this.get) {
      this.logger.log("Basketball is off: set API_FOOTBALL_KEY (direct API-Sports) or BASKETBALL_API_KEY");
      return;
    }
    if (!this.oddsApiKey) this.logger.log("NBA prices are off: set ODDS_API_KEY (the-odds-api.com). NBA games are listed without prices until then.");
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    this.redis.on("error", () => undefined);
    this.redis.connect().catch(() => undefined);
    this.timers.push(setTimeout(() => void this.scheduled("games"), 15_000));
    this.timers.push(setInterval(() => void this.scheduled("games"), Number(process.env.BASKETBALL_SYNC_INTERVAL_MS) || 3 * 3_600_000));
    this.timers.push(setInterval(() => void this.scheduled("results"), Number(process.env.BASKETBALL_RESULTS_INTERVAL_MS) || 30 * 60_000));
    if (this.oddsApiKey) {
      this.timers.push(setTimeout(() => void this.scheduled("nba"), 45_000));
      this.timers.push(setInterval(() => void this.scheduled("nba"), Number(process.env.NBA_ODDS_INTERVAL_MS) || 6 * 3_600_000));
    }
  }

  onModuleDestroy() {
    this.timers.forEach(clearTimeout);
    this.redis?.disconnect();
  }

  private async scheduled(kind: "games" | "results" | "nba") {
    try {
      await this.withLock<unknown>(() => (kind === "games" ? this.syncGames() : kind === "results" ? this.syncResults() : this.syncNbaOdds()));
    } catch (error) {
      this.logger.warn(`Basketball ${kind} sync failed: ${error instanceof Error ? error.message : String(error)}`);
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

  /** The coming days' games, and the European ones' prices when due. */
  async syncGames(): Promise<{ games: number; priced: number }> {
    let games = 0;
    let priced = 0;
    for (let offset = 0; offset < this.days; offset++) {
      const raw = (await this.get!("/games", { date: day(offset) })).response as RawGame[];
      for (const item of raw) {
        const game = parseGame(item);
        if (!game || !this.leagues.has(game.leagueId)) continue;
        const id = await this.saveGame(game);
        if (!id) continue;
        games++;
        if (game.leagueId !== NBA_LEAGUE_ID && game.status === "upcoming" && this.pricesDue(game) && (await this.priceGame(id, game))) priced++;
      }
    }
    return { games, priced };
  }

  /** Twice per game: when it first appears, and once in its last hours before tip-off; never into the day's reserve. */
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

  /**
   * NBA prices from The Odds API, matched to our games. It lists the regular
   * season and the preseason separately (NBA_ODDS_SPORTS), so each list's
   * games are looked at first, which costs nothing, and prices (3 credits)
   * are bought only for a list that has one of our coming games. Nothing at
   * all is asked while no NBA game of ours is coming up.
   */
  async syncNbaOdds(events?: OddsApiEvent[]): Promise<number> {
    const games = await this.prisma.event.findMany({
      where: { provider: BASKETBALL_PROVIDER, league: "NBA", status: EventStatus.UPCOMING, startsAt: { gt: new Date() } },
      select: { id: true, homeTeam: true, awayTeam: true, startsAt: true },
    });
    if (games.length === 0) return 0;
    const sameGame = (g: (typeof games)[number], event: { home_team: string; away_team: string; commence_time: string }) =>
      teamKey(g.homeTeam ?? "") === teamKey(event.home_team) && teamKey(g.awayTeam ?? "") === teamKey(event.away_team) && Math.abs(g.startsAt.getTime() - Date.parse(event.commence_time)) < SAME_GAME_MS;

    if (!events) {
      if (!this.oddsApiKey) return 0;
      events = [];
      for (const sport of (process.env.NBA_ODDS_SPORTS ?? "basketball_nba,basketball_nba_preseason").split(",").map((s) => s.trim()).filter(Boolean)) {
        const listed = await this.oddsApi<OddsApiEvent[]>(`/v4/sports/${sport}/events`, {});
        if (!listed.some((event) => games.some((g) => sameGame(g, event)))) continue;
        events.push(...(await this.oddsApi<OddsApiEvent[]>(`/v4/sports/${sport}/odds`, { regions: "us", markets: "h2h,spreads,totals", oddsFormat: "decimal" })));
      }
    }
    let priced = 0;
    for (const event of events) {
      const game = games.find((g) => sameGame(g, event));
      if (!game) continue;
      const markets = parseOddsApiEvent(event, game.homeTeam!, game.awayTeam!);
      if (markets.length === 0) continue;
      await this.odds.upsertMarkets(game.id, markets);
      priced++;
    }
    return priced;
  }

  private async oddsApi<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`https://api.the-odds-api.com${path}`);
    url.searchParams.set("apiKey", this.oddsApiKey!);
    Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const left = res.headers.get("x-requests-remaining");
    if (left !== null) this.oddsApiLeft = Number(left);
    if (!res.ok) throw new Error(`The Odds API answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** Final scores for the days with a started game that has none yet. */
  async syncResults(): Promise<number> {
    const now = Date.now();
    const waiting = await this.prisma.event.findMany({
      where: { provider: BASKETBALL_PROVIDER, status: { in: [EventStatus.UPCOMING, EventStatus.LIVE] }, startsAt: { lt: new Date(now), gt: new Date(now - RESULT_WINDOW_MS) } },
      select: { startsAt: true },
    });
    let saved = 0;
    for (const date of new Set(waiting.map((event) => event.startsAt.toISOString().slice(0, 10)))) {
      for (const item of (await this.get!("/games", { date })).response as RawGame[]) {
        const game = parseGame(item);
        if (game && this.leagues.has(game.leagueId) && (await this.saveGame(game, false))) saved++;
      }
    }
    return saved;
  }

  /** Saves a game and, once it's over, its final score (see saveScoredGame). Returns the game's id. */
  saveGame(game: FeedGame, create = true): Promise<string | null> {
    return saveScoredGame(this.prisma, BASKETBALL_PROVIDER, "basketball", game, create);
  }
}

/**
 * Saves a basketball or NFL game and, once it's over, its final score
 * (overtime included), which bets settle on like a football result. A score
 * that changes after it was settled is marked, so settlement settles the
 * game's bets again; a score Super Admin set by hand is left alone. Returns
 * the game's id.
 */
export async function saveScoredGame(prisma: PrismaService, provider: string, sport: string, game: FeedGame, create = true): Promise<string | null> {
  const where = { provider_externalId: { provider, externalId: game.externalId } };
  const before = await prisma.event.findUnique({ where, select: { id: true, status: true, startsAt: true, resultHome: true, resultAway: true, resultSource: true } });
  if ((!before && !create) || before?.resultSource === "manual") return before?.id ?? null;
  const status =
    game.status === "cancelled" ? EventStatus.CANCELLED
    : game.status === "postponed" ? EventStatus.POSTPONED
    : game.score ? EventStatus.COMPLETED
    : game.status === "upcoming" ? EventStatus.UPCOMING
    : EventStatus.LIVE;
  const changed = before?.status === EventStatus.COMPLETED && game.score !== null && (before.resultHome !== game.score.home || before.resultAway !== game.score.away);
  const data = {
    name: `${game.home} v ${game.away}`,
    league: game.league,
    country: game.country,
    homeTeam: game.home,
    awayTeam: game.away,
    startsAt: game.startsAt,
    status,
    syncedAt: new Date(),
    ...(game.score
      ? {
          homeScore: game.score.home,
          awayScore: game.score.away,
          resultHome: game.score.home,
          resultAway: game.score.away,
          resultSource: "feed",
          ...(before?.status !== EventStatus.COMPLETED ? { finishedAt: new Date() } : {}),
        }
      : {}),
    ...(changed ? { resultChangedAt: new Date() } : {}),
  };
  // Moved days later, like a football match: bets placed for the old date are refunded.
  const rescheduled = movedLater(before?.startsAt, game.startsAt);
  const event = await prisma.event.upsert({ where, create: { provider, externalId: game.externalId, sport, ...data }, update: { ...data, ...(rescheduled ? { rescheduledAt: new Date() } : {}) }, select: { id: true } });
  return event.id;
}
