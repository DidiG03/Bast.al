import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { EventStatus, Prisma, Role } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";
import { OddsSyncService } from "./odds-sync.service";
import { MAX_MARGIN, MAX_ODDS, MIN_ODDS, applyMargin, eventOpen, livePause, selectionQuote, teamMargin } from "./pricing";

const num = (value: Prisma.Decimal | number | null | undefined) => (value === null || value === undefined ? null : Number(value));

export type EventFilter = "upcoming" | "live" | "finished";

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
@Injectable()
export class OddsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sync: OddsSyncService,
  ) {}

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
      limits: { minOdds: MIN_ODDS, maxOdds: MAX_ODDS, maxMargin: MAX_MARGIN },
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
   * Events with every market priced for the viewer's team. Super Admin sees
   * feed prices less the base margin, or a chosen Owner's prices.
   */
  async events(actor: Actor, filter: EventFilter = "upcoming", ownerIdParam?: string) {
    const [platform, ownerId] = await Promise.all([this.platform(), this.teamOwnerFor(actor, ownerIdParam)]);
    const baseMargin = Number(platform.baseOddsMargin);
    const ownerMargin = ownerId ? num((await this.prisma.user.findUnique({ where: { id: ownerId }, select: { oddsMargin: true } }))?.oddsMargin) ?? 0 : 0;
    const isAdmin = actor.role === Role.SUPER_ADMIN;
    const now = new Date();

    const events = await this.prisma.event.findMany({
      where: {
        status: { in: FILTER_STATUSES[filter] },
        ...(isAdmin ? {} : { hidden: false }),
        // Finished matches only for the last three days.
        ...(filter === "finished" ? { startsAt: { gte: new Date(now.getTime() - 3 * 86_400_000) } } : {}),
      },
      orderBy: { startsAt: filter === "finished" ? "desc" : "asc" },
      take: 200,
      include: { markets: { orderBy: { sortOrder: "asc" }, include: { selections: { orderBy: { sortOrder: "asc" } } } } },
    });

    const selectionIds = events.flatMap((e) => e.markets.flatMap((m) => m.selections.map((s) => s.id)));
    const overrides = ownerId && selectionIds.length > 0
      ? await this.prisma.oddsOverride.findMany({ where: { ownerId, selectionId: { in: selectionIds } }, select: { selectionId: true, odds: true } })
      : [];
    const overrideBy = new Map(overrides.map((o) => [o.selectionId, Number(o.odds)]));
    const showFeed = actor.role !== Role.PLAYER;

    // Someone is watching live matches: the live prices are fetched more often for a while.
    if (events.some((event) => event.status === EventStatus.LIVE)) this.sync.noteLiveInterest();

    return events.map((event) => {
      const live = event.status === EventStatus.LIVE;
      return {
      id: event.id,
      name: event.name,
      league: event.league,
      country: event.country,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      startsAt: event.startsAt,
      status: event.status,
      elapsed: event.elapsed,
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
      markets: event.markets.map((market) => {
        const selections = market.selections.map((selection) => {
          const feedOdds = Number(selection.feedOdds);
          const liveOdds = num(selection.liveOdds);
          const override = live ? null : overrideBy.get(selection.id) ?? null;
          const quote = selectionQuote({ event, market, selection: { feedOdds, liveOdds, result: selection.result }, baseMargin, ownerMargin, override, now });
          return {
            id: selection.id,
            key: selection.key,
            name: selection.name,
            price: quote.price,
            feedOdds: showFeed ? (live ? liveOdds ?? feedOdds : feedOdds) : undefined,
            custom: override !== null,
            result: selection.result,
            /** Live only: the feed isn't pricing this outcome right now. */
            suspended: live && quote.suspended,
          };
        });
        return {
          id: market.id,
          key: market.key,
          name: market.name,
          /** Live only: the feed has this market off the board right now (single outcomes can be off on their own). */
          suspended: live && (market.liveSuspended || market.selections.every((s) => s.liveOdds === null)),
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
    await this.audit.log({ actorId: actor.id, action: "odds.event_update", metadata: { eventId, event: event.name, ...input } });
    return updated;
  }

  /**
   * The league picker: what's synced now, the defaults, and every competition
   * the feed has a season in progress for.
   */
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
  async priceForPlayer(playerId: string, selectionId: string): Promise<{ odds: number; bettable: boolean; live: boolean; score: string }> {
    const player = await this.prisma.user.findUnique({ where: { id: playerId }, select: { id: true, role: true, parentId: true, parent: { select: { id: true, role: true, parentId: true } } } });
    if (!player || player.role !== Role.PLAYER) throw new NotFoundException("Player not found");
    const ownerId = ownerOf(player);
    const selection = await this.prisma.selection.findUnique({ where: { id: selectionId }, include: { market: { include: { event: true } } } });
    if (!selection) throw new NotFoundException("Selection not found");
    const event = selection.market.event;
    const [platform, owner, override] = await Promise.all([
      this.platform(),
      ownerId ? this.prisma.user.findUnique({ where: { id: ownerId }, select: { oddsMargin: true } }) : null,
      ownerId ? this.prisma.oddsOverride.findUnique({ where: { ownerId_selectionId: { ownerId, selectionId } } }) : null,
    ]);
    const quote = selectionQuote({
      event,
      market: selection.market,
      selection: { feedOdds: Number(selection.feedOdds), liveOdds: num(selection.liveOdds), result: selection.result },
      baseMargin: Number(platform.baseOddsMargin),
      ownerMargin: num(owner?.oddsMargin) ?? 0,
      override: num(override?.odds),
    });
    return { odds: quote.price, bettable: quote.bettable, live: quote.live, score: `${event.homeScore ?? "-"}:${event.awayScore ?? "-"}` };
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
    const selection = await this.prisma.selection.findUnique({ where: { id: selectionId }, include: { market: { include: { event: { select: { name: true, status: true } } } } } });
    if (!selection) throw new NotFoundException("Selection not found");
    const status = selection.market.event.status;
    if (status === EventStatus.COMPLETED || status === EventStatus.CANCELLED || selection.result !== null) {
      throw new BadRequestException("This match is over, so its odds can't change");
    }
    return selection;
  }
}

/** The Owner a user belongs to: their parent if it's an Owner, otherwise their Manager's parent. */
function ownerOf(user: { parent: { id: string; role: Role; parentId: string | null } | null }): string | null {
  if (!user.parent) return null;
  if (user.parent.role === Role.OWNER) return user.parent.id;
  if (user.parent.role === Role.MANAGER) return user.parent.parentId;
  return null;
}
