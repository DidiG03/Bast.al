import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { EventStatus, Prisma, Role } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";
import { type LiveDelta, RealtimeService, STAFF_TOPIC, teamTopic } from "../realtime/realtime.service";
import type { MatchCentre } from "./api-football";
import { OddsSyncService } from "./odds-sync.service";
import { competitionKey, feedDelay, lagStats } from "./feed-delay";
import { LATE_REASONS, timelineOf } from "../bets/late";
import { MAX_ABOVE_FEED, MAX_MARGIN, MAX_ODDS, MIN_ODDS, RACE_CLOSE_MS, applyMargin, eventOpen, livePause, marketPause, marketStale, pauseSummary, priceCeiling, selectionQuote, teamMargin } from "./pricing";

const num = (value: Prisma.Decimal | number | null | undefined) => (value === null || value === undefined ? null : Number(value));

export type EventFilter = "upcoming" | "live" | "finished";
export type Sport = "football" | "greyhounds" | "mma" | "basketball" | "nfl" | "tennis" | "volleyball" | "handball";

/** How long a finished match stays on the live list, marked full time. */
const JUST_FINISHED_MS = 10 * 60_000;
/**
 * A football match still "live" this long after kick-off has finished; the feed just never said so (it dropped the
 * match, or kept its last minute). Extra time and penalties are over well inside it. It leaves the live lists; the
 * result still settles from the feed as usual.
 */
const FOOTBALL_LIVE_MAX_MS = 3.5 * 3_600_000;

/** Live matches still worth listing: for football, not one stuck at its last minute hours after kick-off. */
function stillLive(sport: Sport, now: Date): Prisma.EventWhereInput {
  return { status: EventStatus.LIVE, ...(sport === "football" ? { startsAt: { gte: new Date(now.getTime() - FOOTBALL_LIVE_MAX_MS) } } : {}) };
}

/** The most matches the list view sends: a week of every synced league, with room to spare. */
const LIST_LIMIT = 2_000;

type PricedEvent = Prisma.EventGetPayload<{ include: { markets: { include: { selections: true } }; _count: { select: { markets: true } } } }>;

const COUNT_MARKETS = { _count: { select: { markets: true } } } as const;

/** A live match's prices sent to a team are forgotten this long after its last update (it finished, or stopped being sent). */
const LIVE_SENT_KEPT_MS = 30 * 60_000;

/**
 * Live betting only where the feed keeps up: a competition whose goals reached
 * the site later than LIVE_COMPETITION_MAX_LAG_MS at its 95th percentile
 * (lagStats, over the last LIVE_LIMIT_DAYS days, from at least
 * LIVE_COMPETITION_MIN_GOALS goals) is offered before kick-off only.
 * LIVE_COMPETITION_MAX_LAG_MS=0 turns it off.
 */
const LIVE_COMPETITION_MAX_LAG_MS = process.env.LIVE_COMPETITION_MAX_LAG_MS !== undefined && process.env.LIVE_COMPETITION_MAX_LAG_MS !== "" ? Number(process.env.LIVE_COMPETITION_MAX_LAG_MS) : 15_000;
const LIVE_COMPETITION_MIN_GOALS = Number(process.env.LIVE_COMPETITION_MIN_GOALS) > 0 ? Number(process.env.LIVE_COMPETITION_MIN_GOALS) : 5;
const LIVE_LIMIT_DAYS = 3;
/**
 * Cards and corners markets are left off live matches in a competition whose
 * last LIVE_STATS_MIN_MATCHES or more live matches (over LIVE_STATS_DAYS days)
 * never had a live price for them from the feed.
 */
const LIVE_STATS_DAYS = 30;
const LIVE_STATS_MIN_MATCHES = 3;
/** How long the competitions' live limits are kept before they're worked out again. */
const LIVE_LIMITS_TTL_MS = 5 * 60_000;
const CARDS_MARKET = /^(home_|away_)?cards_/;
const CORNERS_MARKET = /^(home_|away_)?corners_/;

/** Which competitions have live limits ("provider · league", competitionKey). */
export type LiveLimits = { slow: Set<string>; noCards: Set<string>; noCorners: Set<string> };

/** How many matches one account can star. */
const MAX_FAVOURITES = 200;
/** How many kinds of market one account can star. */
const MAX_FAVOURITE_MARKETS = 60;
/** A market's key, or "lines:<prefix>" for an over/under market at any line. */
const MARKET_KIND = /^(lines:)?[a-z0-9_]{1,60}$/;

/**
 * How long one read of a match list serves everyone who asks for it, in ms.
 * Reading a week of football with each match's main market takes over a
 * tenth of a second and is the same for every Player (only pricing is per
 * team, and it isn't kept), so on a busy page each Player's refresh would
 * otherwise read it all again. Live lists are kept briefly, since their
 * prices move; the page refreshes them every 10 seconds anyway.
 */
const LIST_TTL_MS: Record<EventFilter | "top", number> = { live: 2_000, upcoming: 5_000, finished: 30_000, top: 5_000 };

const FILTER_STATUSES: Record<EventFilter, EventStatus[]> = {
  upcoming: [EventStatus.UPCOMING, EventStatus.POSTPONED],
  live: [EventStatus.LIVE],
  finished: [EventStatus.COMPLETED, EventStatus.CANCELLED],
};

/**
 * Prices for each team. Every team starts from the feed price less Super
 * Admin's base margin. An Owner can add (or give back) margin for their whole
 * team, and set their own price on any single selection. Managers and Players
 * see their Owner's prices; nobody outside a team sees them.
 */
/** A selection's price as one Player's team sees it, and whether it can be bet on now. */
export type PlayerPrice = { odds: number; bettable: boolean; live: boolean; score: string; sp: boolean; marketKey: string; margin: number };

@Injectable()
export class OddsService {
  private readonly logger = new Logger(OddsService.name);
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Reads kept for a few seconds (see `kept`). */
  private readonly keptReads = new Map<string, { value: unknown; until: number }>();
  /**
   * What each team was last sent for each live match (see pushLive), so the
   * next push carries only what changed: by topic, then match, a value per
   * header, market and selection.
   */
  private readonly liveSent = new Map<string, Map<string, { at: number; values: Map<string, string> }>>();
  private limitsKept: { at: number; value: LiveLimits } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sync: OddsSyncService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {
    if (realtime) this.sync.onLiveSaved = (eventIds) => this.pushLive(eventIds);
  }

