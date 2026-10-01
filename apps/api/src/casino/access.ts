import { Prisma } from "@prisma/client";
import { assertOnTeam } from "../bets/team";

/**
 * Why a Player can't play in the Casino right now, or null if they can:
 * they must be on an active team (like betting), and the Casino must be open
 * for the site (Super Admin's switch) and for their team (their Owner's).
 */
export async function casinoClosedReason(db: Pick<Prisma.TransactionClient, "user" | "platformSettings">, player: { id: string; parentId: string | null }): Promise<string | null> {
  let ownerId: string;
  try {
    ownerId = (await assertOnTeam(db, player)).ownerId;
  } catch (error) {
    return error instanceof Error ? error.message : "Your account can't play right now";
  }
  const [platform, owner] = await Promise.all([
    db.platformSettings.findUnique({ where: { id: "default" }, select: { casinoEnabled: true } }),
    db.user.findUnique({ where: { id: ownerId }, select: { casinoEnabled: true } }),
  ]);
  if (!platform?.casinoEnabled) return "The Casino is closed right now.";
  if (!owner?.casinoEnabled) return "The Casino isn't open for your team.";
  return null;
}
