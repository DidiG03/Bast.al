import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { BetStatus, EventStatus, Prisma } from "@prisma/client";
import Redis from "ioredis";
import { PrismaService } from "../prisma.service";
import { type FeedRace, type RaceInfo, type RawRace, RACE_PROVIDER, RACE_WINNER, dogKey, greyhoundFetch, parseRace, raceMarkets, raceResultOf } from "./greyhounds";

const LOCK_KEY = "greyhounds:sync";
/** Races that started this long ago and still have no result are left to settlement's unplayed refund. */
const PENDING_WINDOW_MS = 48 * 3_600_000;
/** Races asked about in one request (the feed's limit). */
const BATCH = 50;

type Page = { data?: Array<RawRace & { freshness?: { results_received?: string | null } }>; meta?: { next_page?: number | null } };
/** Results asked for at start-up: those that came in this long ago or since. */
const RESULTS_LOOKBACK_MS = 6 * 3_600_000;
/** A page of results; a full one means there may be more. */
const RESULTS_PAGE = 200;

/**
 * Keeps greyhound races up to date from GreyhoundAPI (see greyhounds.ts):
 * - every GREYHOUND_CARDS_INTERVAL_MS (15 minutes): the race cards for the
 *   next GREYHOUND_HOURS hours (24), with withdrawn dogs; today's results
 *   again (so a provisional result that turned final, or a corrected one, is
 *   picked up); and the status of started races still without a result (up
 *   to 50 per request), which is how a void or abandoned race shows;
 * - every GREYHOUND_RESULTS_INTERVAL_MS (2 minutes), while any started race
 *   has open bets: the results that came in since the last look, all in one
 *   request, so bets settle soon after the official result.
 * A dog with bets on it that's missing from a result is checked with the
 * race's runners: withdrawn means void, otherwise it ran and lost.
 * A sandbox key (gapi_test_…, 50 requests a day) runs every 4 hours and every
 * 2 hours instead. GREYHOUND_REGIONS (GB,IE,AU) picks the countries.
 */
