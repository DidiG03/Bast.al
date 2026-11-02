// Extra time and penalties end to end against a real Postgres: a match that
// went to penalties settles its extra-time markets on extra time's own goals
// and the shootout, while its 90-minute bets still settle on the 90 minutes.
// Empties tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}
delete process.env.RESEND_API_KEY;

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient, Prisma } = require("@prisma/client");
const { UsersService } = require("../dist/users/users.service.js");
const { HierarchyService } = require("../dist/users/hierarchy.service.js");
const { AuditService } = require("../dist/audit/audit.service.js");
const { SettlementService } = require("../dist/bets/settlement.service.js");

const prisma = new PrismaClient();
const realtime = { publish: async () => undefined, publishBalances: async () => undefined, publishTopic: async () => undefined };
const notifications = { create: async (n) => n };
const hierarchy = new HierarchyService(prisma);
const audit = new AuditService(prisma);
const users = new UsersService(prisma, {}, hierarchy, audit, {}, notifications, realtime);
const settlement = new SettlementService(prisma, realtime, notifications, users, audit);

let player, match;
const picks = {};

test("setup", async () => {
  for (const table of ["live_pauses", "goals_seen", "settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "odds_snapshots", "odds_overrides", "selections", "markets", "\"Event\"", "notifications", "notification_preferences", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  const owner = await prisma.user.create({ data: { clerkId: "clerk_et1", username: "et_owner", emailCipher: "x", emailHash: "het1", role: "OWNER", balance: 1000 } });
  player = await prisma.user.create({ data: { clerkId: "clerk_et2", username: "et_player", emailCipher: "x", emailHash: "het2", role: "PLAYER", parentId: owner.id, balance: 100 } });
  // 1–1 after 90 minutes, 2–2 after extra time (1–1 in it), won 4–3 on penalties by the home side.
  match = await prisma.event.create({
    data: {
      name: "Roma v Lazio", homeTeam: "Roma", awayTeam: "Lazio", league: "Coppa Italia", startsAt: new Date(Date.now() - 3 * 3_600_000), status: "COMPLETED", provider: "api-football", externalId: "et-1",
      homeScore: 2, awayScore: 2, resultHome: 1, resultAway: 1, resultHalfHome: 0, resultHalfAway: 1, extraTime: true, resultEtHome: 1, resultEtAway: 1, resultPenHome: 4, resultPenAway: 3, resultSource: "feed", finishedAt: new Date(Date.now() - 3_600_000),
    },
  });
  const market = async (key, name, outcomes) => {
    const row = await prisma.market.create({ data: { eventId: match.id, key, name } });
    for (const [selKey, selName] of outcomes) picks[`${key}:${selKey}`] = await prisma.selection.create({ data: { marketId: row.id, key: selKey, name: selName, feedOdds: new Prisma.Decimal(2) } });
  };
  await market("match_winner", "Match winner", [["home", "Roma"], ["draw", "Draw"], ["away", "Lazio"]]);
  await market("et_winner", "Extra time result", [["home", "Roma"], ["draw", "Draw"], ["away", "Lazio"]]);
  await market("et_goals_1_5", "Extra time goals 1.5", [["over", "Over 1.5"], ["under", "Under 1.5"]]);
  await market("to_qualify", "To qualify", [["home", "Roma"], ["away", "Lazio"]]);
  await market("pen_winner", "Penalty shootout winner", [["home", "Roma"], ["away", "Lazio"]]);
  for (const key of ["match_winner:draw", "et_winner:draw", "et_goals_1_5:over", "to_qualify:home", "pen_winner:away"]) {
    await prisma.bet.create({ data: { playerId: player.id, stake: new Prisma.Decimal(10), odds: new Prisma.Decimal(2), selectionId: picks[key].id, status: "OPEN" } });
  }
});

test("settles each market on the right part of the match", async () => {
  await settlement.settleEvent(match.id);
  const rows = await prisma.bet.findMany({ where: { playerId: player.id }, include: { selection: { include: { market: true } } } });
  const status = Object.fromEntries(rows.map((bet) => [`${bet.selection.market.key}:${bet.selection.key}`, bet.status]));
  assert.deepEqual(status, {
    "match_winner:draw": "WON", // the 90 minutes: 1–1
    "et_winner:draw": "WON", // extra time alone: 1–1
    "et_goals_1_5:over": "WON", // two goals in extra time
    "to_qualify:home": "WON", // level after extra time, Roma won the shootout
    "pen_winner:away": "LOST",
  });
});

test("teardown", async () => {
  await prisma.$disconnect();
});
