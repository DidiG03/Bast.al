import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { EventStatus, Role } from "@prisma/client";
import type { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";
import { TRACKER_ATTRIBUTION_URL, TRACKER_PROVIDER, trackerEmbedSrc, trackerEnabled } from "./tracker-embed";
import { KICKOFF_TOLERANCE_MS, MIN_NAME_SCORE, matchTrackerFixture, otherNames, teamScore } from "./tracker-match";
import { fetchLiveFixtures, fetchTeamFixtures, searchTeams, sportScoreKey, teamSlug, type SportScoreFixture } from "./sportscore-feed";

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
/** A live match the live list didn't give us is looked up by its teams at most this often. */
const LOOKUP_MS = 10 * 60_000;
/** SportScore requests one lookup of a match may make (team queries and searches). */
const LOOKUP_REQUESTS = 6;
/** Matches looked up by team in one timed sync: few without a key (their ~10,000 a day is shared with the early goal reads). */
const LOOKUPS_PER_SYNC_ANONYMOUS = 4;
const LOOKUPS_PER_SYNC_KEYED = 40;
/** A team's SportScore slug found by search is kept this long. */
const SLUG_KEEP_MS = 6 * 3_600_000;
/** A warning that repeats (the live list empty) is logged at most this often. */
const WARN_EVERY_MS = 10 * 60_000;

export interface TrackerFixtureInput {
  id: string;
  home: string;
  away: string;
  kickoff: string;
}

/**
 * `reason: "unavailable"`: the match should have a tracker (live or about to
 * start football, the widget on) but none could be found; the page says so
 * instead of leaving a gap. Without a reason there is simply no tracker here.
 */
export type TrackerView = { show: false; reason?: "unavailable" } | { show: true; provider: string; src: string; attributionUrl: string };

type LookupEvent = { id: string; name?: string | null; homeTeam: string | null; awayTeam: string | null; startsAt: Date };

/**
 * The live match tracker. The widget is display only. The link it keeps from
 * each of our matches to SportScore's (TrackerMapping) is also read by the
 * early goal signals (odds/early-goal.service.ts), so matches are linked
 * whenever those are on, even with the widget off. This service reads none of
 * the betting state beyond whether a match is live.
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
  /** When each match was last looked up by its teams. */
  private readonly lookedUpAt = new Map<string, number>();
  /** Team slugs SportScore's search gave for a name (null: none found), and when. */
  private readonly slugs = new Map<string, { slug: string | null; at: number }>();
  private readonly warnedAt = new Map<string, number>();
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
    // The widget, or the early goal signals (which pause betting on a goal SportScore shows first), need the links.
    if (!trackerEnabled() && process.env.EARLY_GOALS === "off") return null;
    // One read at a time: a page view during a read waits for that read.
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync(now).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync(now: Date): Promise<{ fetched: number; matched: number } | null> {
    try {
      const waitingWhere = { sport: "football", status: EventStatus.LIVE, hidden: false, OR: [{ trackerMapping: null }, { trackerMapping: { externalId: null, method: { not: "manual" } } }] };
      const waiting = await this.prisma.event.count({ where: waitingWhere });
      if (waiting === 0) return null;
      this.lastSyncAt = Date.now();
      // Their fixture days are UTC: just after midnight, matches that kicked off yesterday are still on.
      const days = [now.toISOString().slice(0, 10)];
      if (now.getUTCHours() < 3) days.push(new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10));
      let fixtures: SportScoreFixture[] = [];
      try {
        fixtures = (await Promise.all(days.map((day) => fetchLiveFixtures(day, this.fetcher)))).flat();
      } catch (error) {
        this.warnOnce("live-failed", `Tracker: SportScore's live list failed (${error instanceof Error ? error.message : String(error)}); looking matches up by team`);
      }
      if (fixtures.length === 0) {
        const live = await this.prisma.event.count({ where: { sport: "football", status: EventStatus.LIVE, hidden: false } });
        this.warnOnce("live-empty", `Tracker: SportScore's live list is empty while ${live} of our football matches are live (${waiting} without a tracker); existing links are kept, the rest are looked up by team`);
      }
      await this.prisma.trackerFixture.deleteMany({ where: { kickoff: { lt: new Date(now.getTime() - KEEP_FIXTURES_MS) } } });
      // An empty list imports nothing and so unlinks nothing: links already made stay.
      let { matched } = await this.importFixtures(fixtures);
      // Matches the live list didn't give us: by their teams, a few each time (the ones not looked at for longest first).
      const still = await this.prisma.event.findMany({ where: waitingWhere, select: { id: true, name: true, homeTeam: true, awayTeam: true, startsAt: true }, orderBy: { startsAt: "desc" }, take: 200 });
      const due = still
        .filter((event) => Date.now() - (this.lookedUpAt.get(event.id) ?? 0) >= LOOKUP_MS)
        .sort((a, b) => (this.lookedUpAt.get(a.id) ?? 0) - (this.lookedUpAt.get(b.id) ?? 0))
        .slice(0, sportScoreKey() ? LOOKUPS_PER_SYNC_KEYED : LOOKUPS_PER_SYNC_ANONYMOUS);
      for (const event of due) if (await this.lookUp(event, now)) matched += 1;
      this.logger.log(`Tracker sync: ${fixtures.length} live fixtures from SportScore, ${matched} of our matches mapped (${waiting} were waiting, ${due.length} looked up by team)`);
      return { fetched: fixtures.length, matched };
    } catch (error) {
      // SportScore being down only means no tracker; it never touches anything else.
      this.logger.warn(`Tracker sync failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private warnOnce(key: string, message: string) {
    if (Date.now() - (this.warnedAt.get(key) ?? 0) < WARN_EVERY_MS) return;
    this.warnedAt.set(key, Date.now());
    this.logger.warn(message);
  }

  /** SportScore's slug for a team: its search, kept a while. */
  private async searchedSlug(name: string, spent: { n: number }): Promise<string | null> {
    const kept = this.slugs.get(name);
    if (kept && Date.now() - kept.at < SLUG_KEEP_MS) return kept.slug;
    let best: { slug: string; score: number } | null = null;
    for (const query of otherNames(name).slice(0, 2)) {
      if (spent.n >= LOOKUP_REQUESTS) break;
      spent.n += 1;
      for (const team of await searchTeams(query, this.fetcher)) {
        const score = teamScore(name, team.name);
        if (score >= MIN_NAME_SCORE && (!best || score > best.score)) best = { slug: team.slug, score };
      }
      if (best) break;
    }
    this.slugs.set(name, { slug: best?.slug ?? null, at: Date.now() });
    if (this.slugs.size > 2000) for (const [key, row] of this.slugs) if (Date.now() - row.at > SLUG_KEEP_MS) this.slugs.delete(key);
    return best?.slug ?? null;
  }

  /**
   * Looks one match up on SportScore by its teams (whatever SportScore's
   * status filter says): first by a slug made from each name (and a country's
   * other names), then through their search. Imports what it finds and says
   * whether the match is now linked; when not, logs why.
   */
  private async lookUp(event: LookupEvent, now: Date): Promise<boolean> {
    if (!event.homeTeam || !event.awayTeam) return false;
    this.lookedUpAt.set(event.id, Date.now());
    if (this.lookedUpAt.size > 2000) for (const [key, at] of this.lookedUpAt) if (Date.now() - at > LOOKUP_MS * 6) this.lookedUpAt.delete(key);
    const days = [...new Set([event.startsAt.toISOString().slice(0, 10), now.toISOString().slice(0, 10)])];
    const spent = { n: 0 };
    const tried = new Set<string>();
    const seen: SportScoreFixture[] = [];
    const errors: string[] = [];
    const tryTeam = async (slug: string | null) => {
      if (!slug || tried.has(slug)) return false;
      tried.add(slug);
      for (const day of days) {
        if (spent.n >= LOOKUP_REQUESTS) return false;
        spent.n += 1;
        try {
          const found = await fetchTeamFixtures(slug, day, this.fetcher);
          if (found.length === 0) continue;
          seen.push(...found);
          await this.importFixtures(found);
          const mapping = await this.prisma.trackerMapping.findUnique({ where: { eventId: event.id } });
          if (mapping?.externalId) return true;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return false;
    };
    try {
      for (const name of [event.homeTeam, event.awayTeam]) for (const other of otherNames(name).slice(0, 2)) if (await tryTeam(teamSlug(other))) return true;
      for (const name of [event.homeTeam, event.awayTeam]) {
        if (spent.n >= LOOKUP_REQUESTS) break;
        if (await tryTeam(await this.searchedSlug(name, spent))) return true;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const label = event.name ?? `${event.homeTeam} vs ${event.awayTeam}`;
    if (errors.length > 0 && seen.length === 0) this.logger.warn(`Tracker: no tracker for ${label}: SportScore errors (${[...new Set(errors)].join("; ")})`);
    else if (seen.length > 0)
      this.logger.warn(`Tracker: no tracker for ${label}: names or kick-off didn't match SportScore's (${[...new Set(seen.map((f) => `${f.home} v ${f.away} ${f.kickoff}`))].slice(0, 4).join(", ")})`);
    else this.logger.warn(`Tracker: no tracker for ${label}: SportScore has no fixture for either team (tried ${[...tried].join(", ") || "nothing"})`);
    return false;
  }

  /** What a match page should frame, if anything. */
  async forEvent(actor: Actor, eventId: string, lang: "sq" | "en", theme: "light" | "dark"): Promise<TrackerView> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, sport: true, status: true, hidden: true, name: true, homeTeam: true, awayTeam: true, startsAt: true, trackerMapping: true },
    });
    if (!event || (event.hidden && actor.role !== Role.SUPER_ADMIN)) throw new NotFoundException("Match not found");
    const soon = event.status === EventStatus.UPCOMING && event.startsAt.getTime() - Date.now() < UPCOMING_MS;
    if (!trackerEnabled() || event.sport !== "football" || (event.status !== EventStatus.LIVE && !soon)) return { show: false };
    let mapping = event.trackerMapping;
    if (!mapping || (mapping.method !== "manual" && !mapping.externalId && Date.now() - mapping.checkedAt.getTime() > RECHECK_MS)) {
      mapping = await this.match(event);
    }
    // Still nothing: read SportScore now (live: at most once a minute; not started: that day's list, every 10 minutes at most),
    // then this match by its teams, every 10 minutes at most: someone is looking at it.
    if (!mapping.externalId && mapping.method !== "manual") {
      if (soon) await this.readUpcoming(event.startsAt);
      else if (Date.now() - this.lastSyncAt > ON_VIEW_SYNC_MS) await this.sync();
      mapping = (await this.prisma.trackerMapping.findUnique({ where: { eventId } })) ?? mapping;
      if (!mapping.externalId && mapping.method !== "manual" && Date.now() - (this.lookedUpAt.get(eventId) ?? 0) >= LOOKUP_MS) {
        await this.lookUp(event, new Date()).catch((error) => this.logger.warn(`Tracker lookup for ${eventId} failed: ${error instanceof Error ? error.message : String(error)}`));
        mapping = (await this.prisma.trackerMapping.findUnique({ where: { eventId } })) ?? mapping;
      }
    }
    // A confident or manual link always shows: nothing else (the live list, the early goal reads' budget) hides it.
    const src = mapping?.externalId ? trackerEmbedSrc(mapping.externalId, lang, theme) : null;
    if (src) return { show: true, provider: TRACKER_PROVIDER, src, attributionUrl: TRACKER_ATTRIBUTION_URL };
    // Chosen by hand to have none: nothing to say. Otherwise the page says the tracker isn't available just now.
    // (A link with no usable embed address is a setup matter, not this match's: nothing either.)
    return mapping?.method === "manual" || mapping?.externalId ? { show: false } : { show: false, reason: "unavailable" };
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
    // A link already made stays when nothing better turns up (its fixture may be missing from what was just read).
    if (!found) {
      const existing = await this.prisma.trackerMapping.findUnique({ where: { eventId: event.id } });
      if (existing?.externalId && existing.method === "auto") return existing;
    }
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
