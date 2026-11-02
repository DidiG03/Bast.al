import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { EventStatus, Role } from "@prisma/client";
import type { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";
import { TRACKER_ATTRIBUTION_URL, TRACKER_PROVIDER, trackerEmbedSrc, trackerEnabled } from "./tracker-embed";
import { KICKOFF_TOLERANCE_MS, matchTrackerFixture } from "./tracker-match";

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
export class TrackerService {
  private readonly logger = new Logger(TrackerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** What a match page should frame, if anything. */
  async forEvent(actor: Actor, eventId: string, lang: "sq" | "en", theme: "light" | "dark"): Promise<TrackerView> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, sport: true, status: true, hidden: true, homeTeam: true, awayTeam: true, startsAt: true, trackerMapping: true },
    });
    if (!event || (event.hidden && actor.role !== Role.SUPER_ADMIN)) throw new NotFoundException("Match not found");
    if (!trackerEnabled() || event.sport !== "football" || event.status !== EventStatus.LIVE) return { show: false };
    let mapping = event.trackerMapping;
    if (!mapping || (mapping.method !== "manual" && !mapping.externalId && Date.now() - mapping.checkedAt.getTime() > RECHECK_MS)) {
      mapping = await this.match(event);
    }
    const src = mapping?.externalId ? trackerEmbedSrc(mapping.externalId, lang, theme) : null;
    return src ? { show: true, provider: TRACKER_PROVIDER, src, attributionUrl: TRACKER_ATTRIBUTION_URL } : { show: false };
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