  /**
   * Sends the live prices just saved straight to the pages, so a Player sees
   * a price move, a goal or a pause the moment it's saved, without asking
   * for the list again. Each team's Players get their own team's prices
   * (live prices are the feed less the team margin; an Owner's own prices
   * don't apply in play), and only what changed since that team's last push.
   * Staff see feed prices, so their pages are told to fetch instead.
   */
  async pushLive(eventIds: string[]) {
    if (!this.realtime || eventIds.length === 0) return;
    const now = new Date();
    const [events, platform, owners] = await Promise.all([
      this.prisma.event.findMany({
        where: { id: { in: [...new Set(eventIds)] } },
        include: {
          markets: {
            select: {
              id: true,
              key: true,
              name: true,
              sortOrder: true,
              liveSuspended: true,
              livePausedAt: true,
              livePausedUntil: true,
              liveReopenFrom: true,
              livePauseReason: true,
              liveQuotedAt: true,
              selections: { select: { id: true, feedOdds: true, liveOdds: true, result: true, withdrawn: true } },
            },
          },
        },
      }),
      this.platform(),
      this.prisma.user.findMany({ where: { role: Role.OWNER }, select: { id: true, oddsMargin: true } }),
    ]);
    const limits = await this.liveLimits();
    const baseMargin = Number(platform.baseOddsMargin);
    const teams = [{ topic: teamTopic(null), margin: 0 }, ...owners.map((owner) => ({ topic: teamTopic(owner.id), margin: num(owner.oddsMargin) ?? 0 }))];

    for (const team of teams) {
      let sent = this.liveSent.get(team.topic);
      if (!sent) this.liveSent.set(team.topic, (sent = new Map()));
      for (const [id, entry] of sent) if (now.getTime() - entry.at > LIVE_SENT_KEPT_MS) sent.delete(id);
      const deltas: LiveDelta[] = [];
      for (const row of events) {
        const live = row.status === EventStatus.LIVE;
        const view = this.liveView(row, limits);
        const event = { ...row, liveSlowCompetition: view.slow, markets: row.markets.filter((market) => !view.hides(market.key)) };
        const before = sent.get(event.id)?.values ?? new Map<string, string>();
        const values = new Map<string, string>();
        const delta: LiveDelta = { id: event.id };
        const header = {
          status: event.status,
          live,
          elapsed: event.elapsed,
          period: live ? event.period : event.status === EventStatus.COMPLETED ? "FT" : null,
          homeScore: event.homeScore,
          awayScore: event.awayScore,
          bettable: eventOpen(event, now),
          livePause: livePause(event, now),
          allMarketsSuspended: live && event.markets.length > 0 && event.markets.every((market) => market.liveSuspended),
          marketPause: live ? pauseSummary(event.markets, now) : null,
        };
        const headerKey = JSON.stringify(header);
        values.set("h", headerKey);
        if (before.get("h") !== headerKey) delta.header = header;
        for (const market of event.markets) {
          const stale = marketStale(event, market, now, market.selections.some((s) => s.liveOdds !== null));
          const suspended = live && (market.liveSuspended || market.selections.every((s) => s.liveOdds === null) || marketPause(market, now) !== null || stale);
          const value = `${suspended ? 1 : 0}${stale ? 1 : 0}`;
          values.set(`m:${market.id}`, value);
          if (before.get(`m:${market.id}`) !== value) (delta.markets ??= []).push([market.id, suspended, stale]);
          for (const selection of market.selections) {
            const quote = selectionQuote({
              event,
              market,
              selection: { feedOdds: Number(selection.feedOdds), liveOdds: num(selection.liveOdds), result: selection.result, withdrawn: selection.withdrawn },
              baseMargin,
              ownerMargin: team.margin,
              override: null,
              now,
            });
            const value = `${quote.price}|${quote.suspended ? 1 : 0}`;
            values.set(`s:${selection.id}`, value);
            if (before.get(`s:${selection.id}`) !== value) (delta.prices ??= []).push([selection.id, quote.price, quote.suspended]);
          }
        }
        // A finished match is sent once more (its header) and then forgotten.
        if (live) sent.set(event.id, { at: now.getTime(), values });
        else sent.delete(event.id);
        if (delta.header || delta.markets || delta.prices) deltas.push(delta);
      }
      if (deltas.length > 0) await this.realtime.publishTopic(team.topic, { type: "odds.live", at: now.toISOString(), events: deltas });
    }
    // The live lists kept for a few seconds are out of date now.
    for (const key of this.keptReads.keys()) if (key.startsWith("list:") && key.includes(":live:")) this.keptReads.delete(key);
    await this.realtime.publishTopic(STAFF_TOPIC, { type: "odds.changed" });
  }

  async settings(actor: Actor, ownerIdParam?: string) {
    const [platform, ownerId] = await Promise.all([this.platform(), this.teamOwnerFor(actor, ownerIdParam)]);
    const baseMargin = Number(platform.baseOddsMargin);
    const owner = ownerId ? await this.prisma.user.findUnique({ where: { id: ownerId }, select: { id: true, username: true, oddsMargin: true } }) : null;
    const ownerMargin = num(owner?.oddsMargin) ?? 0;
    return {
      baseMargin,
      team: owner ? { ownerId: owner.id, ownerName: owner.username, margin: ownerMargin, effectiveMargin: teamMargin(baseMargin, ownerMargin) } : null,
      canEditBase: actor.role === Role.SUPER_ADMIN,
      canEditTeam: actor.role === Role.OWNER || (actor.role === Role.SUPER_ADMIN && owner !== null),
      canManageEvents: actor.role === Role.SUPER_ADMIN,
      feed: actor.role === Role.PLAYER ? null : { mode: this.sync.mode, syncedAt: platform.oddsSyncedAt, status: platform.oddsSyncStatus },
      limits: { minOdds: MIN_ODDS, maxOdds: MAX_ODDS, maxMargin: MAX_MARGIN, maxAboveFeed: MAX_ABOVE_FEED },
    };
  }

  /**
   * Pre-match feed price history for one selection, for the movement chart.
   * Players never see the raw feed price (same rule as `events`), so their
   * history is shown through today's team margin instead — an approximation,
   * since margin history itself isn't tracked, but it keeps the shape of the
   * chart honest without exposing exactly what a team's margin is.
   */
  async priceHistory(actor: Actor, selectionId: string) {
    const selection = await this.prisma.selection.findUnique({
      where: { id: selectionId },
      select: { market: { select: { event: { select: { hidden: true } } } } },
    });
    if (!selection) throw new NotFoundException("Selection not found");
    if (selection.market.event.hidden && actor.role !== Role.SUPER_ADMIN) throw new NotFoundException("Selection not found");

    const points = await this.prisma.oddsSnapshot.findMany({
      where: { selectionId },
      orderBy: { recordedAt: "asc" },
      take: 200,
      select: { price: true, recordedAt: true },
    });

    if (actor.role !== Role.PLAYER) {
      return points.map((point) => ({ price: num(point.price)!, recordedAt: point.recordedAt }));
    }

    const [platform, ownerId] = await Promise.all([this.platform(), this.teamOwnerFor(actor)]);
    const baseMargin = Number(platform.baseOddsMargin);
    const ownerMargin = ownerId ? num((await this.prisma.user.findUnique({ where: { id: ownerId }, select: { oddsMargin: true } }))?.oddsMargin) ?? 0 : 0;
    const margin = teamMargin(baseMargin, ownerMargin);
    return points.map((point) => ({ price: applyMargin(num(point.price)!, margin), recordedAt: point.recordedAt }));
  }

