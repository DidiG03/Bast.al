import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { BetStatus, Role, UserStatus } from "@prisma/client";
import { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";
import { HierarchyService } from "../users/hierarchy.service";

type Account = {
  id: string;
  username: string;
  role: Role;
  parentId: string | null;
  status: UserStatus;
  commissionRate: number;
};

/** Settled-bet totals. `net` is what the house made: stakes minus payouts. */
type Totals = { bets: number; staked: number; paidOut: number; net: number };

export type PlayerResult = Totals & { id: string; username: string; status: UserStatus };

const MAX_PERIOD_DAYS = 366;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function cut(net: number, rate: number): number {
  return round((net * rate) / 100);
}

function emptyTotals(): Totals {
  return { bets: 0, staked: 0, paidOut: 0, net: 0 };
}

function add(into: Totals, from: Totals): Totals {
  into.bets += from.bets;
  into.staked = round(into.staked + from.staked);
  into.paidOut = round(into.paidOut + from.paidOut);
  into.net = round(into.net + from.net);
  return into;
}

/** Monday 00:00 UTC of the current week — commissions settle weekly. */
function startOfWeek(now: Date): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return start;
}

/**
 * Commission views over settled bets.
 *
 * The money flows up the chain: a Player's losses are the team's net
 * revenue. A Manager earns their rate on their own Players' net revenue,
 * paid by their Owner. Super Admin takes the Owner's rate on the Owner's
 * whole team net revenue (before Manager commissions come out). The Owner
 * keeps what is left. Net revenue can be negative when Players win overall,
 * and the commissions then go negative the same way.
 *
 * Rates are read as they are now, so changing a rate re-prices past periods
 * in these views.
 */
