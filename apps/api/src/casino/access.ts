import { BalanceTransactionType, Prisma } from "@prisma/client";
import { assertOnTeam } from "../bets/team";

/**
 * Why a Player can't play in the Casino right now, or null if they can:
 * they must be on an active team (like betting), and the Casino must be open
 * for the site (Super Admin's switch), for their team (their Owner's) and
 * for them (their Owner or Manager can turn it off for one Player).
 */
export async function casinoClosedReason(db: Pick<Prisma.TransactionClient, "user" | "platformSettings" | "bettingLimit">, player: { id: string; parentId: string | null }): Promise<string | null> {
  let ownerId: string;
  try {
    ownerId = (await assertOnTeam(db, player)).ownerId;
  } catch (error) {
    return error instanceof Error ? error.message : "Your account can't play right now";
  }
  const [platform, owner, limits] = await Promise.all([
    db.platformSettings.findUnique({ where: { id: "default" }, select: { casinoEnabled: true } }),
    db.user.findUnique({ where: { id: ownerId }, select: { casinoEnabled: true } }),
    db.bettingLimit.findUnique({ where: { playerId: player.id }, select: { ownerCasinoOff: true, managerCasinoOff: true } }),
  ]);
  if (!platform?.casinoEnabled) return "The Casino is closed right now.";
  if (!owner?.casinoEnabled) return "The Casino isn't open for your team.";
  if (limits?.ownerCasinoOff || limits?.managerCasinoOff) return "The Casino is turned off for your account.";
  return null;
}

/** The Player's max stake (the stricter of their Owner's and Manager's), or null when there's none. */
export async function maxStakeOf(db: Pick<Prisma.TransactionClient, "bettingLimit">, playerId: string): Promise<number | null> {
  const limit = await db.bettingLimit.findUnique({ where: { playerId }, select: { ownerMaxStake: true, managerMaxStake: true } });
  const stakes = [limit?.ownerMaxStake, limit?.managerMaxStake].filter((value): value is Prisma.Decimal => value !== null && value !== undefined).map(Number);
  return stakes.length ? Math.min(...stakes) : null;
}

/**
 * Adds money moved by a casino game to that game's single line for the day
 * in the Player's balance ledger (`lineId` is one per Player per game per
 * day), so the ledger adds up to the balance without a line per round.
 */
export async function addToDailyLine(tx: Prisma.TransactionClient, lineId: string, playerId: string, amount: Prisma.Decimal, reason: string, now: Date) {
  await tx.balanceTransaction.upsert({
    where: { id: lineId },
    create: { id: lineId, toUserId: playerId, actorId: playerId, type: BalanceTransactionType.CASINO, amount, reason, createdAt: now },
    update: { amount: { increment: amount }, reason },
  });
}
