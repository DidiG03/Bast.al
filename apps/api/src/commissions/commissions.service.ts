import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { BalanceTransactionStatus, Prisma, Role, UserStatus } from "@prisma/client";
import { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";
import { addDays, startOfDay, startOfWeek } from "../time";
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

/** `commission`: what this Player's results earn their Manager (0 without one). */
export type PlayerResult = Totals & { id: string; username: string; status: UserStatus; commission: number };

/**
 * Where one commission relationship stands: Super Admin and an Owner
 * ("owner"), or an Owner and one of their Managers ("manager").
 *
 * Losses carry over. Each payment covers everything since the last one, so a
 * losing week is made up by the next winning weeks before anything is due:
 * Players win $1,000 in week 1 and lose $1,000 in week 2, and at 10% nothing
 * is owed for week 2. The first payment starts where the period on screen
 * starts.
 */
export type PayoutStanding = {
  /** The end of the last payment (not rejected), if any. */
  paidUpTo: string | null;
  /** Where a payment now would start: the end of the last one, else the period's start. Null when already paid up to the period's end. */
  start: string | null;
  /** The commission from `start` to the period's end; below zero while losses are still being made up. */
  balance: number;
  /** What a payment now would be: `balance`, or nothing while it's below zero. */
  due: number;
};

type Kind = "owner" | "manager";

const MAX_PERIOD_DAYS = 366;
const DAY_MS = 86_400_000;

function round(value: number): number {
  return Math.round(value * 100) / 100;
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

/** One group of settlement journal rows: a Player's results under one Owner and Manager. */
type Group = {
  ownerId: string | null;
  managerId: string | null;
  playerId: string;
  totals: Totals;
  /** Unrounded commission: Super Admin's from the Owner, and the Manager's from the Owner. */
  ownerCut: number;
  managerCut: number;
};

/**
 * Commission views, from the settlement journal (see SettlementEntry).
 *
 * The money flows up the chain: a Player's losses are the team's net
 * revenue. A Manager earns their rate on their own Players' net revenue,
 * paid by their Owner. Super Admin takes the Owner's rate on the Owner's
 * whole team net revenue (before Manager commissions come out). The Owner
 * keeps what is left. Net revenue can be negative when Players win overall,
 * and the commissions then go negative the same way.
 *
 * Every result counts for the team and at the rates in force when the bet
 * was placed, and on the day it was settled or corrected. So moving a Player,
 * changing a rate or correcting an old result never changes a past period.
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
    const groups = await this.groups(Prisma.sql`TRUE`, period);
    const children = this.childrenOf(accounts);

    const ownerAccounts = accounts.filter((account) => account.role === Role.OWNER);
    const standings = await this.standings("owner", ownerAccounts.map((owner) => owner.id), period);
    const owners = ownerAccounts
      .map((owner) => {
        const mine = groups.filter((group) => group.ownerId === owner.id);
        const totals = mine.reduce((sum, group) => add(sum, group.totals), emptyTotals());
        const superAdminCut = round(mine.reduce((sum, group) => sum + group.ownerCut, 0));
        const managerCommission = this.managerCommission(mine);
        const managers = (children.get(owner.id) ?? []).filter((child) => child.role === Role.MANAGER);
        const players = [...(children.get(owner.id) ?? []), ...managers.flatMap((manager) => children.get(manager.id) ?? [])].filter((account) => account.role === Role.PLAYER);
        return {
          id: owner.id,
          username: owner.username,
          status: owner.status,
          commissionRate: owner.commissionRate,
          managers: managers.length,
          players: players.length,
          ...totals,
          superAdminCut,
          managerCommission,
          ownerKeeps: round(totals.net - superAdminCut - managerCommission),
          payout: standings.get(owner.id)!,
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

    return { ...this.iso(period), totals, owners };
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

    const groups = await this.groups(Prisma.sql`owner_id = ${id}`, period);
    const byId = await this.withNames(accounts, groups);

    // Managers: this Owner's own, plus any whose Players' results are in the team (there shouldn't be others).
    const managerIds = new Set([
      ...accounts.filter((account) => account.role === Role.MANAGER && account.parentId === id).map((account) => account.id),
      ...groups.map((group) => group.managerId).filter((managerId): managerId is string => managerId !== null),
    ]);
    const standings = await this.standings("manager", [...managerIds], period);
    const managers = [...managerIds]
      .map((managerId) => {
        const manager = byId.get(managerId)!;
        const mine = groups.filter((group) => group.managerId === managerId);
        const players = this.players(accounts.filter((account) => account.parentId === managerId), mine, byId);
        const totals = players.reduce((sum, player) => add(sum, player), emptyTotals());
        return {
          id: manager.id,
          username: manager.username,
          status: manager.status,
          commissionRate: manager.commissionRate,
          ...totals,
          commission: round(mine.reduce((sum, group) => sum + group.managerCut, 0)),
          players,
          payout: standings.get(managerId)!,
        };
      })
      .sort((a, b) => b.commission - a.commission || a.username.localeCompare(b.username));

    const directPlayers = this.players(
      accounts.filter((account) => account.parentId === id),
      groups.filter((group) => group.managerId === null),
      byId,
    );

    const totals = groups.reduce((sum, group) => add(sum, group.totals), emptyTotals());
    const superAdminCut = round(groups.reduce((sum, group) => sum + group.ownerCut, 0));
    const managerCommission = round(managers.reduce((sum, manager) => sum + manager.commission, 0));
    return {
      ...this.iso(period),
      owner: { id: owner.id, username: owner.username, commissionRate: owner.commissionRate },
      totals: { ...totals, superAdminCut, managerCommission, ownerKeeps: round(totals.net - superAdminCut - managerCommission) },
      /** Where the Owner stands with Super Admin. */
      ownerPayout: (await this.standings("owner", [id], period)).get(id)!,
      managers,
      directPlayers,
    };
  }

  /** Manager: their own Players and what they have earned from them. */
  async mine(actor: Actor, fromInput?: string, toInput?: string) {
    if (actor.role !== Role.MANAGER) throw new ForbiddenException("Only Managers have a personal commission statement");
    const period = this.period(fromInput, toInput);
    const accounts = await this.accounts(actor.id);
    const groups = await this.groups(Prisma.sql`manager_id = ${actor.id}`, period);
    const byId = await this.withNames(accounts, groups);
    const manager = byId.get(actor.id)!;
    const players = this.players(accounts.filter((account) => account.parentId === actor.id), groups, byId);
    const totals = players.reduce((sum, player) => add(sum, player), emptyTotals());
    const parent = actor.parentId
      ? await this.prisma.user.findUnique({ where: { id: actor.parentId }, select: { username: true } })
      : null;

    return {
      ...this.iso(period),
      manager: { id: manager.id, username: manager.username, commissionRate: manager.commissionRate },
      paidBy: parent?.username ?? null,
      totals: { ...totals, commission: round(groups.reduce((sum, group) => sum + group.managerCut, 0)) },
      /** Where this Manager stands with their Owner. */
      payout: (await this.standings("manager", [actor.id], period)).get(actor.id)!,
      players,
    };
  }

  /**
   * Manager: earnings week by week (Monday to Sunday, Albanian time), newest
   * first, so they can see how this week compares with the ones before.
   */
  async history(actor: Actor, weeks: number) {
    if (actor.role !== Role.MANAGER) throw new ForbiddenException("Only Managers have a personal commission statement");
    const manager = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { commissionRate: true } });

    const now = new Date();
    const thisWeek = startOfWeek(now);
    const starts = Array.from({ length: weeks }, (_, index) => addDays(thisWeek, -7 * index));
    const oldest = starts[starts.length - 1];
    const entries = await this.entries({ managerId: actor.id }, oldest, now);

    const rows = starts.map((start, index) => ({
      from: start.toISOString(),
      // The current week runs to now; earlier weeks end where the next one starts.
      to: index === 0 ? now.toISOString() : starts[index - 1].toISOString(),
      ...emptyTotals(),
      commission: 0,
    }));
    const cuts = rows.map(() => 0);
    for (const entry of entries) {
      const at = entry.createdAt.getTime();
      const index = rows.findIndex((row) => at >= new Date(row.from).getTime() && at < new Date(row.to).getTime());
      if (index === -1) continue;
      add(rows[index], entry.totals);
      cuts[index] += entry.managerCut;
    }
    rows.forEach((row, index) => (row.commission = round(cuts[index])));

    return { commissionRate: Number(manager.commissionRate), weeks: rows };
  }

  /**
   * Settled-bet totals day by day (Albanian time), oldest first, for the
   * overview chart: the whole platform for Super Admin, an Owner's team, or
   * a Manager's Players. Today runs to now.
   */
  async daily(actor: Actor, days: number) {
    if (actor.role === Role.PLAYER) throw new ForbiddenException("Players don't have team totals");
    const scope = actor.role === Role.SUPER_ADMIN ? {} : actor.role === Role.OWNER ? { ownerId: actor.id } : { managerId: actor.id };

    const now = new Date();
    const today = startOfDay(now);
    const starts = Array.from({ length: days }, (_, index) => addDays(today, index - (days - 1)));
    const rows = starts.map((from, index) => ({
      from: from.toISOString(),
      to: (index === days - 1 ? now : starts[index + 1]).toISOString(),
      ...emptyTotals(),
    }));
    for (const entry of await this.entries(scope, starts[0], now)) {
      // The day the entry falls in: the first one starting after it, less one.
      const next = starts.findIndex((start) => start > entry.createdAt);
      const index = next === -1 ? starts.length - 1 : next - 1;
      if (index >= 0) add(rows[index], entry.totals);
    }
    return { days: rows };
  }

  /**
   * Where each of these accounts stands for a period [from, to): see
   * PayoutStanding. `kind` "owner" is Super Admin's cut from an Owner,
   * "manager" is a Manager's commission from their Owner.
   */
  async standings(kind: Kind, userIds: string[], period: { from: Date; to: Date }): Promise<Map<string, PayoutStanding>> {
    const result = new Map<string, PayoutStanding>();
    if (userIds.length === 0) return result;
    const payouts = await this.prisma.commissionPayout.findMany({
      where: { userId: { in: userIds }, transaction: { status: { not: BalanceTransactionStatus.REJECTED } } },
      orderBy: { periodTo: "desc" },
      select: { userId: true, periodTo: true },
    });
    const paidUpTo = new Map<string, Date>();
    for (const payout of payouts) if (!paidUpTo.has(payout.userId)) paidUpTo.set(payout.userId, payout.periodTo);

    await Promise.all(
      userIds.map(async (userId) => {
        const last = paidUpTo.get(userId) ?? null;
        if (last && last >= period.to) {
          result.set(userId, { paidUpTo: last.toISOString(), start: null, balance: 0, due: 0 });
          return;
        }
        const start = last ?? period.from;
        const balance = await this.cutBetween(kind, userId, start, period.to);
        result.set(userId, { paidUpTo: last?.toISOString() ?? null, start: start.toISOString(), balance, due: Math.max(0, balance) });
      }),
    );
    return result;
  }

  /** The commission for one relationship over [from, to), rounded to the cent. */
  private async cutBetween(kind: Kind, userId: string, from: Date, to: Date): Promise<number> {
    const [rows] = await this.prisma.$queryRaw<Array<{ cut: Prisma.Decimal | null }>>`
      SELECT SUM((stake - payout) * ${kind === "owner" ? Prisma.raw("owner_rate") : Prisma.raw("manager_rate")} / 100) AS cut
      FROM settlement_entries
      WHERE ${kind === "owner" ? Prisma.raw("owner_id") : Prisma.raw("manager_id")} = ${userId}
        AND created_at >= ${from} AND created_at < ${to}
    `;
    return round(Number(rows?.cut ?? 0));
  }

  /** Journal totals in a period, one group per Player, Owner and Manager. */
  private async groups(where: Prisma.Sql, period: { from: Date; to: Date }): Promise<Group[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ owner_id: string | null; manager_id: string | null; player_id: string; bets: number; staked: Prisma.Decimal; paid_out: Prisma.Decimal; owner_cut: Prisma.Decimal; manager_cut: Prisma.Decimal }>
    >`
      SELECT owner_id, manager_id, player_id,
             SUM(bets)::int AS bets,
             SUM(stake) AS staked,
             SUM(payout) AS paid_out,
             SUM((stake - payout) * owner_rate / 100) AS owner_cut,
             SUM((stake - payout) * manager_rate / 100) AS manager_cut
      FROM settlement_entries
      WHERE ${where} AND created_at >= ${period.from} AND created_at < ${period.to}
      GROUP BY owner_id, manager_id, player_id
    `;
    return rows.map((row) => {
      const staked = round(Number(row.staked));
      const paidOut = round(Number(row.paid_out));
      return {
        ownerId: row.owner_id,
        managerId: row.manager_id,
        playerId: row.player_id,
        totals: { bets: Number(row.bets), staked, paidOut, net: round(staked - paidOut) },
        ownerCut: Number(row.owner_cut),
        managerCut: Number(row.manager_cut),
      };
    });
  }

  /** Journal rows one by one, for day and week buckets. */
  private async entries(scope: { ownerId?: string; managerId?: string }, from: Date, to: Date) {
    const rows = await this.prisma.settlementEntry.findMany({
      where: { ...scope, createdAt: { gte: from, lt: to } },
      select: { bets: true, stake: true, payout: true, managerRate: true, createdAt: true },
    });
    return rows.map((row) => {
      const staked = Number(row.stake);
      const paidOut = Number(row.payout);
      return {
        createdAt: row.createdAt,
        totals: { bets: row.bets, staked, paidOut, net: staked - paidOut },
        managerCut: ((staked - paidOut) * Number(row.managerRate)) / 100,
      };
    });
  }

  /** What an Owner pays their Managers: each Manager's commission, rounded on its own. */
  private managerCommission(groups: Group[]): number {
    const byManager = new Map<string, number>();
    for (const group of groups) if (group.managerId) byManager.set(group.managerId, (byManager.get(group.managerId) ?? 0) + group.managerCut);
    return round([...byManager.values()].reduce((sum, cut) => sum + round(cut), 0));
  }

  /**
   * Players to list under one Manager (or directly under the Owner): the
   * ones there now, even with nothing settled, plus anyone whose results in
   * this period count here because they were here when they bet.
   */
  private players(current: Account[], groups: Group[], byId: Map<string, Account>): PlayerResult[] {
    const ids = new Set([...current.filter((account) => account.role === Role.PLAYER).map((account) => account.id), ...groups.map((group) => group.playerId)]);
    return [...ids]
      .map((playerId) => {
        const player = byId.get(playerId)!;
        const mine = groups.filter((group) => group.playerId === playerId);
        return {
          id: player.id,
          username: player.username,
          status: player.status,
          ...mine.reduce((sum, group) => add(sum, group.totals), emptyTotals()),
          commission: round(mine.reduce((sum, group) => sum + group.managerCut, 0)),
        };
      })
      .sort((a, b) => b.net - a.net || a.username.localeCompare(b.username));
  }

  /** `accounts` by id, plus anyone named in the journal groups who has since left this part of the tree. */
  private async withNames(accounts: Account[], groups: Group[]): Promise<Map<string, Account>> {
    const byId = new Map(accounts.map((account) => [account.id, account]));
    const missing = [...new Set(groups.flatMap((group) => [group.playerId, group.managerId]).filter((id): id is string => id !== null && !byId.has(id)))];
    if (missing.length > 0) {
      const rows = await this.prisma.user.findMany({
        where: { id: { in: missing } },
        select: { id: true, username: true, role: true, parentId: true, status: true, commissionRate: true },
      });
      for (const row of rows) byId.set(row.id, { ...row, commissionRate: Number(row.commissionRate) });
    }
    return byId;
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

  /** The whole platform (rootId null) or one account plus everyone under it, as it is now. */
  private async accounts(rootId: string | null): Promise<Account[]> {
    const ids = rootId ? [rootId, ...(await this.hierarchy.getDescendantIds(rootId))] : null;
    const rows = await this.prisma.user.findMany({
      where: ids ? { id: { in: ids } } : {},
      select: { id: true, username: true, role: true, parentId: true, status: true, commissionRate: true },
    });
    return rows.map((row) => ({ ...row, commissionRate: Number(row.commissionRate) }));
  }

  /** [from, to) — defaults to this week so far (from Monday, Albanian time). */
  period(fromInput?: string, toInput?: string): { from: Date; to: Date } {
    const now = new Date();
    const from = fromInput ? new Date(fromInput) : startOfWeek(now);
    const to = toInput ? new Date(toInput) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException("Invalid date");
    if (from >= to) throw new BadRequestException("The start date must be before the end date");
    if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
      throw new BadRequestException("Choose a period of one year or less");
    }
    return { from, to };
  }

  private iso(period: { from: Date; to: Date }) {
    return { from: period.from.toISOString(), to: period.to.toISOString() };
  }
}