@Injectable()
export class CommissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hierarchy: HierarchyService,
  ) {}

  /** Super Admin: every Owner, with the Super Admin cut from each. */
  async owners(actor: Actor, fromInput?: string, toInput?: string) {
    if (actor.role !== Role.SUPER_ADMIN) throw new ForbiddenException("Only Super Admins can see every Owner's commission");
    const period = this.period(fromInput, toInput);
    const accounts = await this.accounts(null);
    const results = await this.playerResults(accounts, period);
    const children = this.childrenOf(accounts);

    const owners = accounts
      .filter((account) => account.role === Role.OWNER)
      .map((owner) => {
        const team = this.teamOf(owner, children, results);
        return {
          id: owner.id,
          username: owner.username,
          status: owner.status,
          commissionRate: owner.commissionRate,
          managers: team.managers.length,
          players: team.managers.reduce((sum, manager) => sum + manager.players.length, 0) + team.directPlayers.length,
          ...team.totals,
        };
      })
      .sort((a, b) => b.superAdminCut - a.superAdminCut || a.username.localeCompare(b.username));

    const totals = owners.reduce(
      (sum, owner) => ({
        ...add(sum, owner),
        superAdminCut: round(sum.superAdminCut + owner.superAdminCut),
        managerCommission: round(sum.managerCommission + owner.managerCommission),
        ownerKeeps: round(sum.ownerKeeps + owner.ownerKeeps),
      }),
      { ...emptyTotals(), superAdminCut: 0, managerCommission: 0, ownerKeeps: 0 },
    );

    return { ...period, totals, owners };
  }

  /**
   * One Owner's team: what they owe Super Admin, what they owe each Manager,
   * and what they keep. Owners get their own team; Super Admin passes ownerId.
   */
  async team(actor: Actor, ownerId: string | undefined, fromInput?: string, toInput?: string) {
    let id: string;
    if (actor.role === Role.OWNER) {
      if (ownerId && ownerId !== actor.id) throw new ForbiddenException("Owners can only see their own team");
      id = actor.id;
    } else if (actor.role === Role.SUPER_ADMIN) {
      if (!ownerId) throw new BadRequestException("Choose an Owner");
      id = ownerId;
    } else {
      throw new ForbiddenException("Only Owners and Super Admins can see a team's commission");
    }

    const period = this.period(fromInput, toInput);
    const accounts = await this.accounts(id);
    const owner = accounts.find((account) => account.id === id);
    if (!owner || owner.role !== Role.OWNER) throw new NotFoundException("Owner not found");

    const results = await this.playerResults(accounts, period);
    const team = this.teamOf(owner, this.childrenOf(accounts), results);
    return {
      ...period,
      owner: { id: owner.id, username: owner.username, commissionRate: owner.commissionRate },
      ...team,
    };
  }

  /** Manager: their own Players and what they have earned from them. */
  async mine(actor: Actor, fromInput?: string, toInput?: string) {
    if (actor.role !== Role.MANAGER) throw new ForbiddenException("Only Managers have a personal commission statement");
    const period = this.period(fromInput, toInput);
    const accounts = await this.accounts(actor.id);
    const results = await this.playerResults(accounts, period);
    const manager = accounts.find((account) => account.id === actor.id)!;
    const players = this.playersUnder(manager.id, this.childrenOf(accounts), results);
    const totals = players.reduce((sum, player) => add(sum, player), emptyTotals());
    const parent = actor.parentId
      ? await this.prisma.user.findUnique({ where: { id: actor.parentId }, select: { username: true } })
      : null;

    return {
      ...period,
      manager: { id: manager.id, username: manager.username, commissionRate: manager.commissionRate },
      paidBy: parent?.username ?? null,
      totals: { ...totals, commission: cut(totals.net, manager.commissionRate) },
      players,
    };
  }

  private teamOf(owner: Account, children: Map<string, Account[]>, results: Map<string, PlayerResult>) {
    const managers = (children.get(owner.id) ?? [])
      .filter((child) => child.role === Role.MANAGER)
      .map((manager) => {
        const players = this.playersUnder(manager.id, children, results);
        const totals = players.reduce((sum, player) => add(sum, player), emptyTotals());
        return {
          id: manager.id,
          username: manager.username,
          status: manager.status,
          commissionRate: manager.commissionRate,
          ...totals,
          commission: cut(totals.net, manager.commissionRate),
          players,
        };
      })
      .sort((a, b) => b.commission - a.commission || a.username.localeCompare(b.username));

    const directPlayers = (children.get(owner.id) ?? [])
      .filter((child) => child.role === Role.PLAYER)
      .map((player) => results.get(player.id)!)
      .sort((a, b) => b.net - a.net || a.username.localeCompare(b.username));

    const totals = emptyTotals();
    for (const manager of managers) add(totals, manager);
    for (const player of directPlayers) add(totals, player);

    const superAdminCut = cut(totals.net, owner.commissionRate);
    const managerCommission = round(managers.reduce((sum, manager) => sum + manager.commission, 0));
    return {
      totals: {
        ...totals,
        superAdminCut,
        managerCommission,
        ownerKeeps: round(totals.net - superAdminCut - managerCommission),
      },
      managers,
      directPlayers,
    };
  }

  /** Every Player anywhere under this account (normally its direct children). */
  private playersUnder(rootId: string, children: Map<string, Account[]>, results: Map<string, PlayerResult>): PlayerResult[] {
    const players: PlayerResult[] = [];
    const stack = [...(children.get(rootId) ?? [])];
    while (stack.length) {
      const account = stack.pop()!;
      if (account.role === Role.PLAYER) players.push(results.get(account.id)!);
      stack.push(...(children.get(account.id) ?? []));
    }
    return players.sort((a, b) => b.net - a.net || a.username.localeCompare(b.username));
  }

  private childrenOf(accounts: Account[]): Map<string, Account[]> {
    const children = new Map<string, Account[]>();
    for (const account of accounts) {
      if (!account.parentId) continue;
      const list = children.get(account.parentId) ?? [];
      list.push(account);
      children.set(account.parentId, list);
    }
    return children;
  }

  /** The whole platform (rootId null) or one account plus everyone under it. */
  private async accounts(rootId: string | null): Promise<Account[]> {
    const ids = rootId ? [rootId, ...(await this.hierarchy.getDescendantIds(rootId))] : null;
    const rows = await this.prisma.user.findMany({
      where: ids ? { id: { in: ids } } : {},
      select: { id: true, username: true, role: true, parentId: true, status: true, commissionRate: true },
    });
    return rows.map((row) => ({ ...row, commissionRate: Number(row.commissionRate) }));
  }

  private async playerResults(accounts: Account[], period: { from: string; to: string }) {
    const players = accounts.filter((account) => account.role === Role.PLAYER);
    const grouped = players.length
      ? await this.prisma.bet.groupBy({
          by: ["playerId"],
          where: {
            playerId: { in: players.map((player) => player.id) },
            status: { in: [BetStatus.WON, BetStatus.LOST] },
            settledAt: { gte: new Date(period.from), lt: new Date(period.to) },
          },
          _sum: { stake: true, payout: true },
          _count: { _all: true },
        })
      : [];
    const byPlayer = new Map(grouped.map((row) => [row.playerId, row]));

    const results = new Map<string, PlayerResult>();
    for (const player of players) {
      const row = byPlayer.get(player.id);
      const staked = round(Number(row?._sum.stake ?? 0));
      const paidOut = round(Number(row?._sum.payout ?? 0));
      results.set(player.id, {
        id: player.id,
        username: player.username,
        status: player.status,
        bets: row?._count._all ?? 0,
        staked,
        paidOut,
        net: round(staked - paidOut),
      });
    }
    return results;
  }

  /** [from, to) — defaults to this week so far. */
  private period(fromInput?: string, toInput?: string) {
    const now = new Date();
    const from = fromInput ? new Date(fromInput) : startOfWeek(now);
    const to = toInput ? new Date(toInput) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException("Invalid date");
    if (from >= to) throw new BadRequestException("The start date must be before the end date");
    if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * 86_400_000) {
      throw new BadRequestException("Choose a period of one year or less");
    }
    return { from: from.toISOString(), to: to.toISOString() };
  }
}
