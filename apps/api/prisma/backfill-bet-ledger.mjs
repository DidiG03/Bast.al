// One-off: writes balance-ledger entries for bets placed before bets were
// recorded in the ledger, so every Player's statement explains their balance.
//
//   npx dotenv -e ../../.env -- node prisma/backfill-bet-ledger.mjs          (dry run)
//   npx dotenv -e ../../.env -- node prisma/backfill-bet-ledger.mjs --apply
//
// Safe to run again: a bet that already has a ledger entry is skipped. Each
// bet gets its stake (dated when it was placed) and, if it paid anything
// back, one settlement entry for its final payout (dated when it settled).
// Balances are not touched; they already include these amounts.
import { PrismaClient } from "@prisma/client";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();

function settlementReason(bet) {
  const what = bet.description ?? "bet";
  if (bet.status === "VOID") return `Bet refunded: ${what}${bet.voidReason ? ` (${bet.voidReason})` : ""}`;
  if (bet.status === "WON") return `Bet won: ${what}`;
  return `Bet settled: ${what}`;
}

let cursor;
let bets = 0;
let entries = 0;
for (;;) {
  const page = await prisma.bet.findMany({
    where: { ledger: { none: {} } },
    orderBy: { id: "asc" },
    take: 500,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: { id: true, playerId: true, stake: true, payout: true, status: true, description: true, voidReason: true, placedAt: true, settledAt: true },
  });
  if (page.length === 0) break;
  cursor = page[page.length - 1].id;

  const data = [];
  for (const bet of page) {
    data.push({
      toUserId: bet.playerId,
      actorId: bet.playerId,
      type: "BET_STAKE",
      amount: bet.stake.negated(),
      reason: `Bet placed: ${bet.description ?? "bet"}`,
      betId: bet.id,
      createdAt: bet.placedAt,
    });
    if (bet.status !== "OPEN" && bet.payout.greaterThan(0)) {
      data.push({
        toUserId: bet.playerId,
        type: "BET_SETTLEMENT",
        amount: bet.payout,
        reason: settlementReason(bet),
        betId: bet.id,
        createdAt: bet.settledAt ?? bet.placedAt,
      });
    }
  }
  bets += page.length;
  entries += data.length;
  if (apply) await prisma.balanceTransaction.createMany({ data });
}

console.log(`${apply ? "Wrote" : "Would write"} ${entries} ledger entries for ${bets} bets.${apply ? "" : " Run with --apply to write them."}`);
await prisma.$disconnect();
