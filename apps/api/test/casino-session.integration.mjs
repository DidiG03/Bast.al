// The casino session summary, end to end against a real Postgres: a game's
// rounds since the Player opened it, paid and free, double or nothing counted
// apart, what the paid rounds took and what came back; other games, other
// Players and earlier rounds left out. Like the other integration tests it
// empties tables, so it only runs against a database whose name ends in "_test".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!database.endsWith("_test")) {
  console.error(`Refusing to run: this test empties tables, and "${database}" isn't a database whose name ends in _test.`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { PrismaClient, Prisma } = require("@prisma/client");
const { CasinoService } = require("../dist/casino/casino.service.js");

const prisma = new PrismaClient();
const casino = new CasinoService(prisma, {}, {}, {}, {}, {});

let n = 0;
async function user(role, parentId) {
  n += 1;
  return prisma.user.create({ data: { clerkId: `clerk_cs${n}`, username: `cs${n}_${role.toLowerCase()}`, emailCipher: "x", emailHash: `hcs${n}`, role, parentId } });
}
const as = (row) => ({ id: row.id, role: row.role, parentId: row.parentId, username: row.username });

let player, other;
const opened = new Date("2026-11-01T18:00:00Z");
const at = (minutes) => new Date(opened.getTime() + minutes * 60_000);

test("setup", async () => {
  for (const table of ["settlement_entries", "casino_spins", "casino_free_spins", "casino_gambles", "blackjack_hands", "mines_rounds", "penalty_rounds", "commission_payouts", "balance_transactions", "bet_legs", "bets", "notifications", "notification_preferences", "audit_logs", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
  }
  const owner = await user("OWNER", null);
  player = await user("PLAYER", owner.id);
  other = await user("PLAYER", owner.id);
  const round = (playerId, kind, stake, win, createdAt, extra = {}) =>
    prisma.casinoSpin.create({ data: { playerId, kind, bet: new Prisma.Decimal(stake), stake: new Prisma.Decimal(stake), win: new Prisma.Decimal(win), grid: [], stops: [], lines: [], createdAt, ...extra } });
  // Book of Ra since it was opened: three paid spins (one won 50), a free spin that won 20, and a guess that doubled the 50.
  await round(player.id, "BOOK", 50, 0, at(1));
  await round(player.id, "BOOK", 50, 50, at(2));
  await round(player.id, "BOOK", 50, 0, at(3));
  await round(player.id, "BOOK", 50, 20, at(4), { free: true });
  await round(player.id, "GAMBLE", 50, 100, at(5), { gamble: { game: "book", pick: "RED", suit: "HEARTS" } });
  // Left out: before it was opened, Sizzling Hot (and its guess), another Player.
  await round(player.id, "BOOK", 50, 500, at(-5));
  await round(player.id, "SPIN", 10, 10, at(2));
  await round(player.id, "GAMBLE", 10, 0, at(3), { gamble: { pick: "BLACK", suit: "HEARTS", game: "slot" } });
  await round(other.id, "BOOK", 50, 0, at(2));
});

test("a game's session: rounds, guesses, staked and won since it was opened", async () => {
  const book = await casino.session(as(player), "book", opened.toISOString());
  // Staked 150 on the paid spins; back: 50 + 20 free, and the guess turned the 50 into 100 (+50): net -150 + 50 + 20 + 50 = -30.
  assert.deepEqual(book, { rounds: 4, gambles: 1, staked: 150, won: 120, net: -30 });
  assert.deepEqual(await casino.session(as(player), "slot", opened.toISOString()), { rounds: 1, gambles: 1, staked: 10, won: 0, net: -10 });
  assert.deepEqual(await casino.session(as(player), "mines", opened.toISOString()), { rounds: 0, gambles: 0, staked: 0, won: 0, net: 0 });
  await assert.rejects(() => casino.session(as(player), "poker", opened.toISOString()), /Unknown game/);
  await assert.rejects(() => casino.session(as(player), "book", "yesterday"), /Since must be a time/);
});

test.after(() => prisma.$disconnect());
