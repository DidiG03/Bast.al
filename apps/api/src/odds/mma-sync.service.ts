import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventStatus, Prisma } from "@prisma/client";
import Redis from "ioredis";
import { PrismaService } from "../prisma.service";
import { type FetchJson, httpFetchJson } from "./api-football";
import { type FeedFight, MMA_PROVIDER, type RawFight, type RawFightResult, fightResult, fightResultOf, parseFight, parseFightOdds } from "./mma";
import { OddsSyncService, movedLater } from "./odds-sync.service";

const LOCK_KEY = "mma:sync";
/** bet365 in API-Sports' MMA bookmaker list. */
const DEFAULT_BOOKMAKER = 5;
/** Requests kept in hand each day: below this only results are fetched. */
const QUOTA_RESERVE = 10;
/** Started fights are checked for their result for this long after they were due. */
const RESULT_WINDOW_MS = 24 * 3_600_000;

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Keeps MMA fights up to date from API-Sports (see mma.ts), on the free plan's
 * 100 requests a day:
 * - every MMA_SYNC_INTERVAL_MS (2 hours): today's and tomorrow's fights and
 *   their odds, four requests (the free plan sees yesterday to tomorrow only);
 * - every MMA_RESULTS_INTERVAL_MS (30 minutes), only while a fight that has
 *   started has no result yet: that day's fights and results, two requests.
 * A paid MMA plan can run both faster; MMA_DAYS (2) then reaches further ahead.
 * The key is API_FOOTBALL_KEY (the same API-Sports account) unless
 * MMA_API_KEY is set.
 */
