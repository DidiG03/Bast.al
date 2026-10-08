// Run with `npm test --workspace apps/api` (builds first). The bet builder's
// pricing (src/bets/builder.ts): the goals model fitted to a match's prices,
// linked picks priced together rather than multiplied, picks that can't all
// happen or add nothing refused, markets it can't price refused, and how a
// builder settles from its picks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BUILDER_MARGIN, builderMarket, builderOutcome, fitRates, priceBuilder, scoreGrid } = require("../dist/bets/builder.js");

// Man City v Arsenal: City favourites, goals expected.
const anchor = { home: 1.8, draw: 3.8, away: 4.3, over: 1.7, under: 2.15 };
const leg = (marketKey, selectionKey, price) => ({ marketKey, selectionKey, price });
const city = leg("match_winner", "home", 1.8);
const over = leg("goals_2_5", "over", 1.7);
const btts = leg("btts", "yes", 1.75);

test("the goals model fits the match's own prices", () => {
  const rates = fitRates(anchor);
  assert.ok(rates.home > rates.away, "the favourites score more");
  assert.ok(rates.home + rates.away > 2.5 && rates.home + rates.away < 3.5);
  const cells = scoreGrid(rates.home, rates.away);
  const total = cells.reduce((sum, cell) => sum + cell.p, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  // Each half's goals add up to the full-time score.
  assert.ok(cells.every((cell) => cell.half.home <= cell.home && cell.half.away <= cell.away));
  assert.equal(fitRates({ ...anchor, over: 0 }), null, "no price, no model");
});

test("linked picks pay less than multiplied, and a single pick's own price comes back", () => {
  const quote = priceBuilder([city, over, btts], anchor);
  assert.equal(quote.ok, true);
  const multiplied = 1.8 * 1.7 * 1.75;
  assert.ok(quote.odds < multiplied * 0.75, `${quote.odds} against ${multiplied.toFixed(2)} multiplied`);
  assert.ok(quote.odds > 1.8, "more than any one pick");
  // Picks that pull against each other pay more than they would multiplied less the margin.
  const against = priceBuilder([city, leg("goals_2_5", "under", 2.15)], anchor);
  assert.ok(against.ok && against.odds > 1.8 * 2.15 * (1 - BUILDER_MARGIN / 100));
  // With no margin, the correction alone: two picks on different halves' results are close to apart.
  const halves = priceBuilder([leg("h1_winner", "away", 5), leg("h2_winner", "home", 2.5)], anchor, 0);
  assert.ok(halves.ok && Math.abs(halves.odds - 12.5) / 12.5 < 0.15);
});

test("picks that can't all happen, or that add nothing, are refused", () => {
  assert.deepEqual(priceBuilder([city, leg("correct_score", "0-0", 12)], anchor), { ok: false, reason: "impossible" });
  assert.deepEqual(priceBuilder([city, leg("match_winner", "draw", 3.8)], anchor), { ok: false, reason: "impossible" });
  assert.deepEqual(priceBuilder([city, leg("double_chance", "home_draw", 1.25)], anchor), { ok: false, reason: "covered", leg: 1 });
  assert.deepEqual(priceBuilder([city, leg("goals_0_5", "over", 1.05)], anchor), { ok: false, reason: "covered", leg: 1 }, "a win means a goal");
});

test("markets the score can't settle, or that can be void, are refused", () => {
  assert.deepEqual(priceBuilder([leg("corners_9_5", "over", 1.9), btts], anchor), { ok: false, reason: "unsupported", leg: 0 });
  assert.deepEqual(priceBuilder([btts, leg("draw_no_bet", "home", 1.3)], anchor), { ok: false, reason: "unsupported", leg: 1 });
  assert.equal(builderMarket("match_winner", ["home", "draw", "away"]), true);
  assert.equal(builderMarket("ht_ft", ["home_home", "draw_away"]), true);
  assert.equal(builderMarket("cards_3_5", ["over", "under"]), false);
  assert.equal(builderMarket("draw_no_bet", ["home", "away"]), false);
});

test("a builder wins only when every pick wins, and a void pick refunds it", () => {
  assert.equal(builderOutcome([{ result: "WON" }, { result: "WON" }]), "WON");
  assert.equal(builderOutcome([{ result: "WON" }, { result: null }]), "OPEN");
  assert.equal(builderOutcome([{ result: "LOST" }, { result: null }]), "LOST");
  assert.equal(builderOutcome([{ result: "VOID" }, { result: "WON" }]), "VOID");
  assert.equal(builderOutcome([{ result: "VOID" }, { result: "LOST" }]), "LOST");
});
