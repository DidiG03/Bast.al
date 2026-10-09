import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { hashSeed, newClientSeed, newServerSeed } from "./dice";

/**
 * The Player's provably fair seed pair, shared by Dice and Keno: each round
 * takes the pair's next nonce. While a pair is active only its server
 * seed's hash is shown; changing the pair (DiceService.changeSeed) reveals
 * it, so every round made with it can be checked.
 */
export type Seed = { id: string; serverSeed: string; serverSeedHash: string; clientSeed: string; nonce: number; active: boolean };

/** A seed pair as the Player may see it: the server seed only once it's been changed. */
export function seedView(seed: Seed) {
  return { serverSeedHash: seed.serverSeedHash, clientSeed: seed.clientSeed, nonce: seed.nonce, serverSeed: seed.active ? null : seed.serverSeed };
}

/** The Player's active seed pair, made the first time they need one. Call with the Player's row locked. */
export async function activeSeed(db: Prisma.TransactionClient | PrismaService, playerId: string): Promise<Seed> {
  const seed = await db.diceSeed.findFirst({ where: { playerId, active: true }, orderBy: { createdAt: "desc" } });
  if (seed) return seed;
  const serverSeed = newServerSeed();
  return db.diceSeed.create({ data: { playerId, serverSeed, serverSeedHash: hashSeed(serverSeed), clientSeed: newClientSeed() } });
}

/** Server seeds already shown, by seed id, for these seed ids. */
export async function revealedSeeds(prisma: PrismaService, seedIds: Array<string | undefined>): Promise<Map<string, string>> {
  const ids = [...new Set(seedIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const seeds = await prisma.diceSeed.findMany({ where: { id: { in: ids }, active: false }, select: { id: true, serverSeed: true } });
  return new Map(seeds.map((seed) => [seed.id, seed.serverSeed]));
}

/** The Player's active seed pair, made if they have none, with their row locked so two first visits don't make two. */
export function lockedActiveSeed(prisma: PrismaService, playerId: string): Promise<Seed> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${playerId} FOR UPDATE`;
    return activeSeed(tx, playerId);
  });
}

/** The last seed pair the Player changed, its server seed shown; null if they never have. */
export function previousSeed(prisma: PrismaService, playerId: string) {
  return prisma.diceSeed.findFirst({ where: { playerId, active: false }, orderBy: { revealedAt: "desc" } });
}
