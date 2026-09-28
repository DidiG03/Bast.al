import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { BetStatus, Prisma, Role, UserStatus } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { Actor } from "../auth/permissions";
import { BettingLimitsService } from "../commissions/betting-limits.service";
import { OddsService } from "../odds/odds.service";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { UsersService } from "../users/users.service";
import { payoutFor } from "./grading";

type SlipBet = { selectionId: string; stake: number; odds: number };

const PAGE = 50;

/** What a bet looks like to the Player who placed it and to Super Admin. */
export const betSelect = {
  id: true,
  stake: true,
  odds: true,
  payout: true,
  status: true,
  description: true,
  placedAt: true,
  settledAt: true,
  voidReason: true,
  selection: {
    select: {
      name: true,
      result: true,
      market: {
        select: {
          name: true,
          event: { select: { id: true, name: true, league: true, startsAt: true, status: true, homeScore: true, awayScore: true, resultHome: true, resultAway: true } },
        },
      },
    },
  },
} satisfies Prisma.BetSelect;

type BetRow = Prisma.BetGetPayload<{ select: typeof betSelect }>;

export function betView(bet: BetRow) {
  const stake = Number(bet.stake);
  const odds = bet.odds === null ? null : Number(bet.odds);
  const event = bet.selection?.market.event ?? null;
  return {
    id: bet.id,
    description: bet.description,
    stake,
    odds,
    /** What a win pays back, stake included. */
    potentialPayout: odds === null ? null : Number(payoutFor(BetStatus.WON, bet.stake, bet.odds!)),
    payout: Number(bet.payout),
    status: bet.status,
    placedAt: bet.placedAt,
    settledAt: bet.settledAt,
    voidReason: bet.voidReason,
    selection: bet.selection ? { name: bet.selection.name, market: bet.selection.market.name } : null,
    event: event
      ? {
          id: event.id,
          name: event.name,
          league: event.league,
          startsAt: event.startsAt,
          status: event.status,
          homeScore: event.homeScore,
          awayScore: event.awayScore,
          result: event.resultHome === null || event.resultAway === null ? null : { home: event.resultHome, away: event.resultAway },
        }
      : null,
  };
}

/**
 * Players placing and viewing their own bets. Prices come from their
 * Owner's odds (OddsService.priceForPlayer) and are locked into the bet;
 * the stake leaves the Player's balance when the bet is placed, and
 * SettlementService pays winnings and refunds back into it.
 */
