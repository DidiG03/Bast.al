import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { BetStatus, Role } from "@prisma/client";
import { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";
import { startOfWeek } from "../time";
import { HierarchyService } from "../users/hierarchy.service";

const RECENT_LIMIT = 50;

/** Settled-bet totals, as on the Commissions page: `net` = stakes - payouts. */
type Totals = { bets: number; staked: number; paidOut: number; net: number };

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * What a Player is doing with the credit they were given: bets still open,
 * recent results and their net result over a few periods. Visible to anyone
 * above the Player in the hierarchy.
 */
@Injectable()
export class PlayerActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hierarchy: HierarchyService,
  ) {}

  async activity(actor: Actor, playerId: string) {
    const player = await this.prisma.user.findUnique({
      where: { id: playerId },
      select: { id: true, username: true, role: true, status: true, balance: true, parent: { select: { username: true, role: true } } },
    });
    if (!player) throw new NotFoundException("User not found");
    if (!(await this.hierarchy.canActOn(actor, playerId)) || actor.id === playerId) {
      throw new ForbiddenException("This Player is outside your team");
    }
    if (player.role !== Role.PLAYER) throw new BadRequestException("Activity is only available for Players");

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
    const [thisWeek, last30Days, allTime, open, recent] = await Promise.all([
      this.totals(playerId, startOfWeek(now)),
      this.totals(playerId, thirtyDaysAgo),
      this.totals(playerId, null),
      this.prisma.bet.findMany({
        where: { playerId, status: BetStatus.OPEN },
        orderBy: { placedAt: "desc" },
        select: { id: true, description: true, odds: true, stake: true, placedAt: true },
      }),
      this.prisma.bet.findMany({
        where: { playerId, status: { not: BetStatus.OPEN } },
        orderBy: { settledAt: "desc" },
        take: RECENT_LIMIT,
        select: { id: true, description: true, odds: true, stake: true, payout: true, status: true, placedAt: true, settledAt: true },
      }),
    ]);

    return {
      player: {
        id: player.id,
        username: player.username,
        status: player.status,
        balance: Number(player.balance),
        parent: player.parent,
      },
      summary: { thisWeek, last30Days, allTime },
      open: {
        count: open.length,
        staked: round(open.reduce((sum, bet) => sum + Number(bet.stake), 0)),
        bets: open.map((bet) => ({ ...bet, stake: Number(bet.stake), odds: bet.odds === null ? null : Number(bet.odds) })),
      },
      recent: recent.map((bet) => ({
        ...bet,
        stake: Number(bet.stake),
        payout: Number(bet.payout),
        odds: bet.odds === null ? null : Number(bet.odds),
      })),
    };
  }

  /** From the settlement journal, like the Commissions page: a correction counts on the day it was made. */
  private async totals(playerId: string, since: Date | null): Promise<Totals> {
    const row = await this.prisma.settlementEntry.aggregate({
      where: { playerId, ...(since ? { createdAt: { gte: since } } : {}) },
      _sum: { bets: true, stake: true, payout: true },
    });
    const staked = round(Number(row._sum.stake ?? 0));
    const paidOut = round(Number(row._sum.payout ?? 0));
    return { bets: row._sum.bets ?? 0, staked, paidOut, net: round(staked - paidOut) };
  }
}
