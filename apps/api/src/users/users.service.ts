import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { BalanceTransactionStatus, BalanceTransactionType, BetStatus, NotificationSeverity, NotificationType, Prisma, Role, UserStatus } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { ClerkService } from "../auth/clerk.service";
import { Actor, canCreateRole, canDelegateTo, roleRequiresMfa } from "../auth/permissions";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../prisma.service";
import { casinoClosedReason } from "../casino/access";
import { CreateUserDto } from "./dto/create-user.dto";
import { AdjustBalanceDto, DelegateCreditDto, ReclaimCreditDto } from "./dto/balance-transaction.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { HierarchyService } from "./hierarchy.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RealtimeService } from "../realtime/realtime.service";
import { AuditQueryDto } from "./dto/audit-query.dto";

/** Fields safe to return to clients — never includes email/password/ciphertext. */
const publicUserSelect = {
  id: true,
  username: true,
  role: true,
  parentId: true,
  status: true,
  balance: true,
  balanceLimit: true,
  managerCapacity: true,
  commissionRate: true,
  approvalLimit: true,
  createdAt: true,
} as const;

function privateEmailFor(username: string): string {
  return `${username.toLowerCase()}@users.bast.internal`;
}

/** Roles that hold direct Players/Managers and so need a delegation capacity. */
function holdsDirectReports(role: Role): boolean {
  return role === Role.OWNER || role === Role.MANAGER;
}

/**
 * Delegations above this amount need a second person's sign-off before any
 * balance moves. Super Admin is exempt: it is the top of the chain, so there
 * is nobody above it to approve.
 */
const APPROVAL_THRESHOLD = 10000;

const HAS_HISTORY = "This account has bets or money history, so it can't be deleted without changing past reports. Suspend it instead.";

/** Most accounts a bulk action may touch at once. */
const BULK_LIMIT = 100;
/** How long a Player waits between two top-up requests. */
const TOP_UP_REQUEST_GAP_MS = 30 * 60_000;

function dateRange(from?: string, to?: string) {
  return from || to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {};
}

/**
 * Extra work done inside a credit move's own database transaction, so it
 * commits or rolls back together with the money: `before` runs ahead of any
 * change (to lock and check), `after` once the ledger entry exists.
 */