@Injectable()
export class BetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly odds: OddsService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  async place(actor: Actor, input: { bets: SlipBet[]; acceptOddsChanges?: boolean }, ipAddress?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players can place bets");
    await this.assertOnTeam(actor);

    const ids = [...new Set(input.bets.map((bet) => bet.selectionId))];
    const selections = await this.prisma.selection.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, market: { select: { name: true, event: { select: { id: true, name: true } } } } },
    });
    const byId = new Map(selections.map((s) => [s.id, s]));

    const priced: Array<SlipBet & { price: number; eventId: string; description: string }> = [];
    const changed: string[] = [];
    for (const bet of input.bets) {
      const selection = byId.get(bet.selectionId);
      if (!selection) throw new BadRequestException("One of the bets on your slip no longer exists. Remove it and try again.");
      const description = `${selection.market.event.name} · ${selection.market.name}: ${selection.name}`.slice(0, 200);
      const { odds, bettable } = await this.odds.priceForPlayer(actor.id, bet.selectionId);
      if (!bettable) throw new BadRequestException(`Bets are closed on ${selection.market.event.name}. Remove it from your slip.`);
      if (Math.abs(odds - bet.odds) > 0.001) changed.push(`${selection.name} is now ${odds.toFixed(2)}`);
      priced.push({ ...bet, price: odds, eventId: selection.market.event.id, description });
    }
    if (changed.length > 0 && !input.acceptOddsChanges) {
      throw new ConflictException(`The odds changed: ${changed.join(", ")}. Check your slip and place it again.`);
    }

    const total = priced.reduce((sum, bet) => sum.add(new Prisma.Decimal(bet.stake.toFixed(2))), new Prisma.Decimal(0));
    const created = await this.prisma.$transaction(async (tx) => {
      // One slip at a time per Player, so two slips can't both squeeze under
      // the daily loss limit or spend the same balance.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      let alsoStaking = 0;
      for (const bet of priced) {
        await this.limits.assertCanPlace(actor.id, bet.stake, alsoStaking);
        alsoStaking += bet.stake;
      }
      const taken = await tx.user.updateMany({ where: { id: actor.id, balance: { gte: total } }, data: { balance: { decrement: total } } });
      if (taken.count === 0) throw new BadRequestException("Your balance is too low for this slip. Ask your Manager for a top-up.");
      const rows = [];
      for (const bet of priced) {
        const stake = new Prisma.Decimal(bet.stake.toFixed(2));
        rows.push(
          await tx.bet.create({
            data: { playerId: actor.id, selectionId: bet.selectionId, stake, odds: new Prisma.Decimal(bet.price.toFixed(2)), description: bet.description },
            select: betSelect,
          }),
        );
        await tx.event.update({ where: { id: bet.eventId }, data: { volume: { increment: stake } } });
      }
      return rows;
    });

    await this.audit.log({
      actorId: actor.id,
      action: "bet.place",
      targetId: actor.id,
      ipAddress,
      metadata: { bets: created.map((bet) => ({ id: bet.id, stake: Number(bet.stake), odds: Number(bet.odds) })), total: Number(total) },
    });
    await this.realtime.publishBalances([actor.id]);
    await this.realtime.publish(actor.id, { type: "bets.changed" });
    await this.users.alertLowBalance(actor.id, Number(total));
    return { bets: created.map(betView), total: Number(total) };
  }

  /** The Player's own bets: open ones, or settled ones newest first. */
  async mine(actor: Actor, status: "open" | "settled" = "open", before?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players have bets");
    const where: Prisma.BetWhereInput = { playerId: actor.id, status: status === "open" ? BetStatus.OPEN : { not: BetStatus.OPEN } };
    const beforeDate = before ? new Date(before) : null;
    if (beforeDate && !Number.isNaN(beforeDate.getTime())) where[status === "open" ? "placedAt" : "settledAt"] = { lt: beforeDate };
    const [bets, open, player] = await Promise.all([
      this.prisma.bet.findMany({ where, orderBy: status === "open" ? { placedAt: "desc" } : { settledAt: "desc" }, take: PAGE, select: betSelect }),
      this.prisma.bet.aggregate({ where: { playerId: actor.id, status: BetStatus.OPEN }, _sum: { stake: true }, _count: { _all: true } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
    ]);
    return {
      balance: Number(player.balance),
      open: { count: open._count._all, staked: Number(open._sum.stake ?? 0) },
      bets: bets.map(betView),
      hasMore: bets.length === PAGE,
    };
  }

  /** What a Player may stake: their limits, and whether their account can bet at all. */
  async slipInfo(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players have a bet slip");
    const row = await this.prisma.bettingLimit.findUnique({ where: { playerId: actor.id } });
    const lower = (a: Prisma.Decimal | null | undefined, b: Prisma.Decimal | null | undefined) => {
      const values = [a, b].filter((v): v is Prisma.Decimal => v !== null && v !== undefined).map(Number);
      return values.length ? Math.min(...values) : null;
    };
    let blocked: string | null = null;
    try {
      await this.assertOnTeam(actor);
    } catch (error) {
      blocked = error instanceof Error ? error.message : "Your account can't bet right now";
    }
    const balance = Number((await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } })).balance);
    return { balance, maxStake: lower(row?.ownerMaxStake, row?.managerMaxStake), dailyLossLimit: lower(row?.ownerDailyLossLimit, row?.managerDailyLossLimit), blocked };
  }

  /**
   * A Player can bet only while they sit in a team: under an active Manager
   * who belongs to an Owner, or directly under an Owner. Player accounts are
   * only ever made by their Manager or Owner, so this also shuts out any
   * account that got in some other way.
   */
  private async assertOnTeam(actor: Actor) {
    const parent = actor.parentId
      ? await this.prisma.user.findUnique({ where: { id: actor.parentId }, select: { role: true, status: true, parent: { select: { role: true } } } })
      : null;
    const onTeam = parent && (parent.role === Role.OWNER || (parent.role === Role.MANAGER && parent.parent?.role === Role.OWNER));
    if (!onTeam) throw new ForbiddenException("Your account isn't on a team yet, so it can't place bets. Your Manager or Owner has to set it up.");
    if (parent.status !== UserStatus.ACTIVE) throw new ForbiddenException("Your Manager's account is suspended, so betting is paused.");
  }
}
