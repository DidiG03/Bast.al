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

type TeamRow = {
  parent_id: string | null;
  parent_role: Role | null;
  parent_status: UserStatus | null;
  parent_rate: Prisma.Decimal | null;
  grand_id: string | null;
  grand_role: Role | null;
  grand_rate: Prisma.Decimal | null;
};

/**
 * The Player's parent and the parent's parent, in one query: every bet and
 * every casino round looks this up, so it's one round trip, not three.
 */
async function teamRow(db: Pick<Prisma.TransactionClient, "$queryRaw">, playerId: string): Promise<TeamRow | undefined> {
  const rows = await db.$queryRaw<TeamRow[]>`
    SELECT p.id AS parent_id, p.role::text AS parent_role, p.status::text AS parent_status, p.commission_rate AS parent_rate,
      g.id AS grand_id, g.role::text AS grand_role, g.commission_rate AS grand_rate
    FROM users u
    LEFT JOIN users p ON p.id = u.parent_id
    LEFT JOIN users g ON g.id = p.parent_id
    WHERE u.id = ${playerId}`;
  return rows[0];
}

function snapshotOf(row: TeamRow | undefined): TeamSnapshot {
  const zero = new Prisma.Decimal(0);
  const rate = (value: Prisma.Decimal | null) => (value === null ? zero : new Prisma.Decimal(value));
  if (row?.parent_role === Role.OWNER) return { ownerId: row.parent_id, managerId: null, ownerRate: rate(row.parent_rate), managerRate: zero };
  if (row?.parent_role === Role.MANAGER) {
    const owner = row.grand_role === Role.OWNER;
    return { ownerId: owner ? row.grand_id : null, managerId: row.parent_id, ownerRate: owner ? rate(row.grand_rate) : zero, managerRate: rate(row.parent_rate) };
  }
  return { ownerId: null, managerId: null, ownerRate: zero, managerRate: zero };
}

/** The team a Player bets for right now: their Owner and Manager, and each one's commission rate. */
export async function teamOf(db: Pick<Prisma.TransactionClient, "$queryRaw">, playerId: string): Promise<TeamSnapshot> {
  return snapshotOf(await teamRow(db, playerId));
}

/**
 * A Player can bet, or play in the Casino, only while they sit in a team:
 * under an active Manager who belongs to an Owner, or directly under an
 * Owner. Player accounts are only ever made by their Manager or Owner, so
 * this also shuts out any account that got in some other way.
 */
export async function assertOnTeam(db: Pick<Prisma.TransactionClient, "$queryRaw">, player: { id: string; parentId: string | null }): Promise<TeamSnapshot & { ownerId: string }> {
  const row = await teamRow(db, player.id);
  const team = snapshotOf(row);
  const ownerId = team.ownerId;
  if (!player.parentId || !row?.parent_id || !ownerId) throw new ForbiddenException("Your account isn't on a team yet, so it can't place bets. Your Manager or Owner has to set it up.");
  if (row.parent_status !== UserStatus.ACTIVE) throw new ForbiddenException("Your Manager's account is suspended, so betting is paused.");
  return { ...team, ownerId };
}