@Injectable()
export class MmaSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MmaSyncService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly get?: FetchJson;
  private readonly bookmakerId = Number(process.env.MMA_BOOKMAKER) || DEFAULT_BOOKMAKER;
  private readonly days = Math.min(14, Math.max(1, Number(process.env.MMA_DAYS) || 2));
  private redis?: Redis;
  private running = false;
  private quotaLeft: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly odds: OddsSyncService,
  ) {
    const key = process.env.MMA_API_KEY?.trim() || (process.env.API_FOOTBALL_HOST?.includes("rapidapi") ? "" : process.env.API_FOOTBALL_KEY?.trim());
    if (key && process.env.MMA_FEED !== "off") this.get = httpFetchJson(process.env.MMA_API_HOST?.trim() || "v1.mma.api-sports.io", key, (left) => (this.quotaLeft = left));
  }

  get enabled() {
    return this.get !== undefined;
  }

  onModuleInit() {
    if (!this.get) {
      this.logger.log("MMA is off: set API_FOOTBALL_KEY (direct API-Sports) or MMA_API_KEY");
      return;
    }
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    this.redis.on("error", () => undefined);
    this.redis.connect().catch(() => undefined);
    this.timers.push(setTimeout(() => void this.scheduled("fights"), 12_000));
    this.timers.push(setInterval(() => void this.scheduled("fights"), Number(process.env.MMA_SYNC_INTERVAL_MS) || 2 * 3_600_000));
    this.timers.push(setInterval(() => void this.scheduled("results"), Number(process.env.MMA_RESULTS_INTERVAL_MS) || 30 * 60_000));
  }

  onModuleDestroy() {
    this.timers.forEach(clearTimeout);
    this.redis?.disconnect();
  }

  private async scheduled(kind: "fights" | "results") {
    try {
      await this.withLock<unknown>(() => (kind === "fights" ? this.syncFights() : this.syncResults()));
    } catch (error) {
      this.logger.warn(`MMA ${kind} sync failed: ${error instanceof Error ? error.message : String(error)}`);
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

  /** The coming days' fights and their odds. */
  async syncFights(): Promise<{ fights: number; priced: number }> {
    if (this.quotaLeft !== null && this.quotaLeft < QUOTA_RESERVE) return { fights: 0, priced: 0 };
    let fights = 0;
    let priced = 0;
    for (let offset = 0; offset < this.days; offset++) {
      const date = day(offset);
      const raw = (await this.get!("/fights", { date })).response as RawFight[];
      const saved = new Map<string, { id: string; home: string; away: string }>();
      for (const item of raw) {
        const fight = parseFight(item);
        if (!fight) continue;
        const id = await this.saveFight(fight, undefined);
        if (id) saved.set(fight.externalId, { id, home: fight.home, away: fight.away });
      }
      fights += saved.size;
      if (saved.size === 0) continue;
      const odds = (await this.get!("/odds", { date })).response as Array<{ fight?: { id?: number } }>;
      for (const item of odds) {
        const fight = saved.get(String(item.fight?.id));
        if (!fight) continue;
        const markets = parseFightOdds(item as Parameters<typeof parseFightOdds>[0], fight.home, fight.away, this.bookmakerId);
        if (markets.length === 0) continue;
        await this.odds.upsertMarkets(fight.id, markets);
        priced++;
      }
    }
    return { fights, priced };
  }

  /** Results for the days with a fight that has started and has none yet. */
  async syncResults(): Promise<number> {
    const now = Date.now();
    const waiting = await this.prisma.event.findMany({
      where: { provider: MMA_PROVIDER, status: { in: [EventStatus.UPCOMING, EventStatus.LIVE] }, startsAt: { lt: new Date(now), gt: new Date(now - RESULT_WINDOW_MS) } },
      select: { startsAt: true },
    });
    let saved = 0;
    for (const date of new Set(waiting.map((event) => event.startsAt.toISOString().slice(0, 10)))) {
      const [fights, results] = await Promise.all([this.get!("/fights", { date }), this.get!("/fights/results", { date })]);
      const details = new Map((results.response as RawFightResult[]).map((r) => [String(r.fight?.id), r]));
      for (const item of fights.response as RawFight[]) {
        const fight = parseFight(item);
        if (fight && (await this.saveFight(fight, details.get(fight.externalId), false))) saved++;
      }
    }
    return saved;
  }

  /**
   * Saves a fight and, once it's over, its result. Every fight on the card
   * closes when its first fight starts, or at once when any has started. A
   * result that changes after it was settled is marked, so settlement settles
   * the fight's bets again. Returns the fight's id, or null if not saved.
   */
  async saveFight(fight: FeedFight, details: RawFightResult | undefined, create = true): Promise<string | null> {
    const where = { provider_externalId: { provider: MMA_PROVIDER, externalId: fight.externalId } };
    const before = await this.prisma.event.findUnique({ where, select: { id: true, status: true, startsAt: true, fightResult: true, resultSource: true } });
    if ((!before && !create) || before?.resultSource === "manual") return null;
    const previous = fightResultOf(before?.fightResult);
    const result = fightResult(fight, details) ?? previous;
    const status =
      fight.status === "cancelled" ? EventStatus.CANCELLED
      : fight.status === "postponed" ? EventStatus.POSTPONED
      : result ? EventStatus.COMPLETED
      : fight.status === "upcoming" ? EventStatus.UPCOMING
      : EventStatus.LIVE;
    const changed = before?.status === EventStatus.COMPLETED && previous !== null && result !== null && JSON.stringify(previous) !== JSON.stringify(result);
    const data = {
      name: `${fight.home} v ${fight.away}`,
      league: fight.card,
      country: fight.weightClass,
      homeTeam: fight.home,
      awayTeam: fight.away,
      startsAt: fight.startsAt,
      status,
      fightResult: result ? (result as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      syncedAt: new Date(),
      ...(result ? { resultSource: "feed", ...(before?.status !== EventStatus.COMPLETED ? { finishedAt: new Date() } : {}) } : {}),
      ...(changed ? { resultChangedAt: new Date() } : {}),
    };
    const event = await this.prisma.event.upsert({
      where,
      create: { provider: MMA_PROVIDER, externalId: fight.externalId, sport: "mma", ...data },
      // Moved days later, like a football match: bets placed for the old date are refunded.
      update: { ...data, ...(movedLater(before?.startsAt, fight.startsAt) ? { rescheduledAt: new Date() } : {}) },
      select: { id: true },
    });
    await this.closeCard(fight.card, fight.startsAt, fight.status !== "upcoming");
    return event.id;
  }

  /** The card's fights close when its first one starts; at once if one has started. */
  private async closeCard(card: string, near: Date, started: boolean) {
    const window = { gt: new Date(near.getTime() - 24 * 3_600_000), lt: new Date(near.getTime() + 24 * 3_600_000) };
    const fights = await this.prisma.event.findMany({ where: { provider: MMA_PROVIDER, league: card, startsAt: window }, select: { startsAt: true, closesAt: true } });
    const first = Math.min(...fights.map((f) => f.startsAt.getTime()));
    const closesAt = new Date(started ? Math.min(first, Date.now()) : first);
    await this.prisma.event.updateMany({
      where: { provider: MMA_PROVIDER, league: card, startsAt: window, OR: [{ closesAt: null }, { closesAt: { gt: closesAt } }] },
      data: { closesAt },
    });
  }
}