  /**
   * Matches with their markets priced for the viewer's team. Super Admin sees
   * feed prices less the base margin, or a chosen Owner's prices. The "list"
   * view sends each match's main market only, plus how many markets it has,
   * so the whole week's football stays a small download; a match's other
   * markets come from `event`.
   */
  async events(actor: Actor, filter: EventFilter = "upcoming", ownerIdParam?: string, view?: "list", sport: Sport = "football") {
    const isAdmin = actor.role === Role.SUPER_ADMIN;
    const now = new Date();
    const where: Prisma.EventWhereInput = {
      sport,
      // Live also keeps matches that finished in the last few minutes, marked full time, so they don't just vanish.
      ...(filter === "live"
        ? { OR: [stillLive(sport, now), { status: EventStatus.COMPLETED, finishedAt: { gte: new Date(now.getTime() - JUST_FINISHED_MS) } }] }
        : { status: { in: FILTER_STATUSES[filter] } }),
      ...(isAdmin ? {} : { hidden: false }),
      // Finished matches only for the last three days; races (dozens an hour) for the last six hours.
      ...(filter === "finished" ? { startsAt: { gte: new Date(now.getTime() - (sport === "greyhounds" ? 6 * 3_600_000 : 3 * 86_400_000)) } } : {}),
    };
    const orderBy: Prisma.EventOrderByWithRelationInput = { startsAt: filter === "finished" ? "desc" : "asc" };
    const events =
      view === "list"
        ? // Everyone browsing asks for the same list: requests that arrive together share one read.
          await this.kept(`list:${sport}:${filter}:${isAdmin}`, LIST_TTL_MS[filter], async () => this.withMainMarket(await this.prisma.event.findMany({ where, orderBy, take: LIST_LIMIT, include: COUNT_MARKETS })))
        : await this.prisma.event.findMany({
            where,
            orderBy,
            take: 200,
            include: { markets: { orderBy: { sortOrder: "asc" }, include: { selections: { orderBy: { sortOrder: "asc" } } } }, ...COUNT_MARKETS },
          });
    return this.priced(actor, events, ownerIdParam, now);
  }

  /**
   * The matches a Player's home page leads with: live ones, then the ones
   * starting in the next two days with the most to bet on (the big leagues
   * have the most markets), soonest first when that's equal. Picked here, so
   * the page doesn't download the whole week's list for four matches.
   */
  async topEvents(actor: Actor, count = 4, sport: Sport = "football") {
    const now = new Date();
    if (sport === "greyhounds") return this.nextRaces(actor, count, now);
    const soon = now.getTime() + 2 * 86_400_000;
    const rows = await this.kept(`top:${sport}`, LIST_TTL_MS.top, () =>
      this.prisma.event.findMany({
        where: { sport, OR: [stillLive(sport, now), { status: { in: FILTER_STATUSES.upcoming } }], hidden: false },
        orderBy: { startsAt: "asc" },
        take: LIST_LIMIT,
        include: COUNT_MARKETS,
      }),
    );
    const open = rows.filter((event) => (event.status === EventStatus.LIVE || eventOpen(event, now)) && event._count.markets > 0);
    const byMarkets = (a: (typeof rows)[number], b: (typeof rows)[number]) => b._count.markets - a._count.markets || a.startsAt.getTime() - b.startsAt.getTime();
    const live = open.filter((event) => event.status === EventStatus.LIVE).sort(byMarkets);
    const upcoming = open.filter((event) => event.status !== EventStatus.LIVE);
    const next = upcoming.filter((event) => event.startsAt.getTime() <= soon).sort(byMarkets);
    const later = upcoming.filter((event) => event.startsAt.getTime() > soon);
    const top = [...live.slice(0, 2), ...next, ...live.slice(2), ...later].slice(0, Math.min(Math.max(count, 1), 12));
    return this.priced(actor, await this.withMainMarket(top), undefined, now);
  }

  /** The next races still open for bets, soonest first. */
  private async nextRaces(actor: Actor, count: number, now: Date) {
    const rows = await this.prisma.event.findMany({
      where: { sport: "greyhounds", status: EventStatus.UPCOMING, hidden: false, suspended: false, startsAt: { gt: new Date(now.getTime() + RACE_CLOSE_MS) } },
      orderBy: { startsAt: "asc" },
      take: Math.min(Math.max(count, 1), 12),
      include: COUNT_MARKETS,
    });
    return this.priced(actor, await this.withMainMarket(rows.filter((race) => race._count.markets > 0)), undefined, now);
  }