export type LedgerHooks = {
  before?: (tx: Prisma.TransactionClient) => Promise<void>;
  after?: (tx: Prisma.TransactionClient, transactionId: string) => Promise<void>;
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
    private readonly hierarchy: HierarchyService,
    private readonly audit: AuditService,
    private readonly crypto: FieldEncryptionService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Largest delegation this actor can make without anyone's sign-off. A
   * Manager uses their own limit, else their Owner's team-wide default for
   * Managers, else the platform default. Everyone else uses the default.
   */
  private async approvalThreshold(actor: Pick<Actor, "role" | "approvalLimit" | "parentId">): Promise<number> {
    if (actor.role !== Role.MANAGER) return APPROVAL_THRESHOLD;
    if (actor.approvalLimit !== null) return Number(actor.approvalLimit);
    const owner = actor.parentId
      ? await this.prisma.user.findUnique({ where: { id: actor.parentId }, select: { role: true, managerApprovalLimit: true } })
      : null;
    if (owner?.role === Role.OWNER && owner.managerApprovalLimit !== null) return Number(owner.managerApprovalLimit);
    return APPROVAL_THRESHOLD;
  }

  async me(actor: Actor, mfaEnforcementEnabled: boolean) {
    let mfaEnabled = false;
    const mfaRequired = roleRequiresMfa(actor.role) && mfaEnforcementEnabled;
    if (mfaEnforcementEnabled) {
      try {
        mfaEnabled = await this.clerk.hasTotpEnabled(actor.clerkId);
      } catch {
        mfaEnabled = false;
      }

    }
    const parent = actor.parentId
      ? await this.prisma.user.findUnique({
          where: { id: actor.parentId },
          select: { id: true, username: true, role: true },
        })
      : null;
    return {
      id: actor.id,
      username: actor.username,
      role: actor.role,
      parentId: actor.parentId,
      parent,
      status: actor.status,
      balance: Number(actor.balance),
      balanceLimit: Number(actor.balanceLimit),
      managerCapacity: actor.managerCapacity,
      commissionRate: Number(actor.commissionRate),
      approvalLimit: await this.approvalThreshold(actor),
      mfaRequired,
      mfaEnabled,
      mfaSatisfied: !mfaRequired || mfaEnabled,
      /** Player only: the Casino tab is open to them. */
      casinoOpen: actor.role === Role.PLAYER ? (await casinoClosedReason(this.prisma, actor)) === null : false,
    };
  }

  async securityOverview(actor: Actor) {
    const [sessions, activity, loginHistory] = await Promise.all([
      this.clerk.api.sessions.getSessionList({ userId: actor.clerkId }),
      this.prisma.auditLog.findMany({
        where: { OR: [{ actorId: actor.id }, { targetId: actor.id }], action: { in: ["auth.success", "auth.failure"] } },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, action: true, ipAddress: true, metadata: true, createdAt: true },
      }),
      this.prisma.loginHistory.findMany({ where: { userId: actor.id }, orderBy: { lastSeenAt: "desc" }, take: 30, select: { id: true, sessionId: true, ipAddress: true, device: true, browser: true, location: true, lastSeenAt: true, createdAt: true } }),
    ]);

    // What each signed-in device is and where it was last seen, from its sign-in history.
    const seen = await this.prisma.loginHistory.findMany({
      where: { userId: actor.id, sessionId: { in: sessions.data.map((session) => session.id) } },
      select: { sessionId: true, ipAddress: true, device: true, browser: true, location: true },
    });
    const bySession = new Map(seen.map((row) => [row.sessionId, row]));
    return {
      sessions: sessions.data.map((session) => ({
        id: session.id,
        status: session.status,
        lastActiveAt: session.lastActiveAt,
        expireAt: session.expireAt,
        abandonAt: session.abandonAt,
        device: bySession.get(session.id)?.device ?? null,
        browser: bySession.get(session.id)?.browser ?? null,
        ipAddress: bySession.get(session.id)?.ipAddress ?? null,
        location: bySession.get(session.id)?.location ?? null,
      })),
      activity,
      loginHistory,
    };
  }

  async revokeSession(actor: Actor, sessionId: string) {
    const sessions = await this.clerk.api.sessions.getSessionList({ userId: actor.clerkId });
    if (!sessions.data.some((session) => session.id === sessionId)) {
      throw new NotFoundException("Session not found");
    }
    await this.clerk.api.sessions.revokeSession(sessionId);
    await this.audit.log({ actorId: actor.id, action: "auth.session_revoke", metadata: { sessionId } });
    return { ok: true };
  }

  async revokeOtherSessions(actor: Actor, currentSessionId?: string) {
    const sessions = await this.clerk.api.sessions.getSessionList({ userId: actor.clerkId });
    const otherSessions = sessions.data.filter((session) => session.id !== currentSessionId);
    await Promise.all(otherSessions.map((session) => this.clerk.api.sessions.revokeSession(session.id)));
    await this.audit.log({ actorId: actor.id, action: "auth.sessions_revoke_other", metadata: { count: otherSessions.length } });
    return { revoked: otherSessions.length };
  }

  async securitySettings(actor: Actor) {
    if (actor.role !== Role.SUPER_ADMIN) throw new ForbiddenException("Security settings are restricted");
    return this.prisma.securitySetting.upsert({ where: { id: "default" }, create: {}, update: {} });
  }

  async updateSecuritySettings(actor: Actor, input: { failLimit: number; windowMs: number; banMs: number }) {
    if (actor.role !== Role.SUPER_ADMIN) throw new ForbiddenException("Security settings are restricted");
    const settings = await this.prisma.securitySetting.upsert({ where: { id: "default" }, create: input, update: input });
    await this.audit.log({ actorId: actor.id, action: "security.settings_update", metadata: input });
    return settings;
  }

  async listVisible(actor: Actor) {
    if (actor.role === Role.SUPER_ADMIN) {
      return this.prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        select: publicUserSelect,
      });
    }

    const descendantIds = await this.hierarchy.getDescendantIds(actor.id);
    return this.prisma.user.findMany({
      where: { id: { in: [actor.id, ...descendantIds] } },
      orderBy: { createdAt: "desc" },
      select: publicUserSelect,
    });
  }

  /** Ids an Owner (or Manager) may see in reports and audit logs: themselves and their whole downline. */
  private async scopeIds(actor: Actor): Promise<string[] | null> {
    if (actor.role === Role.SUPER_ADMIN) return null;
    return [actor.id, ...(await this.hierarchy.getDescendantIds(actor.id))];
  }

  /**
   * Super Admin: the whole platform, broken down by Owner.
   * Owner: their own business only, broken down by Manager.
   * Manager: their own Players only.
   */
  async report(actor: Actor) {
    if (actor.role === Role.PLAYER) {
      throw new ForbiddenException("Reports are restricted to Super Admins, Owners and Managers");
    }
    const scope = await this.scopeIds(actor);

    const [users, recentAudit] = await Promise.all([
      this.prisma.user.findMany({
        where: scope ? { id: { in: scope } } : {},
        orderBy: { createdAt: "asc" },
        select: publicUserSelect,
      }),
      this.prisma.auditLog.findMany({
        where: scope ? { OR: [{ actorId: { in: scope } }, { targetId: { in: scope } }] } : {},
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true,
          action: true,
          targetId: true,
          createdAt: true,
          actor: { select: { username: true, role: true } },
          target: { select: { username: true, role: true } },
        },
      }),
    ]);

    const roleBreakdown = {
      OWNER: users.filter((user) => user.role === Role.OWNER).length,
      MANAGER: users.filter((user) => user.role === Role.MANAGER).length,
      PLAYER: users.filter((user) => user.role === Role.PLAYER).length,
    };
    const statusBreakdown = {
      ACTIVE: users.filter((user) => user.status === UserStatus.ACTIVE).length,
      SUSPENDED: users.filter((user) => user.status === UserStatus.SUSPENDED).length,
    };
    // The accounts each role manages directly: Owners for Super Admin,
    // Managers for an Owner, Players for a Manager.
    const accountRole = actor.role === Role.SUPER_ADMIN ? Role.OWNER : actor.role === Role.OWNER ? Role.MANAGER : Role.PLAYER;
    const accounts = users.filter((user) => user.role === accountRole);
    const downline = users.filter((user) => user.id !== actor.id);

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        users: users.length,
        owners: roleBreakdown.OWNER,
        managers: roleBreakdown.MANAGER,
        players: roleBreakdown.PLAYER,
        active: statusBreakdown.ACTIVE,
        suspended: statusBreakdown.SUSPENDED,
        totalBalance: downline.reduce((total, user) => total + Number(user.balance), 0),
      },
      roleBreakdown,
      statusBreakdown,
      accountRole,
      accounts: accounts.map((account) => ({
        id: account.id,
        username: account.username,
        status: account.status,
        balance: Number(account.balance),
        commissionRate: Number(account.commissionRate),
        directReports: users.filter((user) => user.parentId === account.id).length,
      })),
      recentAudit,
    };
  }

  /** An Owner's own commission rate (Super Admin's cut) or a Manager's (their Owner's cut to them). */
  async commissionRate(actor: Actor, id: string) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true, parentId: true, commissionRate: true } });
    if (!target) throw new NotFoundException("User not found");
    if (target.role !== Role.OWNER && target.role !== Role.MANAGER) {
      throw new BadRequestException("Only Owners and Managers have a commission rate");
    }
    if (!(await this.canManageCommissionRate(actor, target))) {
      throw new ForbiddenException("You cannot view this commission rate");
    }
    return { rate: Number(target.commissionRate) };
  }

  async setCommissionRate(actor: Actor, id: string, rate: number, ipAddress?: string) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true, parentId: true } });
    if (!target) throw new NotFoundException("User not found");
    if (target.role !== Role.OWNER && target.role !== Role.MANAGER) {
      throw new BadRequestException("Only Owners and Managers have a commission rate");
    }
    if (!(await this.canManageCommissionRate(actor, target))) {
      throw new ForbiddenException("You cannot set this commission rate");
    }
    const updated = await this.prisma.user.update({ where: { id }, data: { commissionRate: rate }, select: publicUserSelect });
    await this.audit.log({ actorId: actor.id, action: "user.commission_rate_update", targetId: id, ipAddress, metadata: { rate } });
    await this.notifications.create({
      userId: id,
      type: NotificationType.COMMISSION_RATE_UPDATED,
      title: "Commission rate updated",
      message: `Your commission rate was set to ${rate}%.`,
      deepLink: "/dashboard",
      metadata: { actorId: actor.id, rate },
    });
    return updated;
  }

  /** Only the target's own direct parent (whoever set them up in the hierarchy) may manage their rate. */
  private async canManageCommissionRate(actor: Actor, target: { role: Role; parentId: string | null }): Promise<boolean> {
    if (actor.role === Role.SUPER_ADMIN) return true;
    return target.parentId === actor.id;
  }

  async auditLog(actor: Actor, query: AuditQueryDto) {
    if (actor.role === Role.PLAYER) {
      throw new ForbiddenException("Audit logs are restricted to Super Admins, Owners and Managers");
    }
    // Owners and Managers only ever see entries where they or someone in their downline is
    // the actor or the target.
    const scope = await this.scopeIds(actor);
    const limit = Math.min(query.limit ?? 50, 100);
    const page = query.page ?? 1;
    const searchUsers = async (value?: string, role?: Role) => value?.trim()
      ? this.prisma.user.findMany({
          where: {
            OR: [{ id: { equals: value.trim() } }, { username: { contains: value.trim(), mode: "insensitive" } }],
            ...(role ? { role } : {}),
          },
          select: { id: true },
        })
      : [];
    const [actorUsers, targetUsers, roleUsers] = await Promise.all([
      searchUsers(query.actor, query.actor ? query.role : undefined),
      searchUsers(query.target, query.target ? query.role : undefined),
      query.role ? this.prisma.user.findMany({ where: { role: query.role }, select: { id: true } }) : [],
    ]);
    const filters = {
      ...(query.actor ? { actorId: { in: actorUsers.map((user) => user.id) } } : {}),
      ...(query.target ? { targetId: { in: targetUsers.map((user) => user.id) } } : {}),
      ...(query.role && !query.actor && !query.target ? {
        OR: [
          { actorId: { in: roleUsers.map((user) => user.id) } },
          { targetId: { in: roleUsers.map((user) => user.id) } },
        ],
      } : {}),
      ...(query.action ? { action: { contains: query.action.trim(), mode: "insensitive" as const } } : {}),
      ...(query.from || query.to ? { createdAt: {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      } } : {}),
    };
    const where = scope
      ? { AND: [filters, { OR: [{ actorId: { in: scope } }, { targetId: { in: scope } }] }] }
      : filters;
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit,
        select: { id: true, action: true, ipAddress: true, metadata: true, createdAt: true,
          actor: { select: { id: true, username: true, role: true } },
          target: { select: { id: true, username: true, role: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async createUser(actor: Actor, dto: CreateUserDto, ipAddress?: string) {
    if (!canCreateRole(actor.role, dto.role)) {
      await this.audit.log({
        actorId: actor.id,
        action: "authz.failure",
        ipAddress,
        metadata: { reason: "cannot_create_role", role: dto.role },
      });
      throw new ForbiddenException(`Role ${actor.role} cannot create ${dto.role}`);
    }

    let parentId = actor.id;
    if (dto.parentId) {
      if (dto.role !== Role.PLAYER) {
        throw new BadRequestException("Only Players can be assigned to a Manager");
      }
      if (!(await this.hierarchy.canActOn(actor, dto.parentId))) {
        throw new ForbiddenException("Assigned Manager is outside your hierarchy subtree");
      }
      const manager = await this.prisma.user.findUnique({
        where: { id: dto.parentId },
        select: { role: true, status: true },
      });
      if (!manager) throw new NotFoundException("Assigned Manager not found");
      if (manager.role !== Role.MANAGER) {
        throw new BadRequestException("Players can only be assigned to Managers");
      }
      if (manager.status !== UserStatus.ACTIVE) {
        throw new BadRequestException("Players cannot be assigned to a suspended Manager");
      }
      parentId = dto.parentId;
    }

    if (dto.role === Role.PLAYER) {
      const parent = await this.prisma.user.findUniqueOrThrow({ where: { id: parentId }, select: { managerCapacity: true } });
      const assigned = await this.prisma.user.count({ where: { parentId, role: Role.PLAYER } });
      if (assigned >= parent.managerCapacity) {
        throw new BadRequestException(`This account has reached its player capacity (${parent.managerCapacity})`);
      }
    }

    const username = dto.username.toLowerCase();
    const privateEmail = privateEmailFor(username);
    const emailHash = this.crypto.blindIndex(privateEmail);

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ username }, { emailHash }] },
    });
    if (existing) {
      throw new ConflictException("Username already registered");
    }

    let clerkUser: { id: string };
    try {
      clerkUser = await this.clerk.createUser({
        username,
        password: dto.password,
      });
    } catch (error) {
      await this.audit.log({
        actorId: actor.id,
        action: "user.create.failure",
        ipAddress,
        metadata: { reason: "clerk_create_failed", username },
      });
      throw new BadRequestException(clerkRefusal(error, "create"));
    }

    try {
      const user = await this.prisma.user.create({
        data: {
          clerkId: clerkUser.id,
          username,
          emailCipher: this.crypto.encrypt(privateEmail),
          emailHash,
          role: dto.role,
          parentId,
          status: UserStatus.ACTIVE,
        },
        select: publicUserSelect,
      });

      await this.audit.log({
        actorId: actor.id,
        action: "user.create",
        targetId: user.id,
        ipAddress,
        metadata: { role: user.role, username: user.username },
      });
      if (user.role === Role.PLAYER && parentId !== actor.id) {
        const manager = await this.prisma.user.findUnique({ where: { id: parentId }, select: { username: true } });
        if (manager) {
          await this.notifications.create({
            userId: parentId,
            type: NotificationType.ACCOUNT_REASSIGNED,
            title: "New player assigned",
            message: `${user.username} was assigned to your team.`,
            deepLink: `/dashboard/users?userId=${user.id}`,
            metadata: { userId: user.id },
          });
        }
        await this.notifications.create({
          userId: user.id,
          type: NotificationType.ACCOUNT_REASSIGNED,
          title: "Account assigned",
          message: `Your account was assigned to manager ${manager?.username ?? "your manager"}.`,
          deepLink: `/dashboard/users?userId=${parentId}`,
          metadata: { managerId: parentId },
        });
      }

      return user;
    } catch (error) {
      await this.clerk.deleteUser(clerkUser.id);
      await this.audit.log({
        actorId: actor.id,
        action: "user.create.failure",
        ipAddress,
        metadata: { reason: "db_create_failed", clerkId: clerkUser.id },
      });
      if (error instanceof ConflictException) throw error;
      throw new ConflictException("Failed to persist user; Clerk account rolled back");
    }
  }

  async getById(actor: Actor, id: string, ipAddress?: string) {
    const target = await this.prisma.user.findUnique({
      where: { id },
      select: publicUserSelect,
    });
    if (!target) throw new NotFoundException("User not found");

    const allowed = await this.hierarchy.canActOn(actor, id);
    if (!allowed) {
      await this.audit.log({
        actorId: actor.id,
        action: "authz.failure",
        targetId: id,
        ipAddress,
        metadata: { reason: "outside_subtree" },
      });
      throw new ForbiddenException("Target is outside your hierarchy subtree");
    }

    return target;
  }

  /** Every credit this account has received or given — the full history behind its current balance. */
  /** Newest first. Pass `limit` (and `before`, the last entry's createdAt) to read it a page at a time. */
  async balanceLedger(actor: Actor, id: string, page: { before?: string; limit?: number } = {}) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!target) throw new NotFoundException("User not found");
    if (target.role === Role.SUPER_ADMIN) throw new BadRequestException("Super Admin accounts do not hold a balance");
    if (!(await this.hierarchy.canActOn(actor, id))) {
      throw new ForbiddenException("Target is outside your hierarchy subtree");
    }
    const before = page.before ? new Date(page.before) : null;
    const take = page.limit ? Math.min(Math.max(Math.floor(page.limit), 1), 100) : undefined;
    const entries = await this.prisma.balanceTransaction.findMany({
      where: { OR: [{ toUserId: id }, { fromUserId: id }], ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        type: true,
        amount: true,
        status: true,
        approvedAt: true,
        reason: true,
        createdAt: true,
        fromUserId: true,
        toUserId: true,
        fromUser: { select: { username: true } },
        toUser: { select: { username: true } },
        actor: { select: { username: true } },
      },
    });
    return entries.map((entry) => ({
      ...entry,
      // Signed from this account's point of view: received = positive, given away = negative.
      amount: entry.toUserId === id ? Number(entry.amount) : -Number(entry.amount),
      counterparty: entry.toUserId === id ? entry.fromUser?.username ?? noCounterparty(entry.type) : entry.toUser.username,
    }));
  }

  /** Give credit to a direct child: Owner→Manager, Owner→Player, or Manager→Player. Super Admin→Owner prints (no source deduction). */
  async delegateCredit(actor: Actor, id: string, dto: DelegateCreditDto, ipAddress?: string, hooks?: LedgerHooks) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException("User not found");
    if (!canDelegateTo(actor, target)) {
      throw new ForbiddenException("You may only delegate credit to a direct report");
    }
    if (target.status !== UserStatus.ACTIVE) {
      throw new BadRequestException("Cannot delegate credit to a suspended account");
    }

    const isPrint = actor.role === Role.SUPER_ADMIN;
    const requiresApproval = !isPrint && dto.amount > (await this.approvalThreshold(actor));

    if (requiresApproval) {
      const pending = await this.prisma.$transaction(async (tx) => {
        await hooks?.before?.(tx);
        const entry = await tx.balanceTransaction.create({
          data: {
            fromUserId: isPrint ? null : actor.id,
            toUserId: id,
            actorId: actor.id,
            type: BalanceTransactionType.DELEGATION,
            amount: dto.amount,
            reason: dto.reason,
            status: BalanceTransactionStatus.PENDING,
          },
          select: { id: true, status: true, amount: true, type: true, reason: true, createdAt: true },
        });
        await hooks?.after?.(tx, entry.id);
        return entry;
      });
      await this.audit.log({ actorId: actor.id, action: "user.delegation_pending", targetId: id, ipAddress, metadata: { transactionId: pending.id, amount: dto.amount } });
      // The initiator's own parent is the natural approver (Owner for a
      // Manager's transfer, Super Admin for an Owner's).
      if (actor.parentId) {
        await this.notifications.create({
          userId: actor.parentId,
          type: NotificationType.APPROVAL_REQUESTED,
          title: "Approval needed",
          message: `${actor.username} wants to delegate $${dto.amount.toFixed(2)} to ${target.username}.`,
          deepLink: "/dashboard/finance",
          metadata: { transactionId: pending.id, amount: dto.amount },
        });
      }
      return { ...pending, amount: Number(pending.amount), requiresApproval: true };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await hooks?.before?.(tx);
      if (!isPrint) {
        // Real transfer: the giver must currently hold at least this much.
        // Guarded atomic UPDATE — see delegateCreditGuardedUpdate note below.
        const giverRows = await tx.$queryRaw<{ id: string }[]>`
          UPDATE users
          SET balance = balance - ${dto.amount}::numeric
          WHERE id = ${actor.id} AND balance - ${dto.amount}::numeric >= 0
          RETURNING id
        `;
        if (giverRows.length === 0) {
          throw new BadRequestException("You do not have enough balance to delegate this amount");
        }
      }

      const receiverRows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE users
        SET balance = balance + ${dto.amount}::numeric
        WHERE id = ${id} AND balance + ${dto.amount}::numeric <= balance_limit
        RETURNING id
      `;
      if (receiverRows.length === 0) {
        // Throwing here rolls back the giver's decrement above too — the whole
        // transfer is all-or-nothing.
        throw new BadRequestException("This would exceed the recipient's balance limit");
      }

      const entry = await tx.balanceTransaction.create({
        data: {
          fromUserId: isPrint ? null : actor.id,
          toUserId: id,
          actorId: actor.id,
          type: BalanceTransactionType.DELEGATION,
          amount: dto.amount,
          reason: dto.reason,
        },
        select: { id: true },
      });
      await hooks?.after?.(tx, entry.id);
      return tx.user.findUniqueOrThrow({ where: { id }, select: publicUserSelect });
    });

    await this.audit.log({
      actorId: actor.id,
      action: "user.delegate_credit",
      targetId: id,
      ipAddress,
      metadata: { amount: dto.amount, reason: dto.reason },
    });
    await this.realtime.publishBalances([id, isPrint ? null : actor.id]);
    if (!isPrint) await this.alertLowBalance(actor.id, dto.amount);
    await this.notifications.create({
      userId: id,
      type: NotificationType.FUNDS_RECEIVED,
      title: "Credit received",
      message: `You received $${dto.amount.toFixed(2)} from ${actor.username}.`,
      deepLink: "/dashboard/finance",
      metadata: { amount: dto.amount, actorId: actor.id },
    });
    return updated;
  }

  /** Super-Admin-only correction with no counterparty; amount may be negative. */
  async adjustBalance(actor: Actor, id: string, dto: AdjustBalanceDto, ipAddress?: string) {
    if (actor.role !== Role.SUPER_ADMIN) throw new ForbiddenException("Only Super Admin may adjust a balance directly");
    const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!target) throw new NotFoundException("User not found");
    if (target.role === Role.SUPER_ADMIN) throw new BadRequestException("Super Admin accounts do not hold a balance");

    const updated = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE users
        SET balance = balance + ${dto.amount}::numeric
        WHERE id = ${id}
          -- Adding is always allowed, even when it leaves a balance that was
          -- below zero (after a corrected result) still below zero.
          AND (${dto.amount}::numeric >= 0 OR balance + ${dto.amount}::numeric >= 0)
          AND balance + ${dto.amount}::numeric <= balance_limit
        RETURNING id
      `;
      if (rows.length === 0) {
        throw new BadRequestException("This adjustment would take the balance out of bounds");
      }
      await tx.balanceTransaction.create({
        data: {
          fromUserId: null,
          toUserId: id,
          actorId: actor.id,
          type: BalanceTransactionType.ADJUSTMENT,
          amount: dto.amount,
          reason: dto.reason,
        },
      });
      return tx.user.findUniqueOrThrow({ where: { id }, select: publicUserSelect });
    });

    await this.audit.log({ actorId: actor.id, action: "user.balance_adjustment", targetId: id, ipAddress, metadata: { amount: dto.amount, reason: dto.reason } });
    await this.realtime.publishBalances([id]);
    if (dto.amount < 0) await this.alertLowBalance(id, -dto.amount);
    await this.notifications.create({
      userId: id,
      type: NotificationType.FUNDS_RECEIVED,
      title: "Balance adjusted",
      message: `An administrative adjustment of $${dto.amount.toFixed(2)} was applied to your balance.`,
      deepLink: "/dashboard/finance",
      metadata: { amount: dto.amount, actorId: actor.id },
    });
    return updated;
  }

  async setBalanceLimit(actor: Actor, id: string, limit: number, ipAddress?: string) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true, parentId: true } });
    if (!target) throw new NotFoundException("User not found");
    if (target.role === Role.SUPER_ADMIN) throw new BadRequestException("Super Admin accounts do not hold a balance");
    if (actor.role !== Role.SUPER_ADMIN && target.parentId !== actor.id) {
      throw new ForbiddenException("Only this account's direct parent or Super Admin can set its balance limit");
    }
    const updated = await this.prisma.user.update({ where: { id }, data: { balanceLimit: limit }, select: publicUserSelect });
    await this.audit.log({ actorId: actor.id, action: "user.balance_limit_update", targetId: id, ipAddress, metadata: { limit } });
    await this.realtime.publishBalances([id]);
    return updated;
  }

  async approveBalance(actor: Actor, transactionId: string, approve: boolean, ipAddress?: string) {
    const transaction = await this.prisma.balanceTransaction.findUnique({ where: { id: transactionId } });
    if (!transaction) throw new NotFoundException("Transaction not found");
    if (transaction.status !== BalanceTransactionStatus.PENDING) throw new BadRequestException("Transaction is no longer pending");
    if (!(await this.canApprove(actor, transaction))) {
      await this.audit.log({ actorId: actor.id, action: "authz.failure", targetId: transaction.toUserId, ipAddress, metadata: { reason: "cannot_approve", transactionId } });
      throw new ForbiddenException("Only someone above the person who started this transfer can approve it");
    }

    if (!approve) {
      // Guarded by status=PENDING so two concurrent approve/reject calls on the
      // same transaction can't both apply: only the first claims the row.
      const rejected = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.balanceTransaction.updateMany({
          where: { id: transactionId, status: BalanceTransactionStatus.PENDING },
          data: { status: BalanceTransactionStatus.REJECTED },
        });
        if (claimed.count === 0) throw new BadRequestException("Transaction is no longer pending");
        return tx.balanceTransaction.findUniqueOrThrow({ where: { id: transactionId }, select: { id: true, status: true } });
      });
      await this.audit.log({ actorId: actor.id, action: "user.balance_rejected", targetId: transaction.toUserId, ipAddress, metadata: { transactionId } });
      return rejected;
    }

    const amount = Number(transaction.amount);
    const result = await this.prisma.$transaction(async (tx) => {
      // Claim the pending transaction first: if a concurrent request already
      // approved/rejected it, this affects zero rows and we bail before ever
      // touching a balance.
      const claimed = await tx.balanceTransaction.updateMany({
        where: { id: transactionId, status: BalanceTransactionStatus.PENDING },
        data: { status: BalanceTransactionStatus.APPROVED, approvedById: actor.id, approvedAt: new Date() },
      });
      if (claimed.count === 0) throw new BadRequestException("Transaction is no longer pending");

      if (transaction.fromUserId) {
        const giverRows = await tx.$queryRaw<{ id: string }[]>`
          UPDATE users
          SET balance = balance - ${amount}::numeric
          WHERE id = ${transaction.fromUserId} AND balance - ${amount}::numeric >= 0
          RETURNING id
        `;
        if (giverRows.length === 0) {
          throw new BadRequestException("The delegating account no longer has enough balance for this transfer");
        }
      }

      const receiverRows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE users
        SET balance = balance + ${amount}::numeric
        WHERE id = ${transaction.toUserId} AND balance + ${amount}::numeric <= balance_limit
        RETURNING id
      `;
      if (receiverRows.length === 0) {
        throw new BadRequestException("Approved transaction would exceed the recipient's balance limit");
      }

      return tx.balanceTransaction.findUniqueOrThrow({ where: { id: transactionId }, select: { id: true, status: true, amount: true } });
    });
    await this.audit.log({ actorId: actor.id, action: "user.balance_approved", targetId: transaction.toUserId, ipAddress, metadata: { transactionId } });
    await this.realtime.publishBalances([transaction.toUserId, transaction.fromUserId]);
    if (transaction.fromUserId) await this.alertLowBalance(transaction.fromUserId, amount);
    await this.notifications.create({ userId: transaction.toUserId, type: NotificationType.FUNDS_RECEIVED, title: "Transaction approved", message: `A $${Number(transaction.amount).toFixed(2)} transaction was approved.`, deepLink: `/dashboard/finance/transaction/${transactionId}`, metadata: { transactionId } });
    return { ...result, amount: Number(result.amount) };
  }

  /**
   * Four-eyes rule for large delegations: the approver must be a different
   * person from whoever started the transfer, must not be on either side of
   * it (so nobody approves money into their own account), and must sit above
   * the initiator in the hierarchy (or be Super Admin).
   */
  private async canApprove(actor: Actor, transaction: { actorId: string | null; fromUserId: string | null; toUserId: string }): Promise<boolean> {
    if (!transaction.actorId || transaction.actorId === actor.id) return false;
    if (transaction.toUserId === actor.id || transaction.fromUserId === actor.id) return false;
    if (actor.role === Role.SUPER_ADMIN) return true;
    return this.hierarchy.isInSubtree(actor.id, transaction.actorId);
  }

  /** Pending delegations this actor is allowed to approve or reject. */
  async pendingApprovals(actor: Actor) {
    const scope = await this.scopeIds(actor);
    const pending = await this.prisma.balanceTransaction.findMany({
      where: {
        status: BalanceTransactionStatus.PENDING,
        actorId: scope ? { in: scope.filter((id) => id !== actor.id) } : { not: actor.id },
        toUserId: { not: actor.id },
        OR: [{ fromUserId: null }, { fromUserId: { not: actor.id } }],
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        type: true,
        amount: true,
        reason: true,
        status: true,
        createdAt: true,
        fromUser: { select: { id: true, username: true } },
        toUser: { select: { id: true, username: true, role: true } },
        actor: { select: { id: true, username: true, role: true } },
      },
    });
    return pending.map((entry) => ({ ...entry, amount: Number(entry.amount) }));
  }

  /**
   * Pull credit back from a direct child into the caller's own balance — the
   * reverse of delegateCredit (Owner←Manager, Owner←Player, Manager←Player).
   * Works on suspended accounts too, since winding one down is the main use.
   * Super Admin←Owner retires the credit, since Super Admin holds no balance.
   */
  async reclaimCredit(actor: Actor, id: string, dto: ReclaimCreditDto, ipAddress?: string, hooks?: LedgerHooks) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException("User not found");
    if (!canDelegateTo(actor, target)) {
      throw new ForbiddenException("You may only reclaim credit from a direct report");
    }
    const isRetire = actor.role === Role.SUPER_ADMIN;

    const updated = await this.prisma.$transaction(async (tx) => {
      await hooks?.before?.(tx);
      const childRows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE users
        SET balance = balance - ${dto.amount}::numeric
        WHERE id = ${id} AND balance - ${dto.amount}::numeric >= 0
        RETURNING id
      `;
      if (childRows.length === 0) {
        throw new BadRequestException("This account does not hold that much credit");
      }
      // No balance-limit check on the parent: the credit came from them in
      // the first place, and a limit should never trap funds in a child.
      if (!isRetire) {
        await tx.$executeRaw`UPDATE users SET balance = balance + ${dto.amount}::numeric WHERE id = ${actor.id}`;
      }
      const entry = await tx.balanceTransaction.create({
        data: {
          fromUserId: id,
          toUserId: actor.id,
          actorId: actor.id,
          type: BalanceTransactionType.RECLAIM,
          amount: dto.amount,
          reason: dto.reason,
        },
        select: { id: true },
      });
      await hooks?.after?.(tx, entry.id);
      return tx.user.findUniqueOrThrow({ where: { id }, select: publicUserSelect });
    });

    await this.audit.log({ actorId: actor.id, action: "user.reclaim_credit", targetId: id, ipAddress, metadata: { amount: dto.amount, reason: dto.reason } });
    await this.realtime.publishBalances([id, isRetire ? null : actor.id]);
    await this.alertLowBalance(id, dto.amount);
    await this.notifications.create({
      userId: id,
      type: NotificationType.FUNDS_RECLAIMED,
      title: "Credit reclaimed",
      message: `${actor.username} reclaimed $${dto.amount.toFixed(2)} from your balance.`,
      deepLink: "/dashboard",
      metadata: { amount: dto.amount, actorId: actor.id },
    });
    return updated;
  }

  async transactionDetails(actor: Actor, id: string) {
    const entry = await this.prisma.balanceTransaction.findUnique({
      where: { id },
      include: {
        toUser: { select: { id: true, username: true } },
        fromUser: { select: { id: true, username: true } },
        actor: { select: { id: true, username: true } },
        approvedBy: { select: { id: true, username: true } },
      },
    });
    if (!entry) throw new NotFoundException("Transaction not found");
    const allowed = (await this.hierarchy.canActOn(actor, entry.toUserId))
      || (entry.fromUserId ? await this.hierarchy.canActOn(actor, entry.fromUserId) : false);
    if (!allowed) throw new ForbiddenException("Transaction is outside your hierarchy subtree");
    return { ...entry, amount: Number(entry.amount) };
  }

  async balanceStatement(actor: Actor, id: string, from?: string, to?: string) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true, username: true, balance: true } });
    if (!target || target.role === Role.SUPER_ADMIN) throw new NotFoundException("User not found");
    if (!(await this.hierarchy.canActOn(actor, id))) throw new ForbiddenException("Target is outside your hierarchy subtree");
    const entries = await this.prisma.balanceTransaction.findMany({
      where: {
        OR: [{ toUserId: id }, { fromUserId: id }],
        status: BalanceTransactionStatus.APPROVED,
        ...dateRange(from, to),
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true, amount: true, reason: true, createdAt: true, toUserId: true, fromUser: { select: { username: true } }, toUser: { select: { username: true } } },
    });
    return {
      account: target,
      from: from ?? null,
      to: to ?? null,
      entries: entries.map(({ toUserId, fromUser, toUser, ...entry }) => {
        const incoming = toUserId === id;
        return {
          ...entry,
          // Signed from this account's point of view, like the ledger.
          amount: incoming ? Number(entry.amount) : -Number(entry.amount),
          actor: { username: incoming ? fromUser?.username ?? noCounterparty(entry.type) : toUser.username },
        };
      }),
    };
  }

  /**
   * Delegation totals: how much this user has given to, and reclaimed from,
   * each of their direct children in the period. Net revenue / commission
   * reporting is deferred until settled bets exist to compute it from.
   */
  async financialReport(actor: Actor, from?: string, to?: string) {
    if (actor.role === Role.PLAYER) throw new ForbiddenException("Financial reports are restricted");
    const entries = await this.prisma.balanceTransaction.findMany({
      where: {
        actorId: actor.id,
        type: { in: [BalanceTransactionType.DELEGATION, BalanceTransactionType.RECLAIM] },
        status: BalanceTransactionStatus.APPROVED,
        ...dateRange(from, to),
      },
      select: {
        type: true,
        amount: true,
        toUserId: true,
        fromUserId: true,
        toUser: { select: { username: true, role: true } },
        fromUser: { select: { username: true, role: true } },
      },
    });
    type Row = { userId: string; username: string; role: Role; totalDelegated: number; totalReclaimed: number; net: number };
    const byRecipient = new Map<string, Row>();
    for (const entry of entries) {
      const isReclaim = entry.type === BalanceTransactionType.RECLAIM;
      const childId = isReclaim ? entry.fromUserId : entry.toUserId;
      const child = isReclaim ? entry.fromUser : entry.toUser;
      if (!childId || !child) continue;
      const row = byRecipient.get(childId) ?? { userId: childId, username: child.username, role: child.role, totalDelegated: 0, totalReclaimed: 0, net: 0 };
      if (isReclaim) row.totalReclaimed += Number(entry.amount);
      else row.totalDelegated += Number(entry.amount);
      row.net = row.totalDelegated - row.totalReclaimed;
      byRecipient.set(childId, row);
    }
    return { from: from ?? null, to: to ?? null, recipients: [...byRecipient.values()] };
  }

  async suspend(actor: Actor, id: string, ipAddress?: string) {
    if (actor.id === id) {
      throw new BadRequestException("Cannot suspend yourself");
    }
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException("User not found");

    const allowed = await this.hierarchy.canActOn(actor, id);
    if (!allowed) {
      await this.audit.log({
        actorId: actor.id,
        action: "authz.failure",
        targetId: id,
        ipAddress,
        metadata: { reason: "outside_subtree", action: "suspend" },
      });
      throw new ForbiddenException("Target is outside your hierarchy subtree");
    }

    if (actor.role === Role.MANAGER && target.role !== Role.PLAYER) {
      throw new ForbiddenException("Managers may only suspend Players");
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.SUSPENDED },
      select: publicUserSelect,
    });

    await this.audit.log({
      actorId: actor.id,
      action: "user.suspend",
      targetId: id,
      ipAddress,
    });
    await this.notifications.create({
      userId: id,
      type: NotificationType.ACCOUNT_SUSPENDED,
      title: "Account suspended",
      message: "Your account was suspended by an administrator.",
      deepLink: `/dashboard/users?userId=${id}`,
      metadata: { actorId: actor.id },
    });

    return updated;
  }

  async unsuspend(actor: Actor, id: string, ipAddress?: string) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException("User not found");

    if (!(await this.hierarchy.canActOn(actor, id))) {
      await this.audit.log({
        actorId: actor.id,
        action: "authz.failure",
        targetId: id,
        ipAddress,
        metadata: { reason: "outside_subtree", action: "unsuspend" },
      });
      throw new ForbiddenException("Target is outside your hierarchy subtree");
    }
    if (actor.role === Role.MANAGER && target.role !== Role.PLAYER) {
      throw new ForbiddenException("Managers may only unsuspend Players");
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.ACTIVE },
      select: publicUserSelect,
    });
    await this.audit.log({ actorId: actor.id, action: "user.unsuspend", targetId: id, ipAddress });
    await this.notifications.create({
      userId: id,
      type: NotificationType.ACCOUNT_UPDATED,
      title: "Account reactivated",
      message: "Your account was reactivated by an administrator.",
      deepLink: `/dashboard/users?userId=${id}`,
      metadata: { actorId: actor.id },
    });
    return updated;
  }

  /**
   * Moves a Player to another Manager or Owner. Their balance was given to
   * them by the one they leave, so it goes back there (a reclaim in both
   * ledgers) and the new one tops them up; otherwise the new team could take
   * back credit the old team paid for. A Player with bets still open, or
   * below zero, waits: those winnings and that debt belong to the old team.
   */
  async reassignPlayer(actor: Actor, id: string, managerId: string, ipAddress?: string) {
    const player = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, role: true, parentId: true },
    });
    if (!player) throw new NotFoundException("User not found");
    if (player.role !== Role.PLAYER) {
      throw new BadRequestException("Only Players can be reassigned");
    }
    if (player.parentId === managerId) {
      throw new BadRequestException("Player is already assigned to this Manager");
    }
    const manager = await this.prisma.user.findUnique({
      where: { id: managerId },
      select: { id: true, username: true, role: true, status: true, managerCapacity: true },
    });
    if (!manager) throw new NotFoundException("Manager not found");
    if (!holdsDirectReports(manager.role)) {
      throw new BadRequestException("Players can only be assigned to a Manager or an Owner");
    }
    if (manager.status !== UserStatus.ACTIVE) {
      throw new BadRequestException("Players cannot be assigned to a suspended account");
    }
    const playerDescendants = await this.hierarchy.getDescendantIds(id);
    if (playerDescendants.includes(managerId)) {
      throw new BadRequestException("Cannot assign a player to a manager in its own hierarchy");
    }
    if (!(await this.hierarchy.canActOn(actor, id)) || !(await this.hierarchy.canActOn(actor, managerId))) {
      await this.audit.log({
        actorId: actor.id,
        action: "authz.failure",
        targetId: id,
        ipAddress,
        metadata: { reason: "reassignment_outside_subtree", managerId },
      });
      throw new ForbiddenException("Player or Manager is outside your hierarchy subtree");
    }
    const assignedCount = await this.prisma.user.count({ where: { parentId: managerId, role: Role.PLAYER } });
    if (assignedCount >= manager.managerCapacity) {
      throw new BadRequestException("Destination has reached its player capacity");
    }

    const previousManager = player.parentId
      ? await this.prisma.user.findUnique({ where: { id: player.parentId }, select: { id: true, username: true } })
      : null;
    const { updated, returned } = await this.prisma.$transaction(async (tx) => {
      // Locks the Player, so no bet or transfer changes the balance while it moves.
      const [row] = await tx.$queryRaw<Array<{ balance: Prisma.Decimal; parent_id: string | null }>>`
        SELECT balance, parent_id FROM users WHERE id = ${id} FOR UPDATE
      `;
      if (!row || row.parent_id !== player.parentId) {
        throw new ConflictException("This Player changed while you were moving them. Refresh and try again.");
      }
      const blocked = moveBlocker(player.username, row.balance, await tx.bet.count({ where: { playerId: id, status: BetStatus.OPEN } }));
      if (blocked) throw new BadRequestException(blocked);

      const balance = new Prisma.Decimal(row.balance);
      if (balance.isPositive() && previousManager) {
        await tx.user.update({ where: { id }, data: { balance: 0 } });
        await tx.user.update({ where: { id: previousManager.id }, data: { balance: { increment: balance } } });
        await tx.balanceTransaction.create({
          data: {
            fromUserId: id,
            toUserId: previousManager.id,
            actorId: actor.id,
            type: BalanceTransactionType.RECLAIM,
            amount: balance,
            reason: `Returned when moved to ${manager.username}`,
          },
        });
      }
      // Transfers to or from the Player still waiting for approval were asked for by the team they're leaving.
      await tx.balanceTransaction.updateMany({
        where: { status: BalanceTransactionStatus.PENDING, OR: [{ toUserId: id }, { fromUserId: id }] },
        data: { status: BalanceTransactionStatus.REJECTED },
      });
      const moved = await tx.user.update({ where: { id }, data: { parentId: managerId }, select: publicUserSelect });
      return { updated: moved, returned: balance.isPositive() && previousManager ? Number(balance) : 0 };
    });
    await this.audit.log({
      actorId: actor.id,
      action: "user.reassign",
      targetId: id,
      ipAddress,
      metadata: { fromManagerId: previousManager?.id ?? null, toManagerId: manager.id, returnedBalance: returned },
    });
    if (returned > 0) await this.realtime.publishBalances([id, previousManager?.id ?? null]);
    const back = returned > 0 && previousManager ? ` Your $${returned.toFixed(2)} balance went back to ${previousManager.username}.` : "";
    await this.notifications.create({
      userId: id,
      type: NotificationType.ACCOUNT_REASSIGNED,
      title: "Account reassigned",
      message: `Your account was reassigned to manager ${manager.username}.${back}`,
      deepLink: `/dashboard/users?userId=${manager.id}`,
      metadata: { managerId: manager.id },
    });
    if (previousManager) {
      await this.notifications.create({
        userId: previousManager.id,
        type: NotificationType.ACCOUNT_REASSIGNED,
        title: "Player reassigned",
        message: returned > 0 ? `${player.username} was moved to another manager. Their $${returned.toFixed(2)} balance came back to you.` : `${player.username} was moved to another manager.`,
        deepLink: `/dashboard/users?userId=${id}`,
        metadata: { userId: id, managerId: manager.id, returnedBalance: returned },
      });
    }
    await this.notifications.create({
      userId: manager.id,
      type: NotificationType.ACCOUNT_REASSIGNED,
      title: "Player assigned",
      message: `${player.username} was assigned to your team. Their balance starts at $0.00.`,
      deepLink: `/dashboard/users?userId=${id}`,
      metadata: { userId: id },
    });
    return updated;
  }

  async updateUser(actor: Actor, id: string, dto: UpdateUserDto, ipAddress?: string) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException("User not found");
    if (!(await this.hierarchy.canActOn(actor, id))) {
      throw new ForbiddenException("Target is outside your hierarchy subtree");
    }
    if (actor.role === Role.MANAGER && target.role !== Role.PLAYER) {
      throw new ForbiddenException("Managers may only edit Players");
    }
    if (!dto.username && !dto.password) {
      throw new BadRequestException("Provide a username or password to update");
    }

    const username = dto.username?.toLowerCase();
    if (username && username !== target.username) {
      const duplicate = await this.prisma.user.findUnique({ where: { username } });
      if (duplicate) throw new ConflictException("Username already registered");
    }

    try {
      await this.clerk.updateUser(target.clerkId, {
        ...(username ? { username } : {}),
        ...(dto.password ? { password: dto.password } : {}),
      });
    } catch (error) {
      throw new BadRequestException(clerkRefusal(error, "update"));
    }

    const email = username ? privateEmailFor(username) : undefined;
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(username
          ? {
              username,
              emailCipher: this.crypto.encrypt(email!),
              emailHash: this.crypto.blindIndex(email!),
            }
          : {}),
      },
      select: publicUserSelect,
    });
    await this.audit.log({
      actorId: actor.id,
      action: "user.update",
      targetId: id,
      ipAddress,
      metadata: { usernameChanged: Boolean(username), passwordChanged: Boolean(dto.password) },
    });
    await this.notifications.create({
      userId: id,
      type: NotificationType.ACCOUNT_UPDATED,
      title: "Account updated",
      message: "An administrator updated your account details.",
      metadata: { actorId: actor.id, usernameChanged: Boolean(username), passwordChanged: Boolean(dto.password) },
    });
    return updated;
  }

  /**
   * Deletes an account for good, for one made by mistake. An account that has
   * placed a bet, moved money or been paid a commission can't be deleted:
   * its bets and ledger entries are part of other people's history too (the
   * Owner's statement, the team's past profit and commission), so it's
   * suspended instead. The database enforces the same rule.
   */
  async deleteUser(actor: Actor, id: string, ipAddress?: string) {
    if (actor.id === id) throw new BadRequestException("Cannot delete yourself");
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException("User not found");
    if (!(await this.hierarchy.canActOn(actor, id))) {
      throw new ForbiddenException("Target is outside your hierarchy subtree");
    }
    if (actor.role === Role.MANAGER && target.role !== Role.PLAYER) {
      throw new ForbiddenException("Managers may only delete Players");
    }
    const childCount = await this.prisma.user.count({ where: { parentId: id } });
    if (childCount > 0) {
      throw new ConflictException(`Manager must be reassigned before deletion; ${childCount} direct child account(s) still depend on this Manager`);
    }
    if (await this.hasMoneyHistory(id)) throw new ConflictException(HAS_HISTORY);
    if (!target.balance.isZero()) {
      throw new ConflictException("Account still holds a balance; reclaim it before deleting");
    }

    try {
      // The database row goes first, inside the transaction, and the sign-in
      // last: if Clerk fails the row comes back, so nobody is left able to
      // sign in to an account that no longer exists, or the other way round.
      await this.prisma.$transaction(async (tx) => {
        await tx.auditLog.updateMany({ where: { actorId: id }, data: { actorId: null } });
        await tx.auditLog.updateMany({ where: { targetId: id }, data: { targetId: null } });
        await tx.user.delete({ where: { id } });
        await this.clerk.deleteUserStrict(target.clerkId).catch((error: unknown) => {
          // Already gone from Clerk (deleted there by hand): nothing left to do.
          if ((error as { status?: number }).status !== 404) throw error;
        });
      }, { timeout: 15_000 });
    } catch (error) {
      // Something was added between the check and the delete (a bet, a transfer).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") throw new ConflictException(HAS_HISTORY);
      throw new ConflictException(
        `Failed to delete user: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The row is gone, so the target can't be referenced by foreign key any
    // more; keep who it was in metadata instead.
    await this.audit.log({ actorId: actor.id, action: "user.delete", ipAddress, metadata: { deletedUserId: id, username: target.username, role: target.role } });
    return { id };
  }

  /**
   * Whether an account has any bet or casino spin (its own, or one its team
   * took), ledger entry (on either side, as initiator or approver) or
   * commission payout.
   */
  private async hasMoneyHistory(id: string): Promise<boolean> {
    const [bet, spin, entry, payout] = await Promise.all([
      this.prisma.bet.findFirst({ where: { OR: [{ playerId: id }, { ownerId: id }, { managerId: id }] }, select: { id: true } }),
      this.prisma.casinoSpin.findFirst({ where: { OR: [{ playerId: id }, { ownerId: id }, { managerId: id }] }, select: { id: true } }),
      this.prisma.balanceTransaction.findFirst({
        where: { OR: [{ toUserId: id }, { fromUserId: id }, { actorId: id }, { approvedById: id }] },
        select: { id: true },
      }),
      this.prisma.commissionPayout.findFirst({ where: { userId: id }, select: { id: true } }),
    ]);
    return Boolean(bet || spin || entry || payout);
  }

  async reassignmentPreview(actor: Actor, id: string, managerId: string) {
    const player = await this.prisma.user.findUnique({ where: { id }, select: { id: true, username: true, role: true, parentId: true, balance: true, parent: { select: { username: true } } } });
    const manager = await this.prisma.user.findUnique({ where: { id: managerId }, select: { id: true, username: true, role: true, status: true, managerCapacity: true } });
    if (!player || !manager) throw new NotFoundException("Player or Manager not found");
    const directChildren = await this.prisma.user.findMany({ where: { parentId: managerId, role: Role.PLAYER }, select: { id: true, username: true } });
    const playerDescendants = await this.hierarchy.getDescendantIds(id);
    const authorized = await this.hierarchy.canActOn(actor, id) && await this.hierarchy.canActOn(actor, managerId);
    const blocked = moveBlocker(player.username, player.balance, await this.prisma.bet.count({ where: { playerId: id, status: BetStatus.OPEN } }));
    const reason = !authorized ? "Outside your hierarchy" : player.role !== Role.PLAYER ? "Only Players can be reassigned" : !holdsDirectReports(manager.role) ? "Destination is not a Manager or Owner" : manager.status !== UserStatus.ACTIVE ? "Destination is suspended" : player.parentId === managerId ? "Player is already assigned here" : playerDescendants.includes(managerId) ? "Circular hierarchy detected" : directChildren.length >= manager.managerCapacity ? "Destination capacity reached" : blocked;
    return {
      valid: reason === null,
      reason,
      player: { id: player.id, username: player.username, currentManagerId: player.parentId },
      destination: { id: manager.id, username: manager.username, capacity: manager.managerCapacity, assigned: directChildren.length, remaining: Math.max(0, manager.managerCapacity - directChildren.length) },
      impact: {
        movedAccounts: 1,
        currentManagerId: player.parentId,
        /** What goes back to the Manager or Owner they leave, and who that is. */
        returnedBalance: authorized && player.balance.isPositive() && player.parent ? Number(player.balance) : 0,
        returnedTo: player.parent?.username ?? null,
      },
    };
  }

  async setManagerCapacity(actor: Actor, id: string, capacity: number, ipAddress?: string) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true, parentId: true } });
    if (!target || !holdsDirectReports(target.role)) {
      throw new BadRequestException("Only Owners and Managers hold direct Players");
    }
    if (actor.role !== Role.SUPER_ADMIN && target.parentId !== actor.id) {
      throw new ForbiddenException("Only this account's direct parent or Super Admin can set its capacity");
    }
    const assigned = await this.prisma.user.count({ where: { parentId: id, role: Role.PLAYER } });
    if (capacity < assigned) throw new BadRequestException(`Capacity cannot be below current player count (${assigned})`);
    const updated = await this.prisma.user.update({ where: { id }, data: { managerCapacity: capacity }, select: publicUserSelect });
    await this.audit.log({ actorId: actor.id, action: "user.manager_capacity_update", targetId: id, ipAddress, metadata: { capacity } });
    return updated;
  }

  /**
   * An Owner lets a trusted Manager delegate larger amounts without waiting
   * for approval (or tightens it). Only the Manager's own Owner or Super Admin.
   */
  async setApprovalLimit(actor: Actor, id: string, limit: number | null, ipAddress?: string) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true, parentId: true } });
    if (!target) throw new NotFoundException("User not found");
    if (target.role !== Role.MANAGER) throw new BadRequestException("Only Managers have a personal approval limit");
    if (actor.role !== Role.SUPER_ADMIN && target.parentId !== actor.id) {
      throw new ForbiddenException("Only this Manager's Owner or Super Admin can set their approval limit");
    }
    const updated = await this.prisma.user.update({ where: { id }, data: { approvalLimit: limit }, select: publicUserSelect });
    await this.audit.log({ actorId: actor.id, action: "user.approval_limit_update", targetId: id, ipAddress, metadata: { limit } });
    const effective = limit ?? APPROVAL_THRESHOLD;
    await this.notifications.create({
      userId: id,
      type: NotificationType.ACCOUNT_UPDATED,
      title: "Approval limit updated",
      message: `Transfers up to $${effective.toFixed(2)} now go through without approval.`,
      deepLink: "/dashboard/users",
      metadata: { actorId: actor.id, limit },
    });
    return updated;
  }

  /**
   * After an account's balance went down by `taken`: if that pushed it below
   * its Owner's low-balance alert, tell whoever can top it up (its direct
   * parent) and the Owner. Only fires on the drop across the line, not on
   * every later movement below it.
   */
  async alertLowBalance(userId: string, taken: number) {
    const account = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, role: true, balance: true, parentId: true } });
    if (!account || (account.role !== Role.MANAGER && account.role !== Role.PLAYER)) return;

    const owner = await this.ownerAbove(account.parentId);
    if (!owner || owner.lowBalanceThreshold === null) return;

    const threshold = Number(owner.lowBalanceThreshold);
    const balance = Number(account.balance);
    if (!(balance < threshold && balance + taken >= threshold)) return;

    const recipients = new Set([account.parentId, owner.id].filter((id): id is string => Boolean(id)));
    for (const recipient of recipients) {
      await this.notifications.create({
        userId: recipient,
        type: NotificationType.LOW_BALANCE,
        title: "Low balance",
        message: `${account.username}'s balance dropped to $${balance.toFixed(2)}, below the $${threshold.toFixed(2)} alert.`,
        deepLink: "/dashboard/users",
        metadata: { accountId: account.id, balance, threshold },
      });
    }
  }

  /**
   * After a corrected result took winnings back: if that left the Player's
   * balance below zero, tell whoever looks after them and their Owner. The
   * debt stays on the balance, so the next top-up pays it off first, and the
   * Player can't bet until it's back above zero.
   */
  async alertNegativeBalance(userId: string) {
    const account = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, balance: true, parentId: true } });
    if (!account || !account.balance.isNegative()) return;
    const owner = await this.ownerAbove(account.parentId);
    const balance = `-$${account.balance.abs().toFixed(2)}`;
    const recipients = new Set([account.parentId, owner?.id].filter((id): id is string => Boolean(id)));
    for (const recipient of recipients) {
      await this.notifications.create({
        userId: recipient,
        type: NotificationType.LOW_BALANCE,
        severity: NotificationSeverity.WARNING,
        title: "Balance below zero",
        message: `${account.username}'s balance is ${balance} after a result was corrected. Their next top-up pays it off first.`,
        deepLink: `/dashboard/players/${account.id}`,
        metadata: { accountId: account.id, balance: Number(account.balance) },
      });
    }
  }

  /** The Owner at the top of an account's team, starting from its parent. */
  private async ownerAbove(parentId: string | null) {
    let cursor = parentId;
    for (let depth = 0; cursor && depth < 5; depth++) {
      const next: { id: string; role: Role; parentId: string | null; lowBalanceThreshold: Prisma.Decimal | null } | null = await this.prisma.user.findUnique({ where: { id: cursor }, select: { id: true, role: true, parentId: true, lowBalanceThreshold: true } });
      if (next?.role === Role.OWNER) return next;
      cursor = next?.parentId ?? null;
    }
    return null;
  }

  /**
   * A Player asks whoever looks after them (their Manager, or their Owner)
   * for more money. At most once every 30 minutes, so it can't be spammed.
   */
  async requestTopUp(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players can ask for a top-up");
    if (!actor.parentId) throw new BadRequestException("You don't have a Manager or Owner yet");
    const since = new Date(Date.now() - TOP_UP_REQUEST_GAP_MS);
    const recent = await this.prisma.auditLog.findFirst({ where: { actorId: actor.id, action: "balance.topup_request", createdAt: { gte: since } }, select: { createdAt: true } });
    if (recent) {
      const minutes = Math.max(1, Math.ceil((recent.createdAt.getTime() + TOP_UP_REQUEST_GAP_MS - Date.now()) / 60_000));
      throw new BadRequestException(`You already asked. You can ask again in ${minutes} min.`);
    }
    const balance = Number(actor.balance);
    await this.notifications.create({
      userId: actor.parentId,
      type: NotificationType.LOW_BALANCE,
      severity: NotificationSeverity.WARNING,
      title: "Top-up requested",
      message: `${actor.username} is asking for a top-up. Their balance is $${balance.toFixed(2)}.`,
      deepLink: `/dashboard/players/${actor.id}`,
      metadata: { accountId: actor.id, balance },
    });
    await this.audit.log({ actorId: actor.id, action: "balance.topup_request", targetId: actor.parentId, metadata: { balance } });
    return { ok: true };
  }

  /** An Owner's team-wide settings. */
  async teamSettings(actor: Actor) {
    if (actor.role !== Role.OWNER) throw new ForbiddenException("Only Owners have team settings");
    return {
      lowBalanceThreshold: actor.lowBalanceThreshold === null ? null : Number(actor.lowBalanceThreshold),
      managerApprovalLimit: actor.managerApprovalLimit === null ? null : Number(actor.managerApprovalLimit),
      defaultApprovalLimit: APPROVAL_THRESHOLD,
    };
  }

  async updateTeamSettings(actor: Actor, input: { lowBalanceThreshold?: number | null; managerApprovalLimit?: number | null }, ipAddress?: string) {
    if (actor.role !== Role.OWNER) throw new ForbiddenException("Only Owners have team settings");
    const data: Prisma.UserUpdateInput = {};
    if (input.lowBalanceThreshold !== undefined) data.lowBalanceThreshold = input.lowBalanceThreshold;
    if (input.managerApprovalLimit !== undefined) data.managerApprovalLimit = input.managerApprovalLimit;
    const updated = await this.prisma.user.update({ where: { id: actor.id }, data });
    await this.audit.log({ actorId: actor.id, action: "user.team_settings_update", targetId: actor.id, ipAddress, metadata: input });
    return this.teamSettings(updated);
  }

  /**
   * Apply one action to many accounts. Each account goes through the same
   * checks as doing it one at a time, and one failure doesn't stop the rest:
   * the result says what happened to each.
   */
  async bulk(actor: Actor, input: { action: "suspend" | "unsuspend" | "delegate" | "reassign"; ids: string[]; amount?: number; parentId?: string }, ipAddress?: string) {
    const ids = [...new Set(input.ids)];
    if (ids.length === 0) throw new BadRequestException("Choose at least one account");
    if (ids.length > BULK_LIMIT) throw new BadRequestException(`Choose at most ${BULK_LIMIT} accounts at a time`);
    if (input.action === "delegate" && !input.amount) throw new BadRequestException("Enter an amount");
    if (input.action === "reassign" && !input.parentId) throw new BadRequestException("Choose where to move them");
    if (input.action === "reassign" && actor.role !== Role.SUPER_ADMIN && actor.role !== Role.OWNER) {
      throw new ForbiddenException("Only Owners and Super Admins can reassign Players");
    }

    const results: Array<{ id: string; ok: boolean; error?: string; pending?: boolean }> = [];
    for (const id of ids) {
      try {
        if (input.action === "suspend") await this.suspend(actor, id, ipAddress);
        else if (input.action === "unsuspend") await this.unsuspend(actor, id, ipAddress);
        else if (input.action === "reassign") await this.reassignPlayer(actor, id, input.parentId!, ipAddress);
        else {
          // Re-read the actor each time: every transfer lowers their balance.
          const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
          const result = await this.delegateCredit(fresh, id, { amount: input.amount!, reason: "Bulk top-up" }, ipAddress);
          if ("requiresApproval" in result && result.requiresApproval) {
            results.push({ id, ok: true, pending: true });
            continue;
          }
        }
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : "Failed" });
      }
    }
    await this.audit.log({ actorId: actor.id, action: `user.bulk_${input.action}`, ipAddress, metadata: { count: ids.length, succeeded: results.filter((r) => r.ok).length } });
    return { results };
  }

  async bootstrapSuperAdmin(input: {
    clerkId: string;
    username: string;
    bootstrapSecret: string;
    expectedSecret: string;
    ipAddress?: string;
  }) {
    if (!input.expectedSecret || input.bootstrapSecret !== input.expectedSecret) {
      await this.audit.log({
        action: "authz.failure",
        ipAddress: input.ipAddress,
        metadata: { reason: "bootstrap_secret_invalid" },
      });
      throw new ForbiddenException("Invalid bootstrap secret");
    }

    const existingAdmin = await this.prisma.user.findFirst({
      where: { role: Role.SUPER_ADMIN },
    });
    if (existingAdmin) {
      throw new ConflictException("Super Admin already exists");
    }

    const username = input.username.toLowerCase();
    const privateEmail = privateEmailFor(username);
    const user = await this.prisma.user.create({
      data: {
        clerkId: input.clerkId,
        username,
        emailCipher: this.crypto.encrypt(privateEmail),
        emailHash: this.crypto.blindIndex(privateEmail),
        role: Role.SUPER_ADMIN,
        parentId: null,
        status: UserStatus.ACTIVE,
      },
      select: {
        id: true,
        username: true,
        role: true,
        clerkId: true,
        createdAt: true,
      },
    });

    await this.audit.log({
      actorId: user.id,
      action: "user.bootstrap_super_admin",
      targetId: user.id,
      ipAddress: input.ipAddress,
    });

    return user;
  }
}

