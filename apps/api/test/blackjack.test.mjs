// Run with `npm test --workspace apps/api` (builds first). Blackjack's rules on
// stacked shoes: hand values, the dealer on soft 17, blackjacks, insurance,
// one split and one double per round, and every pay-out. The payout rate
// itself is measured by scripts/blackjack-rtp.mjs over millions of hands.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DECKS, act, allowed, deal, handTotal, newShoe, paidOut, publicView, staked, standAll } = require("../dist/casino/blackjack.js");

/** A shoe that deals these cards first, in this order (player, dealer, player, dealer, then draws), with small cards after. */
const stacked = (...cards) => [...Array(40).fill("2C"), ...cards.reverse()];
const play = (round, ...moves) => moves.reduce((current, move) => act(current, move), round);

test("a shoe is 6 full decks, shuffled", () => {
  const shoe = newShoe();
  assert.equal(shoe.length, DECKS * 52);
  assert.equal(new Set(shoe).size, 52);
  assert.equal(shoe.filter((card) => card === "AS").length, DECKS);
  assert.notDeepEqual(shoe, newShoe(() => 0));
});

test("hand values: faces are 10, an ace is 11 unless that busts", () => {
  assert.deepEqual(handTotal(["AS", "6H"]), { total: 17, soft: true });
  assert.deepEqual(handTotal(["AS", "6H", "TD"]), { total: 17, soft: false });
  assert.deepEqual(handTotal(["AS", "AH", "9D"]), { total: 21, soft: true });
  assert.deepEqual(handTotal(["KS", "QH"]), { total: 20, soft: false });
  assert.deepEqual(handTotal(["KS", "QH", "2D"]), { total: 22, soft: false });
});

test("a win pays 1 to 1, a tie returns the bet, a bust loses", () => {
  const win = play(deal(1000, stacked("TS", "9H", "8D", "8C")), "stand"); // 18 against 17
  assert.deepEqual([win.hands[0].result, paidOut(win)], ["WIN", 2000]);
  const push = play(deal(1000, stacked("TS", "9H", "7D", "8C")), "stand"); // 17 against 17
  assert.deepEqual([push.hands[0].result, paidOut(push)], ["PUSH", 1000]);
  const bust = play(deal(1000, stacked("TS", "9H", "6D", "8C", "KH")), "hit");
  assert.deepEqual([bust.hands[0].result, bust.phase, paidOut(bust)], ["BUST", "DONE", 0]);
  assert.equal(bust.dealer.length, 2, "the dealer doesn't draw against a bust hand");
});

test("the dealer draws to 17 and stands on soft 17", () => {
  const soft17 = play(deal(1000, stacked("TS", "AH", "8D", "6C", "5H")), "noInsurance", "stand");
  assert.deepEqual(soft17.dealer, ["AH", "6C"], "soft 17 stands");
  assert.equal(soft17.hands[0].result, "WIN");
  const draws = play(deal(1000, stacked("TS", "5H", "8D", "6C", "4H", "9D")), "stand"); // 11, then 15, then 24
  assert.deepEqual(draws.dealer, ["5H", "6C", "4H", "9D"]);
  assert.equal(draws.hands[0].result, "WIN");
});

test("blackjack pays 3 to 2 at once; against the dealer's blackjack it's a tie; 21 in three cards isn't blackjack", () => {
  const bj = deal(1000, stacked("AS", "9H", "KD", "8C"));
  assert.deepEqual([bj.phase, bj.hands[0].result, paidOut(bj)], ["DONE", "BLACKJACK", 2500]);
  const both = deal(1000, stacked("AS", "AC", "KD", "KH"));
  assert.equal(both.phase, "INSURANCE", "insurance is offered first with an ace showing");
  const tied = act(both, "noInsurance");
  assert.deepEqual([tied.hands[0].result, paidOut(tied)], ["PUSH", 1000]);
  const three = play(deal(1000, stacked("5S", "TH", "6D", "7C", "KH")), "hit");
  assert.equal(three.hands[0].result, "WIN", "21 in three cards beats 17 but pays 1 to 1");
  assert.equal(paidOut(three), 2000);
});

test("under a ten showing, the dealer's blackjack stays face down until the Player has played, and then beats a double too", () => {
  const round = deal(1000, stacked("6S", "KH", "5D", "AC", "TD")); // 11 against a king, the ace face down
  assert.equal(round.phase, "PLAYER");
  assert.deepEqual(publicView(round).dealer, ["KH", null]);
  const done = act(round, "double"); // 21 in three cards
  assert.deepEqual(done.dealer, ["KH", "AC"], "the dealer doesn't draw on blackjack");
  assert.deepEqual([done.hands[0].result, staked(done), paidOut(done)], ["LOSE", 2000, 0]);
  const ace = act(deal(1000, stacked("TS", "AH", "9D", "KC")), "noInsurance");
  assert.deepEqual([ace.phase, ace.dealer, ace.hands[0].result, paidOut(ace)], ["DONE", ["AH", "KC"], "LOSE", 0], "under an ace, the dealer looks after insurance: blackjack ends the round");
  const noBlackjack = act(deal(1000, stacked("TS", "AH", "9D", "7C")), "noInsurance");
  assert.deepEqual([noBlackjack.phase, publicView(noBlackjack).dealer], ["PLAYER", ["AH", null]], "no blackjack: the card stays down and the Player plays");
});

