import { Prisma, Role } from "@prisma/client";

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
