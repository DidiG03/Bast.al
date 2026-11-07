// A Player to try the site with, on a local or test database: a test Owner and Manager (nobody
// signs in as them) and a Player linked to a Clerk user you can sign in as, with credit, and the
// Casino open. Run from the repository root:
//
//   npx dotenv -e .env -- node apps/api/scripts/dev-test-player.mjs [clerkUserId] [username] [credit]
//
// The Clerk user id is on the user's page in the Clerk dashboard (user_...). Running it again tops
// the Player up to `credit`. Refuses to run with NODE_ENV=production.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run in production.");
  process.exit(1);
}

const clerkId = process.argv[2] ?? "user_3LYxNRMdK2GqJUFKdsjCFkVTJZo";
const username = process.argv[3] ?? "zzpreview_player";
const credit = Number(process.argv[4] ?? 100000);
const prisma = new PrismaClient();

/** A team account nobody signs in as (its Clerk id starts with "demo_"). */
async function teamUser(name, role, parentId, extra) {
  const existing = await prisma.user.findUnique({ where: { username: name } });
  if (existing) return existing;
  return prisma.user.create({ data: { clerkId: `demo_${name}`, username: name, emailCipher: "x", emailHash: `demo_${name}`, role, parentId, ...extra } });
}

try {
  const superAdmin = (await prisma.user.findFirst({ where: { role: "SUPER_ADMIN" }, orderBy: { createdAt: "asc" } })) ?? (await teamUser("test_superadmin", "SUPER_ADMIN", null, {}));
  const owner = await teamUser("test_owner", "OWNER", superAdmin.id, { commissionRate: 10, balance: 10_000_000, casinoEnabled: true });
  await prisma.user.update({ where: { id: owner.id }, data: { casinoEnabled: true } });
  const manager = await teamUser("test_manager", "MANAGER", owner.id, { commissionRate: 20, balance: 5_000_000 });
  await prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default", casinoEnabled: true }, update: { casinoEnabled: true } });

  let player = await prisma.user.findUnique({ where: { clerkId } });
  if (player && player.role !== "PLAYER") throw new Error(`That Clerk user is already a ${player.role} here; pick another one.`);
  if (!player) {
    if (await prisma.user.findUnique({ where: { username } })) throw new Error(`The username "${username}" is taken here; pass another one.`);
    player = await prisma.user.create({ data: { clerkId, username, emailCipher: "x", emailHash: `test_${clerkId}`, role: "PLAYER", parentId: manager.id } });
  }
  // Credit from the Manager, as the app gives it, so the Player's ledger adds up to the balance.
  const topUp = Math.round((credit - Number(player.balance)) * 100) / 100;
  if (topUp > 0) {
    await prisma.$transaction([
      prisma.user.update({ where: { id: player.id }, data: { balance: { increment: topUp } } }),
      prisma.user.update({ where: { id: player.parentId ?? manager.id }, data: { balance: { decrement: topUp } } }),
      prisma.balanceTransaction.create({ data: { fromUserId: player.parentId ?? manager.id, toUserId: player.id, actorId: player.parentId ?? manager.id, type: "DELEGATION", amount: topUp, reason: "Test credit" } }),
    ]);
  }
  const balance = Number((await prisma.user.findUniqueOrThrow({ where: { id: player.id }, select: { balance: true } })).balance);
  console.log(`Ready: sign in as ${username} (Clerk ${clerkId}). Player under test_manager / test_owner, balance ${balance.toFixed(2)} ALL, Casino open.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
