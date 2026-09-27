import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { BalanceTransactionStatus, BalanceTransactionType, NotificationType, Role, UserStatus } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { ClerkService } from "../auth/clerk.service";
import { Actor, canCreateRole, canDelegateTo, roleRequiresMfa } from "../auth/permissions";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../prisma.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { AdjustBalanceDto, DelegateCreditDto } from "./dto/balance-transaction.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { HierarchyService } from "./hierarchy.service";
import { NotificationsService } from "../notifications/notifications.service";
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
  createdAt: true,
} as const;

function privateEmailFor(username: string): string {
  return `${username.toLowerCase()}@users.bast.internal`;
}

/** Roles that hold direct Players/Managers and so need a delegation capacity. */
function holdsDirectReports(role: Role): boolean {
  return role === Role.OWNER || role === Role.MANAGER;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
    private readonly hierarchy: HierarchyService,
    private readonly audit: AuditService,
    private readonly crypto: FieldEncryptionService,
    private readonly notifications: NotificationsService,
  ) {}

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
    return {
      id: actor.id,
      username: actor.username,
      role: actor.role,
      parentId: actor.parentId,
      status: actor.status,
      balance: Number(actor.balance),
      commissionRate: Number(actor.commissionRate),
      mfaRequired,
      mfaEnabled,
      mfaSatisfied: !mfaRequired || mfaEnabled,
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

    return {
      sessions: sessions.data.map((session) => ({
        id: session.id,
        status: session.status,
        lastActiveAt: session.lastActiveAt,
        expireAt: session.expireAt,
        abandonAt: session.abandonAt,
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

  async report(actor: Actor) {
    if (actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException("Reports are restricted to Super Admins");
    }

    const [users, recentAudit] = await Promise.all([
      this.prisma.user.findMany({
        orderBy: { createdAt: "asc" },
        select: publicUserSelect,
      }),
      this.prisma.auditLog.findMany({
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
    const owners = users.filter((user) => user.role === Role.OWNER);

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        users: users.length,
        owners: roleBreakdown.OWNER,
        managers: roleBreakdown.MANAGER,
        players: roleBreakdown.PLAYER,
        active: statusBreakdown.ACTIVE,
        suspended: statusBreakdown.SUSPENDED,
        totalBalance: users.reduce((total, user) => total + Number(user.balance), 0),
      },
      roleBreakdown,
      statusBreakdown,
      owners: owners.map((owner) => ({
        id: owner.id,
        username: owner.username,
        status: owner.status,
        balance: Number(owner.balance),
        commissionRate: Number(owner.commissionRate),
        directReports: users.filter((user) => user.parentId === owner.id).length,
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
    return updated;
  }

  /** Only the target's own direct parent (whoever set them up in the hierarchy) may manage their rate. */
  private async canManageCommissionRate(actor: Actor, target: { role: Role; parentId: string | null }): Promise<boolean> {
    if (actor.role === Role.SUPER_ADMIN) return true;
    return target.parentId === actor.id;
  }

  async auditLog(actor: Actor, query: AuditQueryDto) {
    if (actor.role !== Role.SUPER_ADMIN) throw new ForbiddenException("Audit logs are restricted to Super Admins");
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
    const where = {
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
      throw new BadRequestException(
        `Failed to create Clerk identity: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  async balanceLedger(actor: Actor, id: string) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!target) throw new NotFoundException("User not found");
    if (target.role === Role.SUPER_ADMIN) throw new BadRequestException("Super Admin accounts do not hold a balance");
    if (!(await this.hierarchy.canActOn(actor, id))) {
      throw new ForbiddenException("Target is outside your hierarchy subtree");
    }
    const entries = await this.prisma.balanceTransaction.findMany({
      where: { OR: [{ toUserId: id }, { fromUserId: id }] },
      orderBy: { createdAt: "desc" },
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
      counterparty: entry.toUserId === id ? entry.fromUser?.username ?? "Platform" : entry.toUser.username,
    }));
  }

  /** Give credit to a direct child: Owner→Manager, Owner→Player, or Manager→Player. Super Admin→Owner prints (no source deduction). */
  async delegateCredit(actor: Actor, id: string, dto: DelegateCreditDto, ipAddress?: string) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException("User not found");
    if (!canDelegateTo(actor, target)) {
      throw new ForbiddenException("You may only delegate credit to a direct report");
    }
    if (target.status !== UserStatus.ACTIVE) {
      throw new BadRequestException("Cannot delegate credit to a suspended account");
    }

    const isPrint = actor.role === Role.SUPER_ADMIN;
    const requiresApproval = dto.amount > 10000;

    if (requiresApproval) {
      const pending = await this.prisma.balanceTransaction.create({
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
      await this.audit.log({ actorId: actor.id, action: "user.delegation_pending", targetId: id, ipAddress, metadata: { transactionId: pending.id, amount: dto.amount } });
      return { ...pending, amount: Number(pending.amount), requiresApproval: true };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
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

      await tx.balanceTransaction.create({
        data: {
          fromUserId: isPrint ? null : actor.id,
          toUserId: id,
          actorId: actor.id,
          type: BalanceTransactionType.DELEGATION,
          amount: dto.amount,
          reason: dto.reason,
        },
      });
      return tx.user.findUniqueOrThrow({ where: { id }, select: publicUserSelect });
    });

    await this.audit.log({
      actorId: actor.id,
      action: "user.delegate_credit",
      targetId: id,
      ipAddress,
      metadata: { amount: dto.amount, reason: dto.reason },
    });
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
          AND balance + ${dto.amount}::numeric >= 0
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
    return updated;
  }

  async approveBalance(actor: Actor, transactionId: string, approve: boolean, ipAddress?: string) {
    const transaction = await this.prisma.balanceTransaction.findUnique({ where: { id: transactionId } });
    if (!transaction) throw new NotFoundException("Transaction not found");
    if (transaction.status !== BalanceTransactionStatus.PENDING) throw new BadRequestException("Transaction is no longer pending");
    if (transaction.actorId === actor.id) throw new ForbiddenException("A second authorized person must approve this transaction");
    if (!(await this.hierarchy.canActOn(actor, transaction.toUserId))) throw new ForbiddenException("Transaction is outside your hierarchy subtree");

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
    await this.notifications.create({ userId: transaction.toUserId, type: NotificationType.FUNDS_RECEIVED, title: "Transaction approved", message: `A $${Number(transaction.amount).toFixed(2)} transaction was approved.`, deepLink: `/dashboard/finance/transaction/${transactionId}`, metadata: { transactionId } });
    return { ...result, amount: Number(result.amount) };
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
        toUserId: id,
        status: BalanceTransactionStatus.APPROVED,
        ...(from || to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true, amount: true, reason: true, createdAt: true, fromUser: { select: { username: true } } },
    });
    return {
      account: target,
      from: from ?? null,
      to: to ?? null,
      entries: entries.map((entry) => ({ ...entry, amount: Number(entry.amount), actor: entry.fromUser ? { username: entry.fromUser.username } : { username: "Platform" } })),
    };
  }

  /**
   * Delegation totals: how much this user has given to each of their direct
   * children in the period. Net revenue / commission reporting is deferred
   * until settled bets exist to compute it from.
   */
  async financialReport(actor: Actor, from?: string, to?: string) {
    if (actor.role !== Role.SUPER_ADMIN && actor.role !== Role.OWNER) throw new ForbiddenException("Financial reports are restricted");
    const entries = await this.prisma.balanceTransaction.findMany({
      where: {
        actorId: actor.id,
        type: BalanceTransactionType.DELEGATION,
        status: BalanceTransactionStatus.APPROVED,
        ...(from || to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
      },
      select: { toUserId: true, amount: true, toUser: { select: { username: true, role: true } } },
    });
    const byRecipient = new Map<string, { userId: string; username: string; role: Role; totalDelegated: number }>();
    for (const entry of entries) {
      const row = byRecipient.get(entry.toUserId) ?? { userId: entry.toUserId, username: entry.toUser.username, role: entry.toUser.role, totalDelegated: 0 };
      row.totalDelegated += Number(entry.amount);
      byRecipient.set(entry.toUserId, row);
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
    if (manager.role !== Role.MANAGER) {
      throw new BadRequestException("Players can only be assigned to Managers");
    }
    if (manager.status !== UserStatus.ACTIVE) {
      throw new BadRequestException("Players cannot be assigned to a suspended Manager");
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
      throw new BadRequestException("Destination Manager has reached its player capacity");
    }

    const previousManager = player.parentId
      ? await this.prisma.user.findUnique({ where: { id: player.parentId }, select: { id: true, username: true } })
      : null;
    const updated = await this.prisma.user.update({
      where: { id },
      data: { parentId: managerId },
      select: publicUserSelect,
    });
    await this.audit.log({
      actorId: actor.id,
      action: "user.reassign",
      targetId: id,
      ipAddress,
      metadata: { fromManagerId: previousManager?.id ?? null, toManagerId: manager.id },
    });
    await this.notifications.create({
      userId: id,
      type: NotificationType.ACCOUNT_REASSIGNED,
      title: "Account reassigned",
      message: `Your account was reassigned to manager ${manager.username}.`,
      deepLink: `/dashboard/users?userId=${manager.id}`,
      metadata: { managerId: manager.id },
    });
    if (previousManager) {
      await this.notifications.create({
        userId: previousManager.id,
        type: NotificationType.ACCOUNT_REASSIGNED,
        title: "Player reassigned",
        message: `${player.username} was moved to another manager.`,
        deepLink: `/dashboard/users?userId=${id}`,
        metadata: { userId: id, managerId: manager.id },
      });
    }
    await this.notifications.create({
      userId: manager.id,
      type: NotificationType.ACCOUNT_REASSIGNED,
      title: "Player assigned",
      message: `${player.username} was assigned to your team.`,
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
      throw new BadRequestException(
        `Failed to update Clerk identity: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    const descendants = await this.hierarchy.getDescendantIds(id);
    if (descendants.length > 0) {
      const childCount = await this.prisma.user.count({ where: { parentId: id } });
      throw new ConflictException(`Manager must be reassigned before deletion; ${childCount} direct child account(s) still depend on this Manager`);
    }
    if (Number(target.balance) > 0) {
      throw new ConflictException("Account still holds a balance; delegate it elsewhere before deleting");
    }

    try {
      await this.clerk.deleteUserStrict(target.clerkId);
      await this.prisma.$transaction([
        this.prisma.auditLog.updateMany({ where: { actorId: id }, data: { actorId: null } }),
        this.prisma.auditLog.updateMany({ where: { targetId: id }, data: { targetId: null } }),
        this.prisma.user.delete({ where: { id } }),
      ]);
    } catch (error) {
      throw new ConflictException(
        `Failed to delete user: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.audit.log({ actorId: actor.id, action: "user.delete", targetId: id, ipAddress });
    return { id };
  }

  async reassignmentPreview(actor: Actor, id: string, managerId: string) {
    const player = await this.prisma.user.findUnique({ where: { id }, select: { id: true, username: true, role: true, parentId: true } });
    const manager = await this.prisma.user.findUnique({ where: { id: managerId }, select: { id: true, username: true, role: true, status: true, managerCapacity: true } });
    if (!player || !manager) throw new NotFoundException("Player or Manager not found");
    const directChildren = await this.prisma.user.findMany({ where: { parentId: managerId, role: Role.PLAYER }, select: { id: true, username: true } });
    const playerDescendants = await this.hierarchy.getDescendantIds(id);
    const authorized = await this.hierarchy.canActOn(actor, id) && await this.hierarchy.canActOn(actor, managerId);
    const valid = authorized && player.role === Role.PLAYER && manager.role === Role.MANAGER && manager.status === UserStatus.ACTIVE && player.parentId !== managerId && !playerDescendants.includes(managerId) && directChildren.length < manager.managerCapacity;
    return {
      valid,
      reason: !authorized ? "Outside your hierarchy" : player.role !== Role.PLAYER ? "Only Players can be reassigned" : manager.role !== Role.MANAGER ? "Destination is not a Manager" : manager.status !== UserStatus.ACTIVE ? "Destination Manager is suspended" : player.parentId === managerId ? "Player is already assigned here" : playerDescendants.includes(managerId) ? "Circular hierarchy detected" : directChildren.length >= manager.managerCapacity ? "Manager capacity reached" : null,
      player: { id: player.id, username: player.username, currentManagerId: player.parentId },
      destination: { id: manager.id, username: manager.username, capacity: manager.managerCapacity, assigned: directChildren.length, remaining: Math.max(0, manager.managerCapacity - directChildren.length) },
      impact: { movedAccounts: 1, currentManagerId: player.parentId },
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
