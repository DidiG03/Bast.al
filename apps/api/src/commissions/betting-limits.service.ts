import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { BetStatus, Prisma, Role } from "@prisma/client";
import { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";
import { HierarchyService } from "../users/hierarchy.service";

type Limits = { maxStake: number | null; dailyLossLimit: number | null };

function value(decimal: Prisma.Decimal | null | undefined): number | null {
  return decimal === null || decimal === undefined ? null : Number(decimal);
}

/** The stricter of two optional limits (null = no limit). */
function stricter(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Per-Player betting limits. The Owner above the Player (or Super Admin)
 * sets the ceiling; the Player's own Manager can tighten it but never go
 * above it. `assertCanPlace` is what bet placement must call before it
 * creates a Bet row.
 */
@Injectable()
export class BettingLimitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hierarchy: HierarchyService,
  ) {}

  async get(actor: Actor, playerId: string) {
    const player = await this.player(actor, playerId);
    const row = await this.prisma.bettingLimit.findUnique({ where: { playerId } });
    const owner: Limits = { maxStake: value(row?.ownerMaxStake), dailyLossLimit: value(row?.ownerDailyLossLimit) };
    const manager: Limits = { maxStake: value(row?.managerMaxStake), dailyLossLimit: value(row?.managerDailyLossLimit) };
    return {
      owner,
      manager,
      effective: { maxStake: stricter(owner.maxStake, manager.maxStake), dailyLossLimit: stricter(owner.dailyLossLimit, manager.dailyLossLimit) },
      lossToday: await this.lossToday(playerId),
      /** Which layer this viewer may change, if any. */
      editable: this.editableLayer(actor, player),
      hasManager: player.parent?.role === Role.MANAGER,
    };
  }

  async set(actor: Actor, playerId: string, input: Partial<Limits>) {
    const player = await this.player(actor, playerId);
    const layer = this.editableLayer(actor, player);
    if (!layer) throw new ForbiddenException("You can't change this Player's betting limits");

    const row = await this.prisma.bettingLimit.findUnique({ where: { playerId } });
    const data: Prisma.BettingLimitUpdateInput = {};
    if (layer === "owner") {
      if (input.maxStake !== undefined) data.ownerMaxStake = input.maxStake;
      if (input.dailyLossLimit !== undefined) data.ownerDailyLossLimit = input.dailyLossLimit;
    } else {
      // A Manager can only tighten what the Owner allows. Clearing their own
      // value is fine: the Owner's limit still applies.
      const ceiling: Limits = { maxStake: value(row?.ownerMaxStake), dailyLossLimit: value(row?.ownerDailyLossLimit) };
      for (const key of ["maxStake", "dailyLossLimit"] as const) {
        const next = input[key];
        if (next === undefined) continue;
        const cap = ceiling[key];
        if (cap !== null && next !== null && next > cap) {
          throw new BadRequestException(`Your Owner allows at most $${cap.toFixed(2)} for ${key === "maxStake" ? "one bet" : "daily losses"}. You can lower it but not raise it.`);
        }
      }
      if (input.maxStake !== undefined) data.managerMaxStake = input.maxStake;
      if (input.dailyLossLimit !== undefined) data.managerDailyLossLimit = input.dailyLossLimit;
    }
    await this.prisma.bettingLimit.upsert({
      where: { playerId },
      create: { ...(data as Omit<Prisma.BettingLimitUncheckedCreateInput, "playerId">), playerId },
      update: data,
    });
    return this.get(actor, playerId);
  }

  /**
   * Throws if this stake would break the Player's limits: more than the
   * max stake, or today's losses plus stakes still open plus this stake over
   * the daily loss limit. Call it before creating a Bet. `alsoStaking` is
   * what the same bet slip stakes on bets that aren't saved yet.
   */
  async assertCanPlace(playerId: string, stake: number, alsoStaking = 0) {
    const row = await this.prisma.bettingLimit.findUnique({ where: { playerId } });
    const maxStake = stricter(value(row?.ownerMaxStake), value(row?.managerMaxStake));
    const dailyLossLimit = stricter(value(row?.ownerDailyLossLimit), value(row?.managerDailyLossLimit));
    if (maxStake !== null && stake > maxStake) {
      throw new BadRequestException(`The most this Player can stake on one bet is $${maxStake.toFixed(2)}`);
    }
    if (dailyLossLimit !== null) {
      const today = startOfUtcDay(new Date());
      const open = await this.prisma.bet.aggregate({ where: { playerId, status: BetStatus.OPEN, placedAt: { gte: today } }, _sum: { stake: true } });
      const worstCase = (await this.lossToday(playerId)) + Number(open._sum.stake ?? 0) + alsoStaking + stake;
      if (worstCase > dailyLossLimit) {
        throw new BadRequestException(`This bet could take the Player past their $${dailyLossLimit.toFixed(2)} daily loss limit`);
      }
    }
  }

  /** Net amount the Player has lost on bets settled today (UTC); 0 if they're up. */
  private async lossToday(playerId: string): Promise<number> {
    const settled = await this.prisma.bet.aggregate({
      where: { playerId, status: { in: [BetStatus.WON, BetStatus.LOST] }, settledAt: { gte: startOfUtcDay(new Date()) } },
      _sum: { stake: true, payout: true },
    });
    const net = Number(settled._sum.stake ?? 0) - Number(settled._sum.payout ?? 0);
    return Math.max(0, Math.round(net * 100) / 100);
  }

  private editableLayer(actor: Actor, player: { parentId: string | null; ownerId: string | null }): "owner" | "manager" | null {
    if (actor.role === Role.SUPER_ADMIN) return "owner";
    if (actor.role === Role.OWNER && player.ownerId === actor.id) return "owner";
    if (actor.role === Role.MANAGER && player.parentId === actor.id) return "manager";
    return null;
  }

  private async player(actor: Actor, playerId: string) {
    const player = await this.prisma.user.findUnique({
      where: { id: playerId },
      select: { id: true, role: true, parentId: true, parent: { select: { id: true, role: true, parentId: true } } },
    });
    if (!player) throw new NotFoundException("User not found");
    if (actor.id === playerId || !(await this.hierarchy.canActOn(actor, playerId))) {
      throw new ForbiddenException("This Player is outside your team");
    }
    if (player.role !== Role.PLAYER) throw new BadRequestException("Betting limits are only for Players");
    const ownerId = player.parent?.role === Role.OWNER ? player.parent.id : player.parent?.parentId ?? null;
    return { ...player, ownerId };
  }
}