/** Why a Player can't be moved yet, or null if they can. */
/**
 * Clerk's own error only says "Unprocessable Entity"; the reason is in its
 * error codes. The common ones get a plain sentence, the rest Clerk's text.
 */
function clerkRefusal(error: unknown, action: "create" | "update"): string {
  const first = (error as { errors?: { code?: string; longMessage?: string; message?: string }[] })?.errors?.[0];
  switch (first?.code) {
    case "form_identifier_exists":
    case "form_username_exists":
      return "That username is already taken in Clerk. Pick another one.";
    case "form_password_pwned":
      return "That password has appeared in a data leak. Pick a different one.";
    case "form_password_length_too_short":
    case "form_password_not_strong_enough":
    case "form_password_size_in_bytes_exceeded":
      return "That password is too weak. Use at least 8 characters with letters and numbers.";
  }
  const reason = first?.longMessage ?? first?.message ?? (error instanceof Error ? error.message : String(error));
  return action === "create" ? `Failed to create Clerk identity: ${reason}` : `Failed to update Clerk identity: ${reason}`;
}

function moveBlocker(username: string, balance: Prisma.Decimal, openBets: number): string | null {
  if (openBets === 1) return `${username} still has 1 open bet. Move them once it's settled.`;
  if (openBets > 1) return `${username} still has ${openBets} open bets. Move them once they're settled.`;
  if (balance.isNegative()) return `${username}'s balance is below zero (-$${balance.abs().toFixed(2)}). Give them credit to clear it before moving them.`;
  return null;
}

/** Who a ledger entry with no other account came from: a bet, the Casino, or a Super Admin adjustment. */
function noCounterparty(type: BalanceTransactionType): string {
  if (type === BalanceTransactionType.CASINO) return "Casino";
  return type === BalanceTransactionType.BET_STAKE || type === BalanceTransactionType.BET_SETTLEMENT ? "Betting" : "Platform";
}
