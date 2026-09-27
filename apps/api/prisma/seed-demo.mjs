// Demo data for the Commissions page until real betting exists.
//
//   npm run db:seed-demo              settled bets for every Player that has none
//   npm run db:seed-demo -- --users   also create a demo team (2 Owners, 4 Managers,
//                                     18 Players) under the first Super Admin
//
// Demo accounts get clerk ids starting with "demo_", so nobody can sign in as
// them. Refuses to run with NODE_ENV=production.
import { PrismaClient } from "@prisma/client";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data in production.");
  process.exit(1);
}

const prisma = new PrismaClient();
const WEEKS = 5;

// Small seeded PRNG so every run produces the same numbers.
let state = 20260927;
function random() {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
}
const between = (min, max) => min + random() * (max - min);
const money = (value) => Math.round(value * 100) / 100;

async function demoUser(username, role, parentId, extra = {}) {
  return prisma.user.upsert({
    where: { username },
    update: {},
    create: {
      username,
      role,
      parentId,
      clerkId: `demo_${username}`,
      emailCipher: "demo",
      emailHash: `demo:${username}`,
      ...extra,
    },
  });
}

async function createTeam() {
  const superAdmin = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN" }, orderBy: { createdAt: "asc" } });
  if (!superAdmin) throw new Error("Create the Super Admin first (POST /api/users/bootstrap/super-admin).");
  const owners = [
    { name: "demo_arben", rate: 30, managers: [["demo_blerta", 20], ["demo_driton", 15]], direct: 1 },
    { name: "demo_elira", rate: 25, managers: [["demo_gent", 20], ["demo_ilir", 10]], direct: 1 },
  ];
  let playerNumber = 1;
  for (const spec of owners) {
    const owner = await demoUser(spec.name, "OWNER", superAdmin.id, { commissionRate: spec.rate });
    for (const [name, rate] of spec.managers) {
      const manager = await demoUser(name, "MANAGER", owner.id, { commissionRate: rate });
      for (let i = 0; i < 4; i++) await demoUser(`demo_player${playerNumber++}`, "PLAYER", manager.id);
    }
    for (let i = 0; i < spec.direct; i++) await demoUser(`demo_player${playerNumber++}`, "PLAYER", owner.id);
  }
  console.log(`Demo team ready: ${owners.length} Owners, ${owners.length * 2} Managers, ${playerNumber - 1} Players.`);
}

async function createBets() {
  const players = await prisma.user.findMany({ where: { role: "PLAYER", bets: { none: {} } }, select: { id: true } });
  const now = Date.now();
  const bets = [];
  for (const player of players) {
    // Some Players are sharper than others, so results vary per Player.
    const winChance = between(0.3, 0.5);
    for (let week = 0; week < WEEKS; week++) {
      const count = Math.floor(between(3, 12));
      for (let i = 0; i < count; i++) {
        const settledAt = new Date(now - (week * 7 + between(0, 7)) * 86_400_000);
        const stake = money(between(5, 200));
        const won = random() < winChance;
        bets.push({
          playerId: player.id,
          stake,
          payout: won ? money(stake * between(1.4, 3.2)) : 0,
          status: won ? "WON" : "LOST",
          placedAt: new Date(settledAt.getTime() - between(1, 48) * 3_600_000),
          settledAt,
        });
      }
    }
  }
  if (bets.length) await prisma.bet.createMany({ data: bets });
  console.log(`Created ${bets.length} settled bets for ${players.length} Players over the last ${WEEKS} weeks.`);
}

try {
  if (process.argv.includes("--users")) await createTeam();
  await createBets();
} finally {
  await prisma.$disconnect();
}
