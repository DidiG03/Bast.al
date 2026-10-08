import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { BetStatus, EventStatus, Prisma, Role } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";

type Db = Prisma.TransactionClient | PrismaService;

type SelectionExposure = { singles: { bets: number; staked: number; payout: number }; accumulators: { bets: number; staked: number; payout: number } };

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * What an Owner's team stands to pay out on each outcome of each match:
 * every open single on that outcome, plus every open accumulator that still
 * needs it (counted in full, as if the accumulator's other legs win too).
 * The Owner can cap that amount; bets that would take any outcome over the
 * cap are refused at placement.
 */
@Injectable()
export class RiskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Open payout per selection for one team, for the given selections (or all). */
  async exposure(db: Db, ownerId: string, selectionIds?: string[]): Promise<Map<string, SelectionExposure>> {
    const only = selectionIds ? Prisma.sql`AND sel_id = ANY(${selectionIds})` : Prisma.empty;
    const rows = await db.$queryRaw<Array<{ sel_id: string; kind: "SINGLE" | "ACCUMULATOR"; bets: bigint; staked: Prisma.Decimal; payout: Prisma.Decimal }>>`
      WITH team_bets AS (
        SELECT b.id, b.kind, b.stake, FLOOR(b.stake * COALESCE(b.odds, b.sp_cap) * 100) / 100 AS payout, b.selection_id
        FROM bets b
        -- The team that took the bet (recorded when it was placed), even if the Player has moved since.
        -- A race bet paid at the starting price counts at its cap until it settles.
        WHERE b.status = 'OPEN' AND COALESCE(b.odds, b.sp_cap) IS NOT NULL AND b.owner_id = ${ownerId}
      ), picks AS (
        SELECT selection_id AS sel_id, kind, stake, payout FROM team_bets WHERE kind = 'SINGLE' AND selection_id IS NOT NULL
        UNION ALL
        -- A bet builder's picks count with the accumulators' (both pay only if every pick wins).
        SELECT l.selection_id AS sel_id, 'ACCUMULATOR'::"BetKind" AS kind, t.stake, t.payout FROM team_bets t JOIN bet_legs l ON l.bet_id = t.id
        WHERE t.kind IN ('ACCUMULATOR', 'BUILDER') AND l.result IS NULL
      )
      SELECT sel_id, kind, COUNT(*) AS bets, SUM(stake) AS staked, SUM(payout) AS payout
      FROM picks WHERE TRUE ${only}
      GROUP BY sel_id, kind
    `;
    const map = new Map<string, SelectionExposure>();
    for (const row of rows) {
      const entry = map.get(row.sel_id) ?? { singles: { bets: 0, staked: 0, payout: 0 }, accumulators: { bets: 0, staked: 0, payout: 0 } };
      entry[row.kind === "SINGLE" ? "singles" : "accumulators"] = { bets: Number(row.bets), staked: Number(row.staked), payout: Number(row.payout) };
      map.set(row.sel_id, entry);
    }
    return map;
  }

  /**
   * Refuses new bets that would take any outcome's open payout over the
   * team's cap. `adding` is the potential payout each selection would gain.
   * Run inside the placement transaction, after lockTeam.
   */
  async assertUnderCap(db: Db, ownerId: string, adding: Map<string, { payout: number; label: string }>) {
    const owner = await db.user.findUnique({ where: { id: ownerId }, select: { maxOutcomePayout: true } });
    if (!owner?.maxOutcomePayout) return;
    const cap = Number(owner.maxOutcomePayout);
    const current = await this.exposure(db, ownerId, [...adding.keys()]);
    for (const [selectionId, add] of adding) {
      const now = current.get(selectionId);
      const total = (now?.singles.payout ?? 0) + (now?.accumulators.payout ?? 0) + add.payout;
      if (total > cap) {
        const room = Math.max(0, cap - (total - add.payout));
        throw new BadRequestException(
          room < 1 ? `Your team isn't taking more bets on ${add.label} right now. Try another pick.` : `That bet is too big for ${add.label} right now. The most it can pay out is $${room.toFixed(2)}, so lower the stake.`,
        );
      }
    }
  }

  /** Serializes bet placement per team, so two Players can't both slip under the cap. */
  async lockTeam(tx: Prisma.TransactionClient, ownerId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`team-risk:${ownerId}`}))`;
  }

  /** The risk view: open matches where the team has money at stake, worst first. */
  async view(actor: Actor, ownerIdParam?: string) {
    const ownerId = await this.ownerFor(actor, ownerIdParam);
    const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { id: true, username: true, maxOutcomePayout: true } });
    const exposure = await this.exposure(this.prisma, ownerId);
    const selections = await this.prisma.selection.findMany({
      where: { id: { in: [...exposure.keys()] } },
      select: { market: { select: { eventId: true } } },
    });
    const eventIds = [...new Set(selections.map((s) => s.market.eventId))];
    const events = await this.prisma.event.findMany({
      where: { id: { in: eventIds } },
      include: { markets: { orderBy: { sortOrder: "asc" }, include: { selections: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, result: true } } } } },
    });
    const cap = owner.maxOutcomePayout === null ? null : Number(owner.maxOutcomePayout);

    const view = events.map((event) => {
      let worst = { selection: "", market: "", payout: 0 };
      let staked = 0;
      const betIds = { singles: 0, accumulators: 0 };
      const markets = event.markets
        .map((market) => {
          const marketSinglesStaked = market.selections.reduce((sum, s) => sum + (exposure.get(s.id)?.singles.staked ?? 0), 0);
          const rows = market.selections.map((selection) => {
            const e = exposure.get(selection.id) ?? { singles: { bets: 0, staked: 0, payout: 0 }, accumulators: { bets: 0, staked: 0, payout: 0 } };
            const payout = round(e.singles.payout + e.accumulators.payout);
            if (payout > worst.payout) worst = { selection: selection.name, market: market.name, payout };
            betIds.singles += e.singles.bets;
            betIds.accumulators += e.accumulators.bets;
            staked += e.singles.staked;
            return {
              id: selection.id,
              name: selection.name,
              singles: e.singles,
              accumulators: e.accumulators,
              /** Everything the team pays out if this outcome wins. */
              payout,
              /** Singles only: stakes on this market kept, minus what this outcome's singles pay. */
              singlesResult: round(marketSinglesStaked - e.singles.payout),
              overCap: cap !== null && payout > cap,
              share: cap ? Math.min(1, payout / cap) : null,
            };
          });
          return { id: market.id, name: market.name, selections: rows };
        })
        .filter((market) => market.selections.some((s) => s.payout > 0));
      return {
        id: event.id,
        name: event.name,
        league: event.league,
        startsAt: event.startsAt,
        status: event.status,
        homeScore: event.homeScore,
        awayScore: event.awayScore,
        bets: betIds,
        singlesStaked: round(staked),
        worst,
        markets,
      };
    });
    const live = view.filter((e) => e.status !== EventStatus.CANCELLED).sort((a, b) => b.worst.payout - a.worst.payout);

    const totals = await this.prisma.bet.aggregate({
      where: { status: BetStatus.OPEN, ownerId },
      _sum: { stake: true },
      _count: { _all: true },
    });
    return {
      owner: { id: owner.id, username: owner.username },
      cap,
      canEdit: actor.role === Role.OWNER || actor.role === Role.SUPER_ADMIN,
      totals: { openBets: totals._count._all, staked: Number(totals._sum.stake ?? 0), worstCase: live[0]?.worst.payout ?? 0 },
      events: live,
    };
  }

  async setCap(actor: Actor, cap: number | null, ownerIdParam?: string) {
    const ownerId = await this.ownerFor(actor, ownerIdParam);
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { maxOutcomePayout: true } });
    await this.prisma.user.update({ where: { id: ownerId }, data: { maxOutcomePayout: cap } });
    await this.audit.log({
      actorId: actor.id,
      action: "risk.cap_update",
      targetId: ownerId,
      metadata: { from: before.maxOutcomePayout === null ? null : Number(before.maxOutcomePayout), to: cap },
    });
    return this.view(actor, ownerIdParam);
  }

  private async ownerFor(actor: Actor, ownerIdParam?: string): Promise<string> {
    if (actor.role === Role.OWNER) {
      if (ownerIdParam && ownerIdParam !== actor.id) throw new ForbiddenException("You can only see your own team's risk");
      return actor.id;
    }
    if (actor.role === Role.SUPER_ADMIN) {
      if (!ownerIdParam) throw new BadRequestException("Pick an Owner");
      const owner = await this.prisma.user.findUnique({ where: { id: ownerIdParam }, select: { role: true } });
      if (!owner || owner.role !== Role.OWNER) throw new NotFoundException("Owner not found");
      return ownerIdParam;
    }
    throw new ForbiddenException("Only Owners and Super Admin can see team risk");
  }
}
