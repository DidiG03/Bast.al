import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { BalanceTransactionStatus, Prisma, Role } from "@prisma/client";
import { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";
import { UsersService } from "../users/users.service";
import { CommissionsService } from "./commissions.service";

const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Paying commissions for a finished period, remembered so no period is ever
 * paid twice:
 * - Super Admin collects their cut from an Owner (a reclaim).
 * - An Owner pays one of their Managers (a delegation, which may need
 *   approval like any other).
 * The amount is worked out here from settled bets, never taken from the
 * browser. The payout is recorded in the same database transaction as the
 * money moving, under a per-account lock, and a period that overlaps one
 * already paid is refused (unless that payment was rejected).
 */
@Injectable()
export class CommissionPayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commissions: CommissionsService,
    private readonly users: UsersService,
  ) {}

  /** Payouts overlapping [from, to) that this viewer can see, with where each one stands. */
  async list(actor: Actor, from: string, to: string) {
    const period = this.period(from, to);
    const visible = await this.visibleUserIds(actor);
    const rows = await this.prisma.commissionPayout.findMany({
      where: { periodFrom: { lt: period.to }, periodTo: { gt: period.from }, ...(visible ? { userId: { in: visible } } : {}) },
      orderBy: { createdAt: "desc" },
      select: { id: true, userId: true, periodFrom: true, periodTo: true, amount: true, createdAt: true, transaction: { select: { status: true } } },
    });
    return rows.map(({ transaction, amount, ...row }) => ({ ...row, amount: Number(amount), status: transaction.status }));
  }

  /** Pays one account's commission for [from, to). */
  async pay(actor: Actor, userId: string, from: string, to: string, label?: string, ipAddress?: string) {
    const period = this.period(from, to);
    // A minute of slack for clock differences. Running periods ("this week") are
    // kept out by the page; even if one got through, the overlap check below
    // still stops any day being paid twice.
    if (period.to.getTime() > Date.now() + 60_000) throw new BadRequestException("This period hasn't ended yet. Pay commission once it's over.");
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, parentId: true, username: true } });
    if (!target) throw new NotFoundException("User not found");

    let amount: number;
    if (actor.role === Role.SUPER_ADMIN && target.role === Role.OWNER) {
      const team = await this.commissions.team(actor, target.id, period.from.toISOString(), period.to.toISOString());
      amount = team.totals.superAdminCut;
    } else if (actor.role === Role.OWNER && target.role === Role.MANAGER && target.parentId === actor.id) {
      const team = await this.commissions.team(actor, undefined, period.from.toISOString(), period.to.toISOString());
      amount = team.managers.find((manager) => manager.id === target.id)?.commission ?? 0;
    } else {
      throw new ForbiddenException("Super Admin collects from Owners, and Owners pay their own Managers");
    }
    amount = Math.round(amount * 100) / 100;
    if (amount <= 0) throw new BadRequestException(`There's no commission to ${actor.role === Role.SUPER_ADMIN ? "collect" : "pay"} for this period`);

    const reason = `Commission for ${label?.trim() || `${dayFormat.format(period.from)} to ${dayFormat.format(new Date(period.to.getTime() - 1))}`}`.slice(0, 200);
    const hooks = {
      before: async (tx: Prisma.TransactionClient) => {
        // One payout per account at a time, so two clicks can't both pass the check below.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`commission-payout:${target.id}`}))`;
        const overlap = await tx.commissionPayout.findFirst({
          where: {
            userId: target.id,
            periodFrom: { lt: period.to },
            periodTo: { gt: period.from },
            transaction: { status: { not: BalanceTransactionStatus.REJECTED } },
          },
          select: { periodFrom: true, periodTo: true, createdAt: true },
        });
        if (overlap) {
          throw new ConflictException(
            `Commission for ${target.username} was already ${actor.role === Role.SUPER_ADMIN ? "collected" : "paid"} for ${dayFormat.format(overlap.periodFrom)} to ${dayFormat.format(new Date(overlap.periodTo.getTime() - 1))}, on ${dayFormat.format(overlap.createdAt)}. Pick a period that doesn't overlap it.`,
          );
        }
      },
      after: async (tx: Prisma.TransactionClient, transactionId: string) => {
        await tx.commissionPayout.create({ data: { userId: target.id, periodFrom: period.from, periodTo: period.to, amount, transactionId } });
      },
    };

    if (actor.role === Role.SUPER_ADMIN) await this.users.reclaimCredit(actor, target.id, { amount, reason }, ipAddress, hooks);
    else await this.users.delegateCredit(actor, target.id, { amount, reason }, ipAddress, hooks);

    const payout = await this.prisma.commissionPayout.findFirstOrThrow({
      where: { userId: target.id, periodFrom: period.from, periodTo: period.to },
      orderBy: { createdAt: "desc" },
      select: { id: true, userId: true, periodFrom: true, periodTo: true, amount: true, createdAt: true, transaction: { select: { status: true } } },
    });
    const { transaction, amount: paid, ...row } = payout;
    return { ...row, amount: Number(paid), status: transaction.status };
  }

  /** Whose payouts a viewer sees: everyone for Super Admin, an Owner's own and their Managers', a Manager's own. */
  private async visibleUserIds(actor: Actor): Promise<string[] | null> {
    if (actor.role === Role.SUPER_ADMIN) return null;
    if (actor.role === Role.OWNER) {
      const managers = await this.prisma.user.findMany({ where: { parentId: actor.id, role: Role.MANAGER }, select: { id: true } });
      return [actor.id, ...managers.map((manager) => manager.id)];
    }
    if (actor.role === Role.MANAGER) return [actor.id];
    throw new ForbiddenException("Players don't have commissions");
  }

  private period(fromInput: string, toInput: string) {
    const from = new Date(fromInput);
    const to = new Date(toInput);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException("Invalid date");
    if (from >= to) throw new BadRequestException("The start date must be before the end date");
    return { from, to };
  }
}