@Injectable()
export class GreyhoundSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GreyhoundSyncService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly get?: ReturnType<typeof greyhoundFetch>;
  private readonly regions: Set<string>;
  private readonly sandbox: boolean;
  private redis?: Redis;
  private running = false;
  /** When the newest result already read came in: the next look asks for those after it. */
  private resultsSince: string | null = null;

  constructor(private readonly prisma: PrismaService) {
    const key = process.env.GREYHOUND_API_KEY?.trim();
    if (key) this.get = greyhoundFetch(key);
    this.sandbox = Boolean(key?.startsWith("gapi_test_"));
    this.regions = new Set((process.env.GREYHOUND_REGIONS ?? "GB,IE,AU").split(",").map((r) => r.trim().toUpperCase()).filter(Boolean));
  }

  get enabled() {
    return this.get !== undefined;
  }

  onModuleInit() {
    if (!this.get) {
      this.logger.log("Greyhound racing is off: set GREYHOUND_API_KEY");
      return;
    }
    this.redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    this.redis.on("error", () => undefined);
    this.redis.connect().catch(() => undefined);
    const cardsEvery = Number(process.env.GREYHOUND_CARDS_INTERVAL_MS) || (this.sandbox ? 4 * 3_600_000 : 15 * 60_000);
    const resultsEvery = Number(process.env.GREYHOUND_RESULTS_INTERVAL_MS) || (this.sandbox ? 2 * 3_600_000 : 2 * 60_000);
    this.timers.push(setTimeout(() => void this.scheduled("cards"), 8_000));
    this.timers.push(setInterval(() => void this.scheduled("cards"), cardsEvery));
    this.timers.push(setInterval(() => void this.scheduled("results"), resultsEvery));
  }

  onModuleDestroy() {
    this.timers.forEach(clearTimeout);
    this.redis?.disconnect();
  }

  private async scheduled(kind: "cards" | "results") {
    try {
      await this.withLock<unknown>(() => (kind === "cards" ? this.syncCards() : this.syncResultsIfBets()));
    } catch (error) {
      this.logger.warn(`Greyhound ${kind} sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Runs `task` unless a greyhound sync is already running here or on another instance. */
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

  /** The race cards for the hours ahead, then every started race still waiting for its result. */
  async syncCards(): Promise<{ races: number; results: number }> {
    const hours = Math.min(48, Math.max(1, Number(process.env.GREYHOUND_HOURS) || 24));
    let races = 0;
    for (let page = 1; page <= 10; page++) {
      const answer = await this.get!<Page>("/racecards/upcoming", { hours, limit: 200, page });
      for (const raw of answer.data ?? []) {
        const race = parseRace(raw);
        if (race && this.regions.has(race.region) && race.runners.length >= 2 && (await this.saveRace(race))) races++;
      }
      if (!answer.meta?.next_page) break;
    }
    let results = 0;
    for (let page = 1; page <= 10; page++) {
      const answer = await this.get!<Page>("/results/today", { limit: 200, page });
      results += await this.saveResults(answer.data ?? []);
      if (!answer.meta?.next_page) break;
    }
    return { races, results: results + (await this.syncStatuses()) };
  }

  /** The results that came in since the last look, while a started race has open bets. */
  async syncResultsIfBets(): Promise<number> {
    const waiting = await this.prisma.event.count({
      where: { ...this.started(), markets: { some: { selections: { some: { bets: { some: { status: BetStatus.OPEN } } } } } } },
    });
    return waiting > 0 ? this.syncResults() : 0;
  }

  /** Every result that came in since the last look (one request, unless there were over 200). */
  async syncResults(): Promise<number> {
    let since = this.resultsSince ?? new Date(Date.now() - RESULTS_LOOKBACK_MS).toISOString();
    let saved = 0;
    for (let page = 0; page < 5; page++) {
      const rows = (await this.get!<Page>("/results/latest", { since, limit: RESULTS_PAGE })).data ?? [];
      saved += await this.saveResults(rows);
      for (const row of rows) {
        const received = row.freshness?.results_received;
        if (received && new Date(received) > new Date(since)) since = received;
      }
      if (rows.length < RESULTS_PAGE) break;
    }
    this.resultsSince = since;
    return saved;
  }

  /** Saves the results of races we list; the others are skipped. */
  private async saveResults(rows: RawRace[]): Promise<number> {
    let saved = 0;
    for (const raw of rows) {
      const race = parseRace(raw);
      if (race && (await this.saveRace(race, false))) saved++;
    }
    return saved;
  }

  /**
   * The status of started races with no final result yet, 50 per request:
   * a void or abandoned race is cancelled (and its bets refunded).
   */
  private async syncStatuses(): Promise<number> {
    const pending = await this.prisma.event.findMany({ where: this.started(), orderBy: { startsAt: "asc" }, select: { externalId: true }, take: 500 });
    let done = 0;
    for (let i = 0; i < pending.length; i += BATCH) {
      const ids = pending.slice(i, i + BATCH).map((event) => event.externalId!);
      for (const raw of (await this.get!<Page>("/races", { ids: ids.join(","), limit: BATCH })).data ?? []) {
        const race = parseRace(raw);
        if (race && (race.status === "void" || race.status === "abandoned") && (await this.saveRace(race, false))) done++;
      }
    }
    return done;
  }

  /** Races that have started and have no final result yet. */
  private started(): Prisma.EventWhereInput {
    const now = Date.now();
    return { provider: RACE_PROVIDER, status: EventStatus.UPCOMING, startsAt: { lt: new Date(now), gt: new Date(now - PENDING_WINDOW_MS) } };
  }

  /**
   * Saves a race: its card and markets, and once it's run its result. A
   * result that changes after its bets were settled is marked, so settlement
   * settles them again (see SettlementService.applyFeedCorrections). Returns
   * whether the race was saved.
   */
  async saveRace(race: FeedRace, create = true): Promise<boolean> {
    const before = await this.prisma.event.findUnique({
      where: { provider_externalId: { provider: RACE_PROVIDER, externalId: race.externalId } },
      select: { id: true, status: true, raceResult: true, resultSource: true },
    });
    // A result for a race we don't list; or one Super Admin settled or cancelled by hand, which the feed leaves alone.
    if ((!before && !create) || before?.resultSource === "manual") return false;
    const cancelled = race.status === "void" || race.status === "abandoned";
    const previous = raceResultOf(before?.raceResult);
    // An answer without a result (a race card, a status) keeps the one already saved.
    const result = race.result ?? previous;
    const final = !cancelled && result?.final === true;
    const status = cancelled ? EventStatus.CANCELLED : final ? EventStatus.COMPLETED : EventStatus.UPCOMING;
    const changed = before?.status === EventStatus.COMPLETED && final && race.result !== null && previous !== null && JSON.stringify(previous) !== JSON.stringify(race.result);
    // A dog with bets on it that isn't in the result: the race's runners say whether it was withdrawn (void) or ran and lost.
    if (final && before && race.runners.length === 0 && this.get) race.runners = await this.runnersIfMissing(before.id, race.externalId, result.positions.map((p) => p.dogId));
    const info: RaceInfo = { raceNumber: race.raceNumber, grade: race.grade, distance: race.distance, region: race.region, runners: race.runners.map((r) => ({ dogId: r.dogId, status: r.status })) };
    const data = {
      name: `${race.track} · Race ${race.raceNumber}`,
      league: race.track,
      country: race.region,
      startsAt: race.startsAt,
      status,
      ...(race.runners.length > 0 ? { race: info as unknown as Prisma.InputJsonValue } : {}),
      raceResult: result ? (result as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      syncedAt: new Date(),
      ...(final ? { resultSource: "feed", ...(before?.status !== EventStatus.COMPLETED ? { finishedAt: new Date() } : {}) } : {}),
      ...(changed ? { resultChangedAt: new Date() } : {}),
    };
    const event = await this.prisma.event.upsert({
      where: { provider_externalId: { provider: RACE_PROVIDER, externalId: race.externalId } },
      create: { provider: RACE_PROVIDER, externalId: race.externalId, sport: "greyhounds", ...data },
      update: data,
      select: { id: true },
    });
    if (race.runners.length > 0) await this.saveMarkets(event.id, race);
    return true;
  }

  /** The race's runners from the feed when a dog with open bets is missing from its result; none otherwise. */
  private async runnersIfMissing(eventId: string, externalId: string, placed: number[]): Promise<FeedRace["runners"]> {
    const missing = await this.prisma.selection.count({
      where: { withdrawn: false, key: { notIn: placed.map(dogKey) }, market: { eventId, key: RACE_WINNER }, bets: { some: { status: BetStatus.OPEN } } },
    });
    if (missing === 0) return [];
    const answer = await this.get!<{ data?: RawRace["runners"] }>(`/races/${externalId}/runners`);
    return parseRace({ race_id: externalId, track: { name: "-" }, scheduled_start: { utc: new Date().toISOString() }, runners: answer.data ?? [] })?.runners ?? [];
  }

  /** Adds new dogs and pairs, keeps names and traps current, and marks withdrawn dogs (and their pairs) so they can't be bet on. */
  private async saveMarkets(eventId: string, race: FeedRace) {
    for (const market of raceMarkets(race)) {
      await this.prisma.$transaction(async (tx) => {
        const row = await tx.market.upsert({
          where: { eventId_key: { eventId, key: market.key } },
          create: { eventId, key: market.key, name: market.name, sortOrder: market.sortOrder },
          update: { name: market.name, sortOrder: market.sortOrder },
          select: { id: true },
        });
        const existing = new Map((await tx.selection.findMany({ where: { marketId: row.id }, select: { id: true, key: true, name: true, sortOrder: true, withdrawn: true } })).map((s) => [s.key, s]));
        const added = market.selections.filter((s) => !existing.has(s.key));
        if (added.length > 0) {
          await tx.selection.createMany({
            data: added.map((s) => ({ marketId: row.id, key: s.key, name: s.name, feedOdds: 0, sortOrder: s.sortOrder, info: s.info as Prisma.InputJsonValue, withdrawn: s.withdrawn })),
            skipDuplicates: true,
          });
        }
        for (const s of market.selections) {
          const old = existing.get(s.key);
          if (!old || (old.name === s.name && old.sortOrder === s.sortOrder && old.withdrawn === s.withdrawn)) continue;
          await tx.selection.update({ where: { id: old.id }, data: { name: s.name, sortOrder: s.sortOrder, withdrawn: s.withdrawn, info: s.info as Prisma.InputJsonValue } });
        }
        // A dog taken off the card altogether can't be bet on either.
        const sent = new Set(market.selections.map((s) => s.key));
        const gone = [...existing.values()].filter((s) => !sent.has(s.key) && !s.withdrawn).map((s) => s.id);
        if (gone.length > 0) await tx.selection.updateMany({ where: { id: { in: gone } }, data: { withdrawn: true } });
      });
    }
  }
}
