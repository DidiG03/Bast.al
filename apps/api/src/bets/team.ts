import { ForbiddenException } from "@nestjs/common";
import { Prisma, Role, UserStatus } from "@prisma/client";

/** The team a bet belongs to, and the commission rates that apply to it. Recorded on the bet when it's placed. */
export type TeamSnapshot = {
  ownerId: string | null;
  /** Null when the Player sits directly under the Owner. */
  managerId: string | null;
  /** Super Admin's cut of the Owner's profit, in percent. */
  ownerRate: Prisma.Decimal;
  /** The Manager's cut of their Players' profit, in percent; 0 without a Manager. */
  managerRate: Prisma.Decimal;
};

/** The team a Player bets for right now: their Owner and Manager, and each one's commission rate. */
export async function teamOf(db: Pick<Prisma.TransactionClient, "user">, playerId: string): Promise<TeamSnapshot> {
  const player = await db.user.findUnique({
    where: { id: playerId },
    select: {
      parent: {
        select: { id: true, role: true, commissionRate: true, parent: { select: { id: true, role: true, commissionRate: true } } },
      },
    },
  });
  const parent = player?.parent;
  const zero = new Prisma.Decimal(0);
  if (parent?.role === Role.OWNER) return { ownerId: parent.id, managerId: null, ownerRate: parent.commissionRate, managerRate: zero };
  if (parent?.role === Role.MANAGER) {
    const owner = parent.parent?.role === Role.OWNER ? parent.parent : null;
    return { ownerId: owner?.id ?? null, managerId: parent.id, ownerRate: owner?.commissionRate ?? zero, managerRate: parent.commissionRate };
  }
  return { ownerId: null, managerId: null, ownerRate: zero, managerRate: zero };
}

/**
 * A Player can bet, or play in the Casino, only while they sit in a team:
 * under an active Manager who belongs to an Owner, or directly under an
 * Owner. Player accounts are only ever made by their Manager or Owner, so
 * this also shuts out any account that got in some other way.
 */
export async function assertOnTeam(db: Pick<Prisma.TransactionClient, "user">, player: { id: string; parentId: string | null }): Promise<TeamSnapshot & { ownerId: string }> {
  const [parent, team] = await Promise.all([
    player.parentId ? db.user.findUnique({ where: { id: player.parentId }, select: { status: true } }) : null,
    teamOf(db, player.id),
  ]);
  const ownerId = team.ownerId;
  if (!parent || !ownerId) throw new ForbiddenException("Your account isn't on a team yet, so it can't place bets. Your Manager or Owner has to set it up.");
  if (parent.status !== UserStatus.ACTIVE) throw new ForbiddenException("Your Manager's account is suspended, so betting is paused.");
  return { ...team, ownerId };
}
