// Run with `npm test --workspace apps/api` (builds first). Covers what the
// Player dashboard asks the API for: a top-up request, and how much of the
// daily loss limit is used.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { BettingLimitsService } from "../dist/commissions/betting-limits.service.js";
import { UsersService } from "../dist/users/users.service.js";

const player = { id: "p1", username: "ardi", role: "PLAYER", parentId: "m1", balance: new Prisma.Decimal("3.50") };

/** A UsersService with only what requestTopUp touches. */
function usersWith({ lastRequest = null } = {}) {
  const sent = [];
  const logged = [];
  const prisma = { auditLog: { findFirst: async () => (lastRequest ? { createdAt: lastRequest } : null) } };
  const notifications = { create: async (input) => sent.push(input) };
  const audit = { log: async (input) => logged.push(input) };
  const service = new UsersService(prisma, {}, {}, audit, {}, notifications, {});
  return { service, sent, logged };
}

test("a Player's top-up request notifies whoever looks after them", async () => {
  const { service, sent, logged } = usersWith();
  assert.deepEqual(await service.requestTopUp(player), { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, "m1");
  assert.equal(sent[0].title, "Top-up requested");
  assert.equal(sent[0].message, "ardi is asking for a top-up. Their balance is $3.50.");
  assert.equal(sent[0].deepLink, "/dashboard/players/p1");
  assert.equal(logged[0].action, "balance.topup_request");
});

test("a Player can ask again only after 30 minutes", async () => {
  const { service, sent } = usersWith({ lastRequest: new Date(Date.now() - 10 * 60_000) });
  await assert.rejects(service.requestTopUp(player), /You already asked. You can ask again in 20 min\./);
  assert.equal(sent.length, 0);
});

test("only a Player with a Manager or Owner can ask for a top-up", async () => {
  const { service } = usersWith();
  await assert.rejects(service.requestTopUp({ ...player, role: "MANAGER" }), /Only Players can ask for a top-up/);
  await assert.rejects(service.requestTopUp({ ...player, parentId: null }), /You don't have a Manager or Owner yet/);
});

test("the daily loss limit counts today's net losses plus today's open stakes", async () => {
  const aggregate = async ({ where }) =>
    where.status === "OPEN"
      ? { _sum: { stake: new Prisma.Decimal("15") } }
      : { _sum: { stake: new Prisma.Decimal("40"), payout: new Prisma.Decimal("12.5") } };
  const noSpins = { aggregate: async () => ({ _sum: { stake: null, win: null } }) };
  const noHand = { findUnique: async () => null };
  const limits = new BettingLimitsService({ bet: { aggregate }, casinoSpin: noSpins, blackjackHand: noHand, minesRound: noHand, penaltyRound: noHand }, {});
  assert.equal(await limits.usedToday("p1"), 42.5);

  // A Player who is up on the day has used only their open stakes.
  const winning = new BettingLimitsService(
    { bet: { aggregate: async ({ where }) => (where.status === "OPEN" ? { _sum: { stake: new Prisma.Decimal("5") } } : { _sum: { stake: new Prisma.Decimal("10"), payout: new Prisma.Decimal("30") } }) }, casinoSpin: noSpins, blackjackHand: noHand, minesRound: noHand, penaltyRound: noHand },
    {},
  );
  assert.equal(await winning.usedToday("p1"), 5);

  // Casino losses count in the same limit: 27.50 lost on bets, 20 more on spins.
  const spins = { aggregate: async () => ({ _sum: { stake: new Prisma.Decimal("30"), win: new Prisma.Decimal("10") } }) };
  const both = new BettingLimitsService({ bet: { aggregate }, casinoSpin: spins, blackjackHand: noHand, minesRound: noHand, penaltyRound: noHand }, {});
  assert.equal(await both.usedToday("p1"), 62.5);

  // A blackjack hand and a Mines round still in play count like open bets: 7.50 and 2 more.
  const inPlay = new BettingLimitsService({ bet: { aggregate }, casinoSpin: spins, blackjackHand: { findUnique: async () => ({ staked: new Prisma.Decimal("7.5") }) }, minesRound: { findUnique: async () => ({ staked: new Prisma.Decimal("2") }) }, penaltyRound: noHand }, {});
  assert.equal(await inPlay.usedToday("p1"), 72);
});
