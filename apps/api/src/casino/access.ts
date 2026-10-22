import { BalanceTransactionType, Prisma } from "@prisma/client";
import { assertOnTeam } from "../bets/team";

/** Every Casino game, by the key its switches, stats and "Continue playing" use. */
export const CASINO_GAMES = ["slot", "book", "roulette", "blackjack", "penalty", "mines", "plinko", "dice", "keno", "coinflip", "scratch"] as const;
export type CasinoGame = (typeof CASINO_GAMES)[number];
export const isCasinoGame = (value: unknown): value is CasinoGame => typeof value === "string" && (CASINO_GAMES as readonly string[]).includes(value);

type AccessDb = Pick<Prisma.TransactionClient, "$queryRaw" | "user" | "platformSettings" | "bettingLimit">;

/**
 * Why a Player can't play in the Casino right now, or null if they can:
 * they must be on an active team (like betting), and the Casino must be open
 * for the site (Super Admin's switch), for their team (their Owner's) and
 * for them (their Owner or Manager can turn it off for one Player). With a
 * `game`, that game must be on too: Super Admin turns a game off for the
 * whole site, an Owner for their team.
 */
export async function casinoClosedReason(db: AccessDb, player: { id: string; parentId: string | null }, game?: CasinoGame): Promise<string | null> {
  const access = await casinoAccess(db, player);
  if (access.closed) return access.closed;
  if (game && access.siteOff.includes(game)) return "This game isn't available right now.";
  if (game && access.teamOff.includes(game)) return "This game isn't open for your team.";
  return null;
}

/** The games this Player can play now, in the lobby's order: none while the Casino is closed to them. */
export async function playableGames(db: AccessDb, player: { id: string; parentId: string | null }): Promise<CasinoGame[]> {
  const access = await casinoAccess(db, player);
  if (access.closed) return [];
  return CASINO_GAMES.filter((game) => !access.siteOff.includes(game) && !access.teamOff.includes(game));
}

async function casinoAccess(db: AccessDb, player: { id: string; parentId: string | null }): Promise<{ closed: string | null; siteOff: string[]; teamOff: string[] }> {
  let ownerId: string;
  try {
    ownerId = (await assertOnTeam(db, player)).ownerId;
  } catch (error) {
    return { closed: error instanceof Error ? error.message : "Your account can't play right now", siteOff: [], teamOff: [] };
  }
  const [platform, owner, limits] = await Promise.all([
    db.platformSettings.findUnique({ where: { id: "default" }, select: { casinoEnabled: true, casinoGamesOff: true } }),
    db.user.findUnique({ where: { id: ownerId }, select: { casinoEnabled: true, casinoGamesOff: true } }),
    db.bettingLimit.findUnique({ where: { playerId: player.id }, select: { ownerCasinoOff: true, managerCasinoOff: true } }),
  ]);
  const off = { siteOff: platform?.casinoGamesOff ?? [], teamOff: owner?.casinoGamesOff ?? [] };
  if (!platform?.casinoEnabled) return { closed: "The Casino is closed right now.", ...off };
  if (!owner?.casinoEnabled) return { closed: "The Casino isn't open for your team.", ...off };
  if (limits?.ownerCasinoOff || limits?.managerCasinoOff) return { closed: "The Casino is turned off for your account.", ...off };
  return { closed: null, ...off };
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