test("insurance costs half the bet and pays 2 to 1 when the dealer has blackjack", () => {
  const insured = act(deal(1000, stacked("TS", "AH", "9D", "KC")), "insure");
  assert.equal(insured.phase, "DONE", "the dealer looks, and the blackjack ends the round");
  assert.deepEqual([insured.insurance, insured.insurancePayout, insured.hands[0].result, staked(insured), paidOut(insured)], [500, 1500, "LOSE", 1500, 1500]);
  const miss = act(deal(1000, stacked("TS", "AH", "9D", "7C")), "insure");
  assert.deepEqual([miss.phase, miss.insurancePayout, staked(miss)], ["PLAYER", 0, 1500], "insurance lost, the hand plays on");
  const done = act(miss, "stand"); // 19 against soft 18
  assert.deepEqual([done.hands[0].result, paidOut(done)], ["WIN", 2000]);
  assert.deepEqual(allowed(deal(1000, stacked("TS", "AH", "9D", "7C"))), ["insure", "noInsurance"]);
});

test("double down: twice the bet, one card, once a round", () => {
  const round = play(deal(1000, stacked("6S", "TH", "5D", "7C", "TD")), "double"); // 21 against 17
  assert.deepEqual([round.hands[0].bet, round.hands[0].cards.length, round.hands[0].result, paidOut(round)], [2000, 3, "WIN", 4000]);
  const hit = act(deal(1000, stacked("2S", "TH", "3D", "7C", "4H")), "hit");
  assert.ok(!allowed(hit).includes("double"), "only on the first two cards");
});

test("one split into two hands, a double on one of them, and no second split or double", () => {
  // 8s split; first hand gets a 3 (11) and doubles onto a 10; second gets an 8 but can't split again or double.
  let round = deal(1000, stacked("8S", "TH", "8D", "7C", "3H", "8H", "TD"));
  assert.ok(allowed(round).includes("split"));
  round = act(round, "split");
  assert.deepEqual(round.hands.map((hand) => hand.cards), [["8S", "3H"], ["8D", "8H"]]);
  assert.equal(staked(round), 2000);
  round = act(round, "double");
  assert.deepEqual([round.hands[0].bet, round.hands[0].done, round.active], [2000, true, 1]);
  assert.deepEqual(allowed(round), ["hit", "stand"], "the second hand can't split or double");
  round = act(round, "stand"); // 21 and 16 against 17
  assert.deepEqual(round.hands.map((hand) => hand.result), ["WIN", "LOSE"]);
  assert.deepEqual([staked(round), paidOut(round)], [3000, 4000]);
});

test("split aces get one card each, and 21 on a split hand isn't blackjack", () => {
  const round = act(deal(1000, stacked("AS", "9H", "AD", "8C", "KH", "5D")), "split");
  assert.equal(round.phase, "DONE", "no moves on split aces");
  assert.deepEqual(round.hands.map((hand) => [hand.cards.length, hand.result, hand.payout]), [[2, "WIN", 2000], [2, "LOSE", 0]]);
});

test("only two cards of the same rank split: two kings, not a king and a queen", () => {
  assert.ok(allowed(deal(1000, stacked("KS", "9H", "KD", "8C"))).includes("split"));
  assert.ok(!allowed(deal(1000, stacked("KS", "9H", "QD", "8C"))).includes("split"));
  assert.ok(!allowed(deal(1000, stacked("KS", "9H", "9D", "8C"))).includes("split"));
});

test("moves out of turn are refused", () => {
  const done = deal(1000, stacked("AS", "9H", "KD", "8C"));
  assert.throws(() => act(done, "hit"), /round is over/);
  const insurance = deal(1000, stacked("TS", "AH", "9D", "7C"));
  assert.throws(() => act(insurance, "hit"), /isn't open/);
  const playing = deal(1000, stacked("TS", "9H", "8D", "8C"));
  assert.throws(() => act(playing, "insure"), /isn't open/);
  assert.equal(playing.hands[0].cards.length, 2, "a refused move changes nothing");
});

test("the Player never sees the dealer's face-down card or the shoe before the round ends", () => {
  const round = deal(1000, stacked("TS", "9H", "8D", "QC"));
  const view = publicView(round);
  assert.deepEqual(view.dealer, ["9H", null]);
  assert.equal(view.dealerTotal, 9);
  assert.ok(!JSON.stringify(view).includes("QC"));
  assert.ok(!("shoe" in view));
  const over = publicView(act(round, "stand"));
  assert.deepEqual(over.dealer, ["9H", "QC"]);
  assert.equal(over.payout, 0);
});

test("a round the Player walks away from is stood and settled", () => {
  const left = standAll(deal(1000, stacked("TS", "AH", "9D", "7C")));
  assert.deepEqual([left.phase, left.insurance, left.hands[0].result], ["DONE", 0, "WIN"]);
});
