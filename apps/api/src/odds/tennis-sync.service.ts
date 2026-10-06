import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventStatus, Prisma } from "@prisma/client";
import Redis from "ioredis";
import { PrismaService } from "../prisma.service";
import { OddsSyncService, movedLater } from "./odds-sync.service";
import { type FeedMatch, type RawTennisMatch, type RawTennisOdds, TENNIS_PROVIDER, TENNIS_TIMEZONE, parseTennisMatch, parseTennisOdds, setsWon, tennisResultOf } from "./tennis";

const LOCK_KEY = "tennis:sync";
/** Started matches are checked for their result for this long after they were due. */
const RESULT_WINDOW_MS = 36 * 3_600_000;
/** Matches due to start within this long are watched, so bets close the moment one goes on court early. */
const WATCH_AHEAD_MS = 12 * 3_600_000;

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

type TennisAnswer<T> = { success?: number; result?: T; error?: unknown };

/** One request to API-Tennis: `method` and its parameters. */
export type TennisFetch = <T>(method: string, params: Record<string, string>) => Promise<T | null>;

export function tennisFetch(apiKey: string): TennisFetch {
  return async <T>(method: string, params: Record<string, string>) => {
    const query = new URLSearchParams({ method, APIkey: apiKey, ...params });
    const res = await fetch(`https://api.api-tennis.com/tennis/?${query}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`API-Tennis answered ${res.status} for ${method}`);
    const body = (await res.json()) as TennisAnswer<T>;
    // No matches on a day comes back as success 0 with no result, which is just empty.
    if (body.success !== 1 && body.error) throw new Error(`API-Tennis: ${typeof body.error === "string" ? body.error : JSON.stringify(body.error)}`);
    return body.result ?? null;
  };
}

/**
 * Keeps tennis up to date from API-Tennis (see tennis.ts):
 * - every TENNIS_SYNC_INTERVAL_MS (30 minutes): the matches from today to
 *   TENNIS_DAYS (2) days ahead and their prices, two requests;
 * - every TENNIS_LIVE_INTERVAL_MS (5 minutes), while a match is due within 12
 *   hours or has started without a result: the matches on court now (one
 *   request), so bets close as soon as one starts, earlier than listed or
 *   not; and, when one should be over, those days' matches again for the
 *   results (one more).
 * TENNIS_TOURS picks the competitions, by the feed's names (default
 * "Atp Singles,Wta Singles"); TENNIS_BOOKMAKER the prices (bet365).
 */
@Injectable()
export class TennisSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TennisSyncService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly get?: TennisFetch;
  private readonly tours = new Set((process.env.TENNIS_TOURS ?? "Atp Singles,Wta Singles").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean));
  private readonly bookmaker = process.env.TENNIS_BOOKMAKER?.trim() || "bet365";
  private readonly days = Math.min(7, Math.max(1, Number(process.env.TENNIS_DAYS) || 2));
  private redis?: Redis;
  private running = false;
  /** The feed's market names, logged once per start, so a market it names differently doesn't go unnoticed. */
  private marketsLogged = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly odds: OddsSyncService,
  ) {
    const key = process.env.TENNIS_API_KEY?.trim();
    if (key && process.env.TENNIS_FEED !== "off") this.get = tennisFetch(key);
  }

  get enabled() {
    return this.get !== undefined;
  }

  onModuleInit() {
    if (!this.get) {
      this.logger.log("Tennis is off: set TENNIS_API_KEY (api-tennis.com)");
      return;
    }
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    this.redis.on("error", () => undefined);
    this.redis.connect().catch(() => undefined);
    this.timers.push(setTimeout(() => void this.scheduled("matches"), 18_000));
    this.timers.push(setInterval(() => void this.scheduled("matches"), Number(process.env.TENNIS_SYNC_INTERVAL_MS) || 30 * 60_000));
    this.timers.push(setInterval(() => void this.scheduled("live"), Number(process.env.TENNIS_LIVE_INTERVAL_MS) || 5 * 60_000));
  }

  onModuleDestroy() {
    this.timers.forEach(clearTimeout);
    this.redis?.disconnect();
  }

  private async scheduled(kind: "matches" | "live") {
    try {
      await this.withLock<unknown>(() => (kind === "matches" ? this.syncMatches() : this.syncLive()));
    } catch (error) {
      this.logger.warn(`Tennis ${kind} sync failed: ${error instanceof Error ? error.message : String(error)}`);
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

  private wanted(match: FeedMatch | null): match is FeedMatch {
    return match !== null && this.tours.has(match.tour.toLowerCase());
  }

  /** The coming days' matches, and prices for those not yet started. */
  async syncMatches(): Promise<{ matches: number; priced: number }> {
    const range = { date_start: day(0), date_stop: day(this.days - 1), timezone: TENNIS_TIMEZONE };
    const saved = new Map<string, { id: string; home: string; away: string }>();
    for (const raw of (await this.get!<RawTennisMatch[]>("get_fixtures", range)) ?? []) {
      const match = parseTennisMatch(raw);
      if (!this.wanted(match)) continue;
      const id = await this.saveMatch(match);
      if (id && match.status === "upcoming") saved.set(match.externalId, { id, home: match.home, away: match.away });
    }
    let priced = 0;
    if (saved.size > 0) {
      const odds = await this.get!<Record<string, RawTennisOdds>>("get_odds", { date_start: range.date_start, date_stop: range.date_stop });
      if (!this.marketsLogged && odds && Object.keys(odds).length > 0) {
        this.marketsLogged = true;
        const names = [...new Set(Object.values(odds).flatMap((raw) => Object.keys(raw ?? {})))].sort();
        this.logger.log(`Tennis markets in the feed: ${names.join(", ")}`);
        // And a few outcomes of each, so an outcome spelled differently shows up too.
        const sample = (name: string) => Object.keys(Object.values(odds).find((raw) => raw?.[name])?.[name] ?? {}).slice(0, 4);
        this.logger.log(`Tennis outcomes in the feed: ${names.map((name) => `${name} [${sample(name).join(" | ")}]`).join("; ")}`);
        // One over/under and one handicap in full, to see where the feed puts the line.
        for (const name of ["Over/Under by Games in Match", "Asian Handicap (Games)"]) {
          const raw = Object.values(odds).find((r) => r?.[name])?.[name];
          if (raw) this.logger.log(`Tennis ${name} in full: ${JSON.stringify(raw).slice(0, 600)}`);
        }
      }
      for (const [key, raw] of Object.entries(odds ?? {})) {
        const match = saved.get(key);
        if (!match) continue;
        const markets = parseTennisOdds(raw, match.home, match.away, this.bookmaker);
        if (markets.length === 0) continue;
        await this.odds.upsertMarkets(match.id, markets);
        priced++;
      }
    }
    return { matches: saved.size, priced };
  }

  /** Matches on court now, and results for those that should be over. */
  async syncLive(): Promise<number> {
    const now = Date.now();
    const watched = await this.prisma.event.findMany({
      where: { provider: TENNIS_PROVIDER, status: { in: [EventStatus.UPCOMING, EventStatus.LIVE] }, startsAt: { lt: new Date(now + WATCH_AHEAD_MS), gt: new Date(now - RESULT_WINDOW_MS) } },
      select: { externalId: true, status: true, startsAt: true },
    });
    if (watched.length === 0) return 0;
    let saved = 0;
    const onCourt = new Set<string>();
    for (const raw of (await this.get!<RawTennisMatch[]>("get_livescore", { timezone: TENNIS_TIMEZONE })) ?? []) {
      const match = parseTennisMatch(raw);
      if (!this.wanted(match)) continue;
      onCourt.add(match.externalId);
      if (await this.saveMatch(match, false)) saved++;
    }
    // Started (by the clock or the feed) and no longer on court: look for the result.
    const waiting = watched.filter((event) => (event.status === EventStatus.LIVE || event.startsAt.getTime() < now) && !onCourt.has(event.externalId!));
    if (waiting.length === 0) return saved;
    const dates = waiting.map((event) => event.startsAt.toISOString().slice(0, 10)).sort();
    for (const raw of (await this.get!<RawTennisMatch[]>("get_fixtures", { date_start: dates[0], date_stop: dates[dates.length - 1], timezone: TENNIS_TIMEZONE })) ?? []) {
      const match = parseTennisMatch(raw);
      if (this.wanted(match) && (await this.saveMatch(match, false))) saved++;
    }
    return saved;
  }

  /**
   * Saves a match and, once it's over, its result: the sets each player won as
   * the score, and every set's games for the markets. A result that changes
   * after it was settled is marked, so settlement settles its bets again.
   * Returns the match's id, or null if not saved.
   */
  async saveMatch(match: FeedMatch, create = true): Promise<string | null> {
    const where = { provider_externalId: { provider: TENNIS_PROVIDER, externalId: match.externalId } };
    const before = await this.prisma.event.findUnique({ where, select: { id: true, status: true, startsAt: true, fightResult: true, resultSource: true } });
    if ((!before && !create) || before?.resultSource === "manual") return null;
    const previous = tennisResultOf(before?.fightResult);
    const result = match.result ?? previous;
    const status =
      match.status === "cancelled" ? EventStatus.CANCELLED
      : match.status === "postponed" ? EventStatus.POSTPONED
      : result ? EventStatus.COMPLETED
      : match.status === "upcoming" ? EventStatus.UPCOMING
      : EventStatus.LIVE;
    const changed = before?.status === EventStatus.COMPLETED && previous !== null && match.result !== null && JSON.stringify(previous) !== JSON.stringify(match.result);
    const score = result ? setsWon(result) : null;
    const data = {
      name: `${match.home} v ${match.away}`,
      league: match.tournament,
      country: match.round ? `${match.tour} · ${match.round}` : match.tour,
      homeTeam: match.home,
      awayTeam: match.away,
      startsAt: match.startsAt,
      status,
      syncedAt: new Date(),
      ...(result && score
        ? {
            fightResult: result as unknown as Prisma.InputJsonValue,
            homeScore: score.home,
            awayScore: score.away,
            resultSource: "feed",
            ...(before?.status !== EventStatus.COMPLETED ? { finishedAt: new Date() } : {}),
          }
        : {}),
      ...(changed ? { resultChangedAt: new Date() } : {}),
    };
    const event = await this.prisma.event.upsert({
      where,
      create: { provider: TENNIS_PROVIDER, externalId: match.externalId, sport: "tennis", ...data },
      // Moved days later, like a football match: bets placed for the old date are refunded.
      update: { ...data, ...(movedLater(before?.startsAt, match.startsAt) ? { rescheduledAt: new Date() } : {}) },
      select: { id: true },
    });
    return event.id;
  }
}