  /**
   * Adds each match's main market (its first). Done as its own query on
   * purpose: Prisma applies a nested `take: 1` after loading every market and
   * every selection of every match, which for a week of football is around a
   * million rows thrown away on each refresh.
   */
  private async withMainMarket<E extends { id: string }>(events: E[]): Promise<Array<E & { markets: PricedEvent["markets"] }>> {
    if (events.length === 0) return [];
    const first = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON (event_id) id FROM markets
      WHERE event_id = ANY(${events.map((event) => event.id)}::text[])
      ORDER BY event_id, sort_order, id
    `;
    const markets = first.length
      ? await this.prisma.market.findMany({ where: { id: { in: first.map((row) => row.id) } }, include: { selections: { orderBy: { sortOrder: "asc" } } } })
      : [];
    const byEvent = new Map(markets.map((market) => [market.eventId, market]));
    return events.map((event) => {
      const market = byEvent.get(event.id);
      return { ...event, markets: market ? [market] : [] };
    });
  }

  /**
   * Like `shared`, and the answer is then kept for `ttlMs`: everyone asking
   * for the same `key` in that time gets the same read. A failed read isn't
   * kept.
   */
  private async kept<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.keptReads.get(key);
    if (hit && hit.until > Date.now()) return hit.value as T;
    const value = await this.shared(key, load);
    this.keptReads.set(key, { value, until: Date.now() + ttlMs });
    return value;
  }

  /** Drops the match lists kept for a few seconds, so the next read is fresh. */
  forgetLists() {
    this.keptReads.clear();
  }

  /** Runs `load` once for every caller that asks for the same `key` while it's running. */
  private shared<T>(key: string, load: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const promise = load().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** One match with every market priced for the viewer's team. */
  async event(actor: Actor, id: string, ownerIdParam?: string) {
    const event = await this.prisma.event.findUnique({
      where: { id },
      include: {
        markets: { orderBy: { sortOrder: "asc" }, include: { selections: { orderBy: { sortOrder: "asc" } } } },
        _count: { select: { markets: true } },
      },
    });
    if (!event || (event.hidden && actor.role !== Role.SUPER_ADMIN)) throw new NotFoundException("Match not found");
    return (await this.priced(actor, [event], ownerIdParam, new Date()))[0];
  }

  /**
   * A football match's timeline, numbers and team sheets, for anyone who can
   * see the match. Asking keeps them fresh (see OddsSyncService.refreshMatchCentre);
   * everyone asking about the same match within 2 seconds shares one read.
   */
  async matchCentre(actor: Actor, id: string) {
    const event = await this.kept(`centre:${id}`, 2_000, async () => {
      const select = { id: true, sport: true, provider: true, externalId: true, hidden: true, status: true, startsAt: true, finishedAt: true, elapsed: true, period: true, homeScore: true, awayScore: true, matchCentre: true, matchCentreAt: true } as const;
      const saved = await this.prisma.event.findUnique({ where: { id }, select });
      // A hidden match isn't fetched for anyone.
      if (!saved || saved.hidden || !(await this.sync.refreshMatchCentre(saved))) return saved;
      return this.prisma.event.findUnique({ where: { id }, select });
    });
    if (!event || (event.hidden && actor.role !== Role.SUPER_ADMIN)) throw new NotFoundException("Match not found");
    return {
      id: event.id,
      status: event.status,
      elapsed: event.elapsed,
      period: event.status === EventStatus.LIVE ? event.period : event.status === EventStatus.COMPLETED ? "FT" : null,
      homeScore: event.homeScore,
      awayScore: event.awayScore,
      centre: (event.matchCentre as MatchCentre | null) ?? null,
      updatedAt: event.matchCentreAt,
    };
  }

  /** The matches this account starred, newest first. */
  async favourites(actor: Actor): Promise<string[]> {
    const rows = await this.prisma.favouriteEvent.findMany({ where: { userId: actor.id }, orderBy: { createdAt: "desc" }, select: { eventId: true } });
    return rows.map((row) => row.eventId);
  }

  /** Stars a match, or takes the star off. Returns the starred matches. */
  async setFavourite(actor: Actor, eventId: string, starred: boolean): Promise<string[]> {
    if (starred) {
      const event = await this.prisma.event.findUnique({ where: { id: eventId }, select: { hidden: true } });
      if (!event || (event.hidden && actor.role !== Role.SUPER_ADMIN)) throw new NotFoundException("Match not found");
      if ((await this.prisma.favouriteEvent.count({ where: { userId: actor.id } })) >= MAX_FAVOURITES) throw new BadRequestException("You can star up to 200 matches. Take the star off some first.");
      await this.prisma.favouriteEvent.upsert({ where: { userId_eventId: { userId: actor.id, eventId } }, create: { userId: actor.id, eventId }, update: {} });
    } else {
      await this.prisma.favouriteEvent.deleteMany({ where: { userId: actor.id, eventId } });
    }
    return this.favourites(actor);
  }

  /** The kinds of market this account starred, oldest first (the order they show in). */
  async favouriteMarkets(actor: Actor): Promise<string[]> {
    const rows = await this.prisma.favouriteMarket.findMany({ where: { userId: actor.id }, orderBy: { createdAt: "asc" }, select: { marketKey: true } });
    return rows.map((row) => row.marketKey);
  }

  /** Stars a kind of market, or takes the star off. Returns the starred kinds. */
  async setFavouriteMarket(actor: Actor, marketKey: string, starred: boolean): Promise<string[]> {
    if (!MARKET_KIND.test(marketKey)) throw new BadRequestException("That isn't a market");
    if (starred) {
      const count = await this.prisma.favouriteMarket.count({ where: { userId: actor.id } });
      if (count >= MAX_FAVOURITE_MARKETS) throw new BadRequestException(`You can star up to ${MAX_FAVOURITE_MARKETS} markets. Take the star off some first.`);
      await this.prisma.favouriteMarket.upsert({ where: { userId_marketKey: { userId: actor.id, marketKey } }, create: { userId: actor.id, marketKey }, update: {} });
    } else {
      await this.prisma.favouriteMarket.deleteMany({ where: { userId: actor.id, marketKey } });
    }
    return this.favouriteMarkets(actor);
  }

  /**
   * The current price of each pick on a bet slip, and whether it can be bet
   * on, so the slip stays right for markets the page hasn't loaded.
   */
  async selections(actor: Actor, ids: string[], ownerIdParam?: string) {
    const [platform, ownerId] = await Promise.all([this.platform(), this.teamOwnerFor(actor, ownerIdParam)]);
    const baseMargin = Number(platform.baseOddsMargin);
    const ownerMargin = ownerId ? num((await this.prisma.user.findUnique({ where: { id: ownerId }, select: { oddsMargin: true } }))?.oddsMargin) ?? 0 : 0;
    const rows = await this.prisma.selection.findMany({ where: { id: { in: ids.slice(0, 20) } }, include: { market: { include: { event: true } } } });
    const overrides = ownerId && rows.length > 0 ? await this.prisma.oddsOverride.findMany({ where: { ownerId, selectionId: { in: rows.map((r) => r.id) } }, select: { selectionId: true, odds: true } }) : [];
    const overrideBy = new Map(overrides.map((o) => [o.selectionId, Number(o.odds)]));
    const now = new Date();
    const limits = rows.some((row) => row.market.event.status === EventStatus.LIVE) ? await this.liveLimits() : null;
    return rows
      .filter((row) => !row.market.event.hidden || actor.role === Role.SUPER_ADMIN)
      .map((row) => {
        const event = limits ? { ...row.market.event, liveSlowCompetition: this.liveView(row.market.event, limits).slow } : row.market.event;
        const live = event.status === EventStatus.LIVE;
        const quote = selectionQuote({
          event,
          market: row.market,
          selection: { feedOdds: Number(row.feedOdds), liveOdds: num(row.liveOdds), result: row.result, withdrawn: row.withdrawn },
          baseMargin,
          ownerMargin,
          override: live ? null : overrideBy.get(row.id) ?? null,
          now,
        });
        const open = eventOpen(event, now) || live;
        // Over for good, so the slip drops it: the match finished or was called off, the outcome settled, the pick withdrawn, or
        // (in sports bet on only before the start) the start passed. A football match past kick-off may still go live.
        const over = event.status === EventStatus.COMPLETED || event.status === EventStatus.CANCELLED || event.status === EventStatus.POSTPONED;
        const final = !live && (over || row.result !== null || row.withdrawn || (event.sport !== "football" && !open && event.startsAt <= now));
        return { id: row.id, eventId: event.id, price: quote.price, bettable: quote.bettable, suspended: quote.suspended, live, open, final, sp: event.sport === "greyhounds" };
      });
  }

  private async priced(actor: Actor, events: PricedEvent[], ownerIdParam: string | undefined, now: Date) {
    const [platform, ownerId] = await Promise.all([this.platform(), this.teamOwnerFor(actor, ownerIdParam)]);
    const baseMargin = Number(platform.baseOddsMargin);
    const ownerMargin = ownerId ? num((await this.prisma.user.findUnique({ where: { id: ownerId }, select: { oddsMargin: true } }))?.oddsMargin) ?? 0 : 0;

    const selectionIds = events.flatMap((e) => e.markets.flatMap((m) => m.selections.map((s) => s.id)));
    const overrides = ownerId && selectionIds.length > 0
      ? await this.prisma.oddsOverride.findMany({ where: { ownerId, selectionId: { in: selectionIds } }, select: { selectionId: true, odds: true } })
      : [];
    const overrideBy = new Map(overrides.map((o) => [o.selectionId, Number(o.odds)]));
    const showFeed = actor.role !== Role.PLAYER;

    // Someone is watching live matches: the live prices are fetched more often for a while.
    const liveIds = events.filter((event) => event.status === EventStatus.LIVE).map((event) => event.id);
    if (liveIds.length > 0) this.sync.noteLiveInterest();
    // Live matches with a market still on the board (the list carries only each match's first market).
    const withOpenMarket = new Set(
      liveIds.length > 0 ? (await this.prisma.market.groupBy({ by: ["eventId"], where: { eventId: { in: liveIds }, liveSuspended: false } })).map((row) => row.eventId) : [],
    );
    // What's paused on each live match (every market, not only the ones sent), and the live limits of their competitions.
    const pausedMarkets =
      liveIds.length > 0
        ? await this.prisma.market.findMany({
            where: { eventId: { in: liveIds }, livePausedUntil: { gt: now } },
            select: { eventId: true, key: true, name: true, sortOrder: true, livePausedAt: true, livePausedUntil: true, liveReopenFrom: true, livePauseReason: true },
          })
        : [];
    const limits = liveIds.length > 0 ? await this.liveLimits() : null;
    // Cards and corners markets left off live matches in competitions the feed never prices them for live: not counted either.
    const hiddenCounts = new Map<string, number>();
    if (limits && (limits.noCards.size > 0 || limits.noCorners.size > 0)) {
      const limited = events.filter((event) => event.status === EventStatus.LIVE && this.liveView(event, limits).hidesAny);
      if (limited.length > 0) {
        const keys = await this.prisma.market.findMany({ where: { eventId: { in: limited.map((event) => event.id) }, OR: ["cards_", "home_cards_", "away_cards_", "corners_", "home_corners_", "away_corners_"].map((prefix) => ({ key: { startsWith: prefix } })) }, select: { eventId: true, key: true } });
        const views = new Map(limited.map((event) => [event.id, this.liveView(event, limits)]));
        for (const market of keys) if (views.get(market.eventId)?.hides(market.key)) hiddenCounts.set(market.eventId, (hiddenCounts.get(market.eventId) ?? 0) + 1);
      }
    }

    return events.map((row) => {
      const live = row.status === EventStatus.LIVE;
      const race = row.sport === "greyhounds";
      const view = live && limits ? this.liveView(row, limits) : null;
      const event = view ? { ...row, liveSlowCompetition: view.slow, markets: row.markets.filter((market) => !view.hides(market.key)) } : row;
      return {
      id: event.id,
      sport: event.sport,
      name: event.name,
      league: event.league,
      country: event.country,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      homeLogo: event.homeLogo,
      awayLogo: event.awayLogo,
      leagueLogo: event.leagueLogo,
      countryFlag: event.countryFlag,
      startsAt: event.startsAt,
      status: event.status,
      elapsed: event.elapsed,
      /** While live: the feed's phase, e.g. "HT" at half-time. */
      period: event.status === EventStatus.LIVE ? event.period : event.status === EventStatus.COMPLETED ? "FT" : null,
      homeScore: event.homeScore,
      awayScore: event.awayScore,
      hidden: event.hidden,
      suspended: event.suspended,
      provider: event.provider,
      /** Before kick-off, or live with fresh in-play prices. */
      bettable: eventOpen(event, now),
      /** Live only: why bets are paused right now (a goal, a price jump, the bookmaker, the last minutes). */
      livePause: livePause(event, now),
      live,
      /** Live, and the bookmaker has every market off the board for now. */
      allMarketsSuspended: live && event._count.markets > 0 && !withOpenMarket.has(event.id),
      /** Live: the markets paused after something in the match (a goal, a card…), for the match's banner. */
      marketPause: live ? pauseSummary(pausedMarkets.filter((market) => market.eventId === event.id && !view?.hides(market.key)), now) : null,
      /** Every market the match has; the list view sends only the first. */
      marketCount: event._count.markets - (hiddenCounts.get(event.id) ?? 0),
      /** Greyhounds: the race's number, grade and distance, and once run, the finishing order with each dog's SP. */
      race: race ? raceDetails(event.race) : undefined,
      raceResult: race ? event.raceResult : undefined,
      markets: event.markets.map((market) => {
        const selections = market.selections.map((selection) => {
          const feedOdds = Number(selection.feedOdds);
          const liveOdds = num(selection.liveOdds);
          const override = live ? null : overrideBy.get(selection.id) ?? null;
          const quote = selectionQuote({ event, market, selection: { feedOdds, liveOdds, result: selection.result, withdrawn: selection.withdrawn }, baseMargin, ownerMargin, override, now });
          return {
            id: selection.id,
            key: selection.key,
            name: selection.name,
            price: quote.price,
            feedOdds: showFeed && !race ? (live ? liveOdds ?? feedOdds : feedOdds) : undefined,
            /** The highest price the Owner can set on it. */
            maxPrice: showFeed && !live && !race ? priceCeiling(feedOdds) : undefined,
            /** Greyhounds: paid at the starting price (or forecast dividend); `price` is 0. */
            sp: race || undefined,
            /** Greyhounds: the dog's trap and trainer, or a Forecast pair's traps. */
            info: race ? selection.info : undefined,
            custom: override !== null,
            result: selection.result,
            /** Live: the feed isn't pricing this outcome right now. Before kick-off: the feed took it down (see Selection.withdrawn). */
            suspended: quote.suspended,
          };
        });
        const stale = marketStale(event, market, now, market.selections.some((s) => s.liveOdds !== null));
        const paused = live ? marketPause(market, now) : null;
        return {
          id: market.id,
          key: market.key,
          name: market.name,
          /** Live only: off the board right now: the feed has it off (single outcomes can be off on their own), or it's paused. */
          suspended: live && (market.liveSuspended || market.selections.every((s) => s.liveOdds === null) || paused !== null || stale),
          /** Live only: paused after something in the match (a goal, a card…), and why. */
          paused,
          /** Live only: the feed hasn't priced it during play for a while; shown under "Not available during play". */
          stale,
          selections,
        };
      }),
    };
    });
  }

  async setBaseMargin(actor: Actor, margin: number) {
    if (margin < 0 || margin > MAX_MARGIN) throw new BadRequestException(`The base margin must be between 0% and ${MAX_MARGIN}%`);
    const before = await this.platform();
    await this.prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default", baseOddsMargin: margin }, update: { baseOddsMargin: margin } });
    await this.audit.log({ actorId: actor.id, action: "odds.base_margin_update", metadata: { from: Number(before.baseOddsMargin), to: margin } });
    return this.settings(actor);
  }

  /** An Owner's margin for their own team; Super Admin may set it for any Owner. */
  async setTeamMargin(actor: Actor, margin: number, ownerIdParam?: string) {
    const ownerId = await this.editableOwner(actor, ownerIdParam);
    const base = Number((await this.platform()).baseOddsMargin);
    if (base + margin < 0) throw new BadRequestException(`You can lower the margin by at most ${base}%, which gives your team the feed price`);
    if (base + margin > MAX_MARGIN) throw new BadRequestException(`The total margin can't be more than ${MAX_MARGIN}%`);
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { oddsMargin: true } });
    await this.prisma.user.update({ where: { id: ownerId }, data: { oddsMargin: margin } });
    await this.audit.log({ actorId: actor.id, action: "odds.team_margin_update", targetId: ownerId, metadata: { from: Number(before.oddsMargin), to: margin } });
    return this.settings(actor, ownerIdParam);
  }

  async setOverride(actor: Actor, selectionId: string, odds: number, ownerIdParam?: string) {
    const ownerId = await this.editableOwner(actor, ownerIdParam);
    if (!(odds >= MIN_ODDS && odds <= MAX_ODDS)) throw new BadRequestException(`Odds must be between ${MIN_ODDS} and ${MAX_ODDS}`);
    const selection = await this.openSelection(selectionId);
    if (selection.market.event.sport === "greyhounds") throw new BadRequestException("Race bets are paid at the starting price, so they have no price to change");
    const feed = Number(selection.feedOdds);
    const ceiling = priceCeiling(feed);
    if (odds > ceiling) {
      throw new BadRequestException(`That's more than ${MAX_ABOVE_FEED}% above the feed price (${feed.toFixed(2)}). The most you can set is ${ceiling.toFixed(2)}.`);
    }
    const price = new Prisma.Decimal(odds.toFixed(2));
    await this.prisma.oddsOverride.upsert({
      where: { ownerId_selectionId: { ownerId, selectionId } },
      create: { ownerId, selectionId, odds: price },
      update: { odds: price },
    });
    await this.audit.log({
      actorId: actor.id,
      action: "odds.override_set",
      targetId: ownerId,
      metadata: { selectionId, event: selection.market.event.name, market: selection.market.name, selection: selection.name, odds: Number(price) },
    });
    return { selectionId, odds: Number(price) };
  }

  async clearOverride(actor: Actor, selectionId: string, ownerIdParam?: string) {
    const ownerId = await this.editableOwner(actor, ownerIdParam);
    const removed = await this.prisma.oddsOverride.deleteMany({ where: { ownerId, selectionId } });
    if (removed.count > 0) await this.audit.log({ actorId: actor.id, action: "odds.override_clear", targetId: ownerId, metadata: { selectionId } });
    return { selectionId, cleared: removed.count > 0 };
  }

  /** Super Admin: hide a match from everyone, or stop bets on it. */
  async updateEvent(actor: Actor, eventId: string, input: { hidden?: boolean; suspended?: boolean }) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId }, select: { id: true, name: true } });
    if (!event) throw new NotFoundException("Match not found");
    const data: Prisma.EventUpdateInput = {};
    if (input.hidden !== undefined) data.hidden = input.hidden;
    if (input.suspended !== undefined) data.suspended = input.suspended;
    const updated = await this.prisma.event.update({ where: { id: eventId }, data, select: { id: true, hidden: true, suspended: true } });
    // Hidden or stopped now, not once the lists kept for a few seconds run out.
    this.forgetLists();
    await this.audit.log({ actorId: actor.id, action: "odds.event_update", metadata: { eventId, event: event.name, ...input } });
    return updated;
  }

  /**
   * The league picker: what's synced now, the defaults, and every competition
   * the feed has a season in progress for.
   */
  /**
   * The competitions with live limits (LiveLimits), worked out at most every
   * LIVE_LIMITS_TTL_MS: those whose feed is too slow for live betting
   * (LIVE_COMPETITION_MAX_LAG_MS), and those whose recent live matches never
   * had a live price for cards, or for corners.
   */
  async liveLimits(): Promise<LiveLimits> {
    if (this.limitsKept && Date.now() - this.limitsKept.at < LIVE_LIMITS_TTL_MS) return this.limitsKept.value;
    return this.shared("live-limits", async () => {
      const slow = new Set<string>();
      if (LIVE_COMPETITION_MAX_LAG_MS > 0) {
        const lag = await this.feedLagStats(LIVE_LIMIT_DAYS, 0.95).catch(() => null);
        for (const [competition, group] of Object.entries(lag?.byCompetition ?? {})) {
          if (group.goals >= LIVE_COMPETITION_MIN_GOALS && group.p * 1000 >= LIVE_COMPETITION_MAX_LAG_MS) slow.add(competition);
        }
      }
      const since = new Date(Date.now() - LIVE_STATS_DAYS * 86_400_000);
      const rows = await this.prisma.$queryRaw<Array<{ provider: string; league: string; matches: number; cards: boolean; corners: boolean }>>`
        SELECT e.provider, e.league, COUNT(DISTINCT e.id)::int AS matches,
          COALESCE(BOOL_OR(p.cards), false) AS cards, COALESCE(BOOL_OR(p.corners), false) AS corners
        FROM "Event" e
        LEFT JOIN (
          SELECT m.event_id, BOOL_OR(m.key ~ '^(home_|away_)?cards_') AS cards, BOOL_OR(m.key ~ '^(home_|away_)?corners_') AS corners
          FROM markets m JOIN selections s ON s.market_id = m.id JOIN "Event" recent ON recent.id = m.event_id
          WHERE s.live_odds IS NOT NULL AND m.key ~ '^(home_|away_)?(cards|corners)_' AND recent."startsAt" >= ${since}
          GROUP BY m.event_id
        ) p ON p.event_id = e.id
        WHERE e.sport = 'football' AND e.live_odds_at IS NOT NULL AND e."startsAt" >= ${since} AND e.status IN ('LIVE', 'COMPLETED')
        GROUP BY e.provider, e.league`.catch((error) => {
        this.logger.warn(`Competitions without live cards or corners not worked out: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
      const noCards = new Set<string>();
      const noCorners = new Set<string>();
      for (const row of rows) {
        if (row.matches < LIVE_STATS_MIN_MATCHES) continue;
        if (!row.cards) noCards.add(competitionKey(row.provider, row.league));
        if (!row.corners) noCorners.add(competitionKey(row.provider, row.league));
      }
      const value = { slow, noCards, noCorners };
      const before = this.limitsKept?.value;
      if (!before || [...slow].join("|") !== [...before.slow].join("|")) {
        this.logger.log(slow.size > 0 ? `Live betting off (feed too slow, ${LIVE_COMPETITION_MAX_LAG_MS / 1000} s or more at the 95th percentile) in: ${[...slow].join(", ")}` : "Live betting on in every competition: none has a feed too slow for it");
      }
      this.limitsKept = { at: Date.now(), value };
      return value;
    });
  }

  /**
   * Super Admin: how live betting is doing over the last `days` days. The
   * share of live market-time open (taking bets) per match and per
   * competition, out of the markets on the board and out of every market;
   * how long pauses after goals, cards and the like lasted (to the match
   * result reopening), and how many reopened on fresh prices; the share of
   * live picks voided for a goal or card the site hadn't shown yet; the
   * competitions with live limits; and the live polling (the feed plan, how
   * often each match is read and how far behind the bookmaker).
   */
  async liveHealth(days = 1) {
    const since = new Date(Date.now() - days * 86_400_000);
    const [matches, pauses, voids, limits] = await Promise.all([
      this.prisma.event.findMany({
        where: { startsAt: { gte: since }, liveMarketSec: { gt: 0 } },
        select: { id: true, name: true, provider: true, league: true, status: true, startsAt: true, liveMarketSec: true, liveShownSec: true, liveOpenSec: true },
        orderBy: { startsAt: "desc" },
        take: 500,
      }),
      this.prisma.livePause.findMany({ where: { startedAt: { gte: since } }, select: { eventId: true, reason: true, startedAt: true, endsAt: true, fresh: true, event: { select: { provider: true, league: true } } } }),
      this.prisma.$queryRaw<Array<{ provider: string; league: string; picks: number; voided: number }>>`
        SELECT e.provider, e.league, COUNT(*)::int AS picks, (COUNT(*) FILTER (WHERE x.void_reason = ANY(${LATE_REASONS}::text[])))::int AS voided
        FROM (
          SELECT b.selection_id, b.void_reason FROM bets b WHERE b.live IS NOT NULL AND b.selection_id IS NOT NULL AND b.placed_at >= ${since}
          UNION ALL
          SELECT l.selection_id, l.void_reason FROM bet_legs l JOIN bets b ON b.id = l.bet_id WHERE l.live IS NOT NULL AND b.placed_at >= ${since}
        ) x
        JOIN selections s ON s.id = x.selection_id JOIN markets m ON m.id = s.market_id JOIN "Event" e ON e.id = m.event_id
        GROUP BY e.provider, e.league`,
      this.liveLimits(),
    ]);
    const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
    const pauseMs = (rows: typeof pauses) => (rows.length === 0 ? null : Math.round(rows.reduce((sum, row) => sum + Math.max(0, row.endsAt.getTime() - row.startedAt.getTime()), 0) / rows.length));
    // Pauses still running end when they're due; that's the fallback unless fresh prices came.
    const competitions = new Map<string, { market: number; shown: number; open: number; matches: number; pauses: typeof pauses; picks: number; voided: number }>();
    const entry = (key: string) => {
      let row = competitions.get(key);
      if (!row) competitions.set(key, (row = { market: 0, shown: 0, open: 0, matches: 0, pauses: [], picks: 0, voided: 0 }));
      return row;
    };
    for (const match of matches) {
      const row = entry(competitionKey(match.provider, match.league));
      row.market += match.liveMarketSec;
      row.shown += match.liveShownSec;
      row.open += match.liveOpenSec;
      row.matches++;
    }
    for (const pause of pauses) entry(competitionKey(pause.event.provider, pause.event.league)).pauses.push(pause);
    for (const row of voids) Object.assign(entry(competitionKey(row.provider, row.league)), { picks: row.picks, voided: row.voided });
    const totals = matches.reduce((sum, match) => ({ market: sum.market + match.liveMarketSec, shown: sum.shown + match.liveShownSec, open: sum.open + match.liveOpenSec }), { market: 0, shown: 0, open: 0 });
    const picks = voids.reduce((sum, row) => sum + row.picks, 0);
    const voided = voids.reduce((sum, row) => sum + row.voided, 0);
    const byReason = [...new Set(pauses.map((pause) => pause.reason))].map((reason) => {
      const rows = pauses.filter((pause) => pause.reason === reason);
      return { reason, pauses: rows.length, averageMs: pauseMs(rows), fresh: rows.filter((row) => row.fresh).length };
    });
    const polling = this.sync.pollingHealth();
    const names = new Map((await this.prisma.event.findMany({ where: { id: { in: polling.matches.map((m) => m.eventId) } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
    return {
      days,
      overall: {
        openOfShown: share(totals.open, totals.shown),
        openOfAll: share(totals.open, totals.market),
        pauses: pauses.length,
        averagePauseMs: pauseMs(pauses),
        freshReopens: pauses.filter((pause) => pause.fresh).length,
        livePicks: picks,
        voidRate: share(voided, picks),
      },
      pausesByReason: byReason,
      competitions: [...competitions]
        .map(([competition, row]) => ({
          competition,
          matches: row.matches,
          openOfShown: share(row.open, row.shown),
          openOfAll: share(row.open, row.market),
          pauses: row.pauses.length,
          averagePauseMs: pauseMs(row.pauses),
          livePicks: row.picks,
          voidRate: share(row.voided, row.picks),
          liveOff: limits.slow.has(competition),
          noLiveCards: limits.noCards.has(competition),
          noLiveCorners: limits.noCorners.has(competition),
        }))
        .sort((a, b) => b.matches - a.matches || a.competition.localeCompare(b.competition)),
      matches: matches.slice(0, 100).map((match) => ({
        id: match.id,
        name: match.name,
        competition: competitionKey(match.provider, match.league),
        live: match.status === EventStatus.LIVE,
        startsAt: match.startsAt,
        openOfShown: share(match.liveOpenSec, match.liveShownSec),
        openOfAll: share(match.liveOpenSec, match.liveMarketSec),
        pauses: pauses.filter((pause) => pause.eventId === match.id).length,
        averagePauseMs: pauseMs(pauses.filter((pause) => pause.eventId === match.id)),
      })),
      liveLimits: { maxLagMs: LIVE_COMPETITION_MAX_LAG_MS, slow: [...limits.slow], noCards: [...limits.noCards], noCorners: [...limits.noCorners] },
      polling: { ...polling, matches: polling.matches.map((match) => ({ ...match, name: names.get(match.eventId) ?? match.eventId })) },
    };
  }

  /** One match's live limits: its competition too slow for live betting, and the cards or corners markets left off it while live. */
  private liveView(event: { provider: string; league: string; sport?: string }, limits: LiveLimits) {
    const key = competitionKey(event.provider, event.league);
    const cards = limits.noCards.has(key);
    const corners = limits.noCorners.has(key);
    return {
      slow: limits.slow.has(key),
      hidesAny: cards || corners,
      hides: (marketKey: string) => (cards && CARDS_MARKET.test(marketKey)) || (corners && CORNERS_MARKET.test(marketKey)),
    };
  }

  /**
   * Super Admin: how many seconds after a goal goes in the site first sees it,
   * over the last `days` days (feed-delay.ts). Only matches whose timeline has
   * come in after full time count.
   */
  async feedDelay(days = 7) {
    const rows = await this.prisma.goalSeen.findMany({
      where: { seenAt: { gte: new Date(Date.now() - days * 86_400_000) }, event: { lateCheck: { not: Prisma.DbNull } } },
      select: { homeScore: true, awayScore: true, source: true, seenAt: true, event: { select: { name: true, lateCheck: true } } },
      orderBy: { seenAt: "desc" },
      take: 2_000,
    });
    const seen = rows.flatMap((row) => {
      const timeline = timelineOf(row.event.lateCheck);
      return timeline ? [{ eventName: row.event.name, homeScore: row.homeScore, awayScore: row.awayScore, source: row.source, seenAt: row.seenAt, timeline }] : [];
    });
    return { days, ...feedDelay(seen), lag: await this.feedLagStats(days) };
  }

  /**
   * The feed's delay on goals over the last `days` days, overall, by provider
   * and by competition, from each goal's delay kept as it arrived (or at full
   * time): see lagStats.
   */
  async feedLagStats(days = 3, percentile = 0.95) {
    const rows = await this.prisma.goalSeen.findMany({
      where: { seenAt: { gte: new Date(Date.now() - days * 86_400_000) }, lagMinMs: { not: null } },
      select: { lagMinMs: true, event: { select: { provider: true, league: true } } },
      orderBy: { seenAt: "desc" },
      take: 5_000,
    });
    return { percentile, ...lagStats(rows.map((row) => ({ lagMinMs: row.lagMinMs!, provider: row.event.provider, league: row.event.league })), percentile) };
  }

  async leagues() {
    const saved = await this.sync.savedChoice();
    let available = null;
    let availableError: string | null = null;
    if (this.sync.mode === "off") availableError = "The odds feed isn't connected yet. Add API_FOOTBALL_KEY to the environment settings.";
    else available = await this.sync.availableLeagues().catch((error) => ((availableError = error instanceof Error ? error.message : "Sync failed"), null));
    const choice = saved ?? this.sync.defaults;
    return {
      custom: saved !== null,
      leagues: choice.leagues,
      countries: choice.countries,
      defaults: this.sync.defaults,
      available,
      availableError,
      requestsLeft: this.sync.requestsLeft,
    };
  }

  async setLeagues(actor: Actor, body: { reset?: boolean; leagues?: number[]; countries?: string[] }) {
    const before = (await this.sync.savedChoice()) ?? this.sync.defaults;
    let next: { leagues: number[]; countries: string[] } | null = null;
    if (!body.reset) {
      const leagues = [...new Set(body.leagues ?? [])].sort((a, b) => a - b);
      const countries = [...new Set((body.countries ?? []).map((c) => c.trim()).filter(Boolean))].sort();
      if (leagues.length === 0 && countries.length === 0) throw new BadRequestException("Choose at least one league or country");
      next = { leagues, countries };
    }
    await this.sync.saveChoice(next);
    const after = next ?? this.sync.defaults;
    const lower = (list: string[]) => list.map((c) => c.toLowerCase());
    await this.audit.log({
      actorId: actor.id,
      action: "odds.leagues_update",
      metadata: {
        reset: Boolean(body.reset),
        added: after.leagues.filter((id) => !before.leagues.includes(id)),
        removed: before.leagues.filter((id) => !after.leagues.includes(id)),
        countriesAdded: after.countries.filter((c) => !lower(before.countries).includes(c.toLowerCase())),
        countriesRemoved: before.countries.filter((c) => !lower(after.countries).includes(c.toLowerCase())),
      },
    });
    return this.leagues();
  }

  async syncNow(actor: Actor) {
    if (this.sync.mode === "off") throw new BadRequestException("The odds feed isn't connected yet. Add API_FOOTBALL_KEY to the environment settings.");
    try {
      const summary = await this.sync.syncNow();
      await this.audit.log({ actorId: actor.id, action: "odds.sync", metadata: summary });
      return summary;
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Sync failed");
    }
  }

  /**
   * The price a Player gets on a selection right now, and whether it can be
   * bet on. Bet placement must lock this price into Bet.odds.
   */
  async priceForPlayer(playerId: string, selectionId: string): Promise<PlayerPrice> {
    const price = (await this.pricesForPlayer(playerId, [selectionId])).get(selectionId);
    if (!price) throw new NotFoundException("Selection not found");
    return price;
  }

  /**
   * The same prices for several selections at once, as placing a slip needs:
   * the Player, their team's margin and the platform's are read once, and the
   * selections and the team's own prices for them in one query each, not
   * again for every pick. Selections that don't exist are left out.
   */
  async pricesForPlayer(playerId: string, selectionIds: string[]): Promise<Map<string, PlayerPrice>> {
    const player = await this.prisma.user.findUnique({ where: { id: playerId }, select: { id: true, role: true, parentId: true, parent: { select: { id: true, role: true, parentId: true } } } });
    if (!player || player.role !== Role.PLAYER) throw new NotFoundException("Player not found");
    const ownerId = ownerOf(player);
    const ids = [...new Set(selectionIds)];
    const [selections, platform, owner, overrides] = await Promise.all([
      this.prisma.selection.findMany({ where: { id: { in: ids } }, include: { market: { include: { event: true } } } }),
      this.platform(),
      ownerId ? this.prisma.user.findUnique({ where: { id: ownerId }, select: { oddsMargin: true } }) : null,
      ownerId ? this.prisma.oddsOverride.findMany({ where: { ownerId, selectionId: { in: ids } }, select: { selectionId: true, odds: true } }) : [],
    ]);
    const baseMargin = Number(platform.baseOddsMargin);
    const ownerMargin = num(owner?.oddsMargin) ?? 0;
    const overrideBy = new Map(overrides.map((row) => [row.selectionId, num(row.odds)]));
    const prices = new Map<string, PlayerPrice>();
    const limits = selections.some((selection) => selection.market.event.status === EventStatus.LIVE) ? await this.liveLimits() : null;
    for (const selection of selections) {
      const view = limits ? this.liveView(selection.market.event, limits) : null;
      // A competition too slow for live betting, or a cards or corners market it never prices live: not bettable in play.
      const event = view ? { ...selection.market.event, liveSlowCompetition: view.slow || view.hides(selection.market.key) } : selection.market.event;
      const quote = selectionQuote({
        event,
        market: selection.market,
        selection: { feedOdds: Number(selection.feedOdds), liveOdds: num(selection.liveOdds), result: selection.result, withdrawn: selection.withdrawn },
        baseMargin,
        ownerMargin,
        override: overrideBy.get(selection.id) ?? null,
      });
      prices.set(selection.id, {
        odds: quote.price,
        bettable: quote.bettable,
        live: quote.live,
        score: `${event.homeScore ?? "-"}:${event.awayScore ?? "-"}`,
        // Greyhounds: no price yet; the bet keeps the team's margin and is paid at the SP less it.
        sp: event.sport === "greyhounds",
        marketKey: selection.market.key,
        margin: teamMargin(baseMargin, ownerMargin),
      });
    }
    return prices;
  }

  private async platform() {
    return (
      (await this.prisma.platformSettings.findUnique({ where: { id: "default" } })) ?? {
        baseOddsMargin: new Prisma.Decimal(0),
        oddsSyncedAt: null,
        oddsSyncStatus: null,
      }
    );
  }

  /** Whose prices the viewer sees: their own team's, or for Super Admin the Owner they picked (none = base prices). */
  private async teamOwnerFor(actor: Actor, ownerIdParam?: string): Promise<string | null> {
    if (actor.role === Role.SUPER_ADMIN) {
      if (!ownerIdParam) return null;
      await this.assertOwner(ownerIdParam);
      return ownerIdParam;
    }
    if (actor.role === Role.OWNER) return actor.id;
    const parent = actor.parentId ? await this.prisma.user.findUnique({ where: { id: actor.parentId }, select: { id: true, role: true, parentId: true } }) : null;
    return ownerOf({ parent });
  }

  /** Only an Owner (for their team) or Super Admin (for a named Owner) changes prices. */
  private async editableOwner(actor: Actor, ownerIdParam?: string): Promise<string> {
    if (actor.role === Role.OWNER) {
      if (ownerIdParam && ownerIdParam !== actor.id) throw new ForbiddenException("You can only change your own team's odds");
      return actor.id;
    }
    if (actor.role === Role.SUPER_ADMIN && ownerIdParam) {
      await this.assertOwner(ownerIdParam);
      return ownerIdParam;
    }
    throw new ForbiddenException("Only Owners can change their team's odds");
  }

  private async assertOwner(id: string) {
    const owner = await this.prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!owner || owner.role !== Role.OWNER) throw new NotFoundException("Owner not found");
  }

  /** Prices can only be changed before a match finishes. */
  private async openSelection(selectionId: string) {
    const selection = await this.prisma.selection.findUnique({ where: { id: selectionId }, include: { market: { include: { event: { select: { name: true, status: true, sport: true } } } } } });
    if (!selection) throw new NotFoundException("Selection not found");
    const status = selection.market.event.status;
    if (status === EventStatus.COMPLETED || status === EventStatus.CANCELLED || selection.result !== null) {
      throw new BadRequestException("This match is over, so its odds can't change");
    }
    return selection;
  }
}

/** A race's number, grade, distance and country; each dog's status is on its own pick (withdrawn = suspended). */
function raceDetails(value: Prisma.JsonValue) {
  const info = (value ?? {}) as { raceNumber?: number; grade?: string | null; distance?: number | null; region?: string; runners?: unknown[] };
  return {
    raceNumber: info.raceNumber ?? null,
    grade: info.grade ?? null,
    distance: info.distance ?? null,
    region: info.region ?? null,
    field: Array.isArray(info.runners) ? info.runners.length : null,
  };
}

/** The Owner a user belongs to: their parent if it's an Owner, otherwise their Manager's parent. */
function ownerOf(user: { parent: { id: string; role: Role; parentId: string | null } | null }): string | null {
  if (!user.parent) return null;
  if (user.parent.role === Role.OWNER) return user.parent.id;
  if (user.parent.role === Role.MANAGER) return user.parent.parentId;
  return null;
}
