import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { EventStatus, Role } from "@prisma/client";
import type { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";
import { TRACKER_ATTRIBUTION_URL, TRACKER_PROVIDER, trackerEmbedSrc, trackerEnabled } from "./tracker-embed";
import { KICKOFF_TOLERANCE_MS, matchTrackerFixture } from "./tracker-match";
import { fetchLiveFixtures } from "./sportscore-feed";

/** How often SportScore's live list is read while one of our live football matches has no tracker yet (~720 calls a day at most; their free tier allows ~10,000). */
const SYNC_MS = 2 * 60_000;
/** The first read after the API starts. */
const FIRST_SYNC_MS = 20_000;
/** Opening a match without a tracker reads SportScore at most this often (then the 2-minute timer does the rest). */
const ON_VIEW_SYNC_MS = 60_000;
/** Before kick-off, a match's page shows SportScore's tracker (its kick-off card until it starts) from this long before. */
const UPCOMING_MS = 24 * 3_600_000;
/** A day's not-started fixtures are read at most this often, when a match page needs them. */
const UPCOMING_READ_MS = 10 * 60_000;
/** Lets tests hand in their own fetch. */
export const TRACKER_FETCH = "TRACKER_FETCH";
/** Imported fixtures are kept this long. */
const KEEP_FIXTURES_MS = 2 * 24 * 60 * 60_000;

/** A match with no confident fixture is looked for again after this long (new fixtures may have come in). */
const RECHECK_MS = 10 * 60_000;

export interface TrackerFixtureInput {
  id: string;
  home: string;
  away: string;
  kickoff: string;
}

export type TrackerView = { show: false } | { show: true; provider: string; src: string; attributionUrl: string };

/**
 * The live match tracker: display only. Nothing here is read by odds,
 * pauses, bet acceptance or settlement, and this service reads none of
 * their state beyond whether a match is live.
 */
@Injectable()
export class TrackerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrackerService.name);
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private syncing: Promise<{ fetched: number; matched: number } | null> | null = null;
  private lastSyncAt = 0;
  /** When each UTC day's not-started fixtures were last read. */
  private readonly upcomingReadAt = new Map<string, number>();
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(TRACKER_FETCH) fetcher?: typeof fetch,
  ) {
    this.fetcher = fetcher ?? fetch;
  }

  onModuleInit() {
    if (process.env.NODE_ENV === "test" || process.env.TRACKER_SYNC === "off") return;
    this.logger.log(`Tracker ${trackerEnabled() ? "on" : "off (LIVE_TRACKER_ENABLED is not true)"}; SportScore is read every ${SYNC_MS / 60_000} min while a live football match has no tracker`);
    this.first = setTimeout(() => void this.sync(), FIRST_SYNC_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.sync(), SYNC_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Reads SportScore's live football fixtures and maps our live matches to
   * them. Skipped while the tracker is off, or when every live football match
   * already has a tracker (or a manual choice), so it only calls out when needed.
   */
  async sync(now = new Date()): Promise<{ fetched: number; matched: number } | null> {
    if (!trackerEnabled()) return null;
    // One read at a time: a page view during a read waits for that read.
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync(now).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync(now: Date): Promise<{ fetched: number; matched: number } | null> {
    try {
      const waiting = await this.prisma.event.count({
        where: { sport: "football", status: EventStatus.LIVE, hidden: false, OR: [{ trackerMapping: null }, { trackerMapping: { externalId: null, method: { not: "manual" } } }] },
      });
      if (waiting === 0) return null;
      this.lastSyncAt = Date.now();
      // Their fixture days are UTC: just after midnight, matches that kicked off yesterday are still on.
      const days = [now.toISOString().slice(0, 10)];
      if (now.getUTCHours() < 3) days.push(new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10));
      const fixtures = (await Promise.all(days.map((day) => fetchLiveFixtures(day, this.fetcher)))).flat();
      await this.prisma.trackerFixture.deleteMany({ where: { kickoff: { lt: new Date(now.getTime() - KEEP_FIXTURES_MS) } } });
      const { matched } = await this.importFixtures(fixtures);
      this.logger.log(`Tracker sync: ${fixtures.length} live fixtures from SportScore, ${matched} of our matches mapped (${waiting} were waiting)`);
      return { fetched: fixtures.length, matched };
    } catch (error) {
      // SportScore being down only means no tracker; it never touches anything else.
      this.logger.warn(`Tracker sync failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** What a match page should frame, if anything. */
  async forEvent(actor: Actor, eventId: string, lang: "sq" | "en", theme: "light" | "dark"): Promise<TrackerView> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, sport: true, status: true, hidden: true, homeTeam: true, awayTeam: true, startsAt: true, trackerMapping: true },
    });
    if (!event || (event.hidden && actor.role !== Role.SUPER_ADMIN)) throw new NotFoundException("Match not found");
    const soon = event.status === EventStatus.UPCOMING && event.startsAt.getTime() - Date.now() < UPCOMING_MS;
    if (!trackerEnabled() || event.sport !== "football" || (event.status !== EventStatus.LIVE && !soon)) return { show: false };
    let mapping = event.trackerMapping;
    if (!mapping || (mapping.method !== "manual" && !mapping.externalId && Date.now() - mapping.checkedAt.getTime() > RECHECK_MS)) {
      mapping = await this.match(event);
    }
    // Still nothing: read SportScore now (live: at most once a minute; not started: that day's list, every 10 minutes at most).
    if (!mapping.externalId && mapping.method !== "manual") {
      if (soon) await this.readUpcoming(event.startsAt);
      else if (Date.now() - this.lastSyncAt > ON_VIEW_SYNC_MS) await this.sync();
      mapping = (await this.prisma.trackerMapping.findUnique({ where: { eventId } })) ?? mapping;
    }
    const src = mapping?.externalId ? trackerEmbedSrc(mapping.externalId, lang, theme) : null;
    return src ? { show: true, provider: TRACKER_PROVIDER, src, attributionUrl: TRACKER_ATTRIBUTION_URL } : { show: false };
  }

  /** SportScore's not-started fixtures for one UTC day, imported and matched. Failures are only logged. */
  private async readUpcoming(kickoff: Date): Promise<void> {
    const day = kickoff.toISOString().slice(0, 10);
    if (Date.now() - (this.upcomingReadAt.get(day) ?? 0) < UPCOMING_READ_MS) return;
    this.upcomingReadAt.set(day, Date.now());
    try {
      const fixtures = await fetchLiveFixtures(day, this.fetcher, "upcoming");
      const { matched } = await this.importFixtures(fixtures);
      this.logger.log(`Tracker: ${fixtures.length} not-started fixtures from SportScore for ${day}, ${matched} of our matches mapped`);
    } catch (error) {
      this.logger.warn(`Tracker read of not-started fixtures failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Runs the matcher for one event and saves the answer (a miss is saved too, as "none"). */
  private async match(event: { id: string; homeTeam: string | null; awayTeam: string | null; startsAt: Date }) {
    const window = { gte: new Date(event.startsAt.getTime() - KICKOFF_TOLERANCE_MS), lte: new Date(event.startsAt.getTime() + KICKOFF_TOLERANCE_MS) };
    const candidates = await this.prisma.trackerFixture.findMany({ where: { provider: TRACKER_PROVIDER, kickoff: window } });
    const found = matchTrackerFixture(event, candidates);
    const data = { provider: TRACKER_PROVIDER, externalId: found?.externalId ?? null, confidence: found?.confidence ?? 0, method: found ? "auto" : "none", checkedAt: new Date() };
    return this.prisma.trackerMapping.upsert({ where: { eventId: event.id }, create: { eventId: event.id, ...data }, update: data });
  }

  /** Super Admin: adds fixtures from SportScore's own list, then re-matches the matches around them. */
  async importFixtures(fixtures: TrackerFixtureInput[]) {
    const rows = fixtures.map((fixture) => ({ provider: TRACKER_PROVIDER, externalId: fixture.id, homeTeam: fixture.home.trim(), awayTeam: fixture.away.trim(), kickoff: new Date(fixture.kickoff) }));
    await this.prisma.$transaction(
      rows.map((row) =>
        this.prisma.trackerFixture.upsert({
          where: { provider_externalId: { provider: row.provider, externalId: row.externalId } },
          create: row,
          update: { homeTeam: row.homeTeam, awayTeam: row.awayTeam, kickoff: row.kickoff, importedAt: new Date() },
        }),
      ),
    );
    if (rows.length === 0) return { imported: 0, matched: 0 };
    const times = rows.map((row) => row.kickoff.getTime());
    const events = await this.prisma.event.findMany({
      where: {
        sport: "football",
        status: { in: [EventStatus.UPCOMING, EventStatus.LIVE] },
        startsAt: { gte: new Date(Math.min(...times) - KICKOFF_TOLERANCE_MS), lte: new Date(Math.max(...times) + KICKOFF_TOLERANCE_MS) },
        OR: [{ trackerMapping: null }, { trackerMapping: { method: { not: "manual" } } }],
      },
      select: { id: true, homeTeam: true, awayTeam: true, startsAt: true },
    });
    let matched = 0;
    for (const event of events) if ((await this.match(event)).externalId) matched += 1;
    this.logger.log(`Tracker fixtures imported: ${rows.length}; matches mapped: ${matched} of ${events.length}`);
    return { imported: rows.length, matched };
  }

  /** Super Admin: sets (or with null, clears and blocks) a match's tracker id by hand. */
  async setManual(eventId: string, externalId: string | null) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) throw new NotFoundException("Match not found");
    const data = { provider: TRACKER_PROVIDER, externalId, confidence: externalId ? 1 : 0, method: "manual", checkedAt: new Date() };
    return this.prisma.trackerMapping.upsert({ where: { eventId }, create: { eventId, ...data }, update: data });
  }

  /** Super Admin: back to automatic matching. */
  async clearManual(eventId: string) {
    await this.prisma.trackerMapping.deleteMany({ where: { eventId } });
    return { ok: true };
  }
}
