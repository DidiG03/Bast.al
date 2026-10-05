// Run with `npm test --workspace apps/api` (builds first). Greyhound races:
// reading GreyhoundAPI's race cards and results, the two markets, and
// settling them at the starting price or the forecast dividend.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { RACE_CAP, dogKey, forecastKey, gradeRace, parseRace, raceMarkets, raceSettlePrice } from "../dist/odds/greyhounds.js";
import { eventOpen, selectionQuote } from "../dist/odds/pricing.js";

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).data;
const cards = await load("greyhound-racecards.json");
const results = await load("greyhound-results.json");

test("a race card is read with its dogs in trap order", () => {
  const race = parseRace(cards[0]);
  assert.equal(race.externalId, "326326058");
  assert.equal(race.track, "Yarmouth");
  assert.equal(race.region, "GB");
  assert.equal(race.raceNumber, 10);
  assert.deepEqual(race.runners.slice(0, 2).map((r) => [r.trap, r.name, r.status]), [[1, "Zoo Da Man", "runner"], [2, "Rathorpe Ogie", "runner"]]);
  assert.equal(race.result, null);
  assert.equal(parseRace(cards[3]).runners.length, 0, "a card not declared yet has no dogs");
});

test("a race has a Winner market with every dog and a Forecast with every 1st–2nd pair", () => {
  const race = parseRace(cards[2]); // Shepparton, 10 dogs
  const [winner, forecast] = raceMarkets(race);
  assert.equal(winner.selections.length, 10);
  assert.equal(forecast.selections.length, 90);
  assert.deepEqual(winner.selections[0].info, { trap: 1, trainer: race.runners[0].trainer });
  const pair = forecast.selections.find((s) => s.key === forecastKey(race.runners[0].dogId, race.runners[1].dogId));
  assert.equal(pair.name, `${race.runners[0].name} → ${race.runners[1].name}`, "in order: 1st, then 2nd");
  assert.deepEqual(pair.info, { traps: [1, 2] });

  // A withdrawn dog stays listed but can't be bet on, and nor can any pair with it.
  race.runners[0].status = "withdrawn";
  const [w, f] = raceMarkets(race);
  assert.equal(w.selections[0].withdrawn, true);
  assert.equal(f.selections.filter((s) => s.withdrawn).length, 18);
});

test("a result is read in finishing order, dead heats included", () => {
  const race = parseRace(results[2]); // Doncaster: a dead heat for 3rd
  assert.equal(race.result.final, true);
  assert.deepEqual(race.result.positions.map((p) => p.position), [1, 2, 3, 3, 5, 6]);
  assert.equal(race.result.positions[0].sp, null, "no starting prices on the sandbox key");
});

const result = (positions, forecastDividend = 12.4) => ({ final: true, positions: positions.map(([dogId, position, sp]) => ({ dogId, position, sp })), forecastDividend });

test("Winner and Forecast are graded from the finishing order", () => {
  const r = result([[1, 1, 3.5], [2, 2, 5], [3, 3, 8], [4, 4, 2]]);
  assert.equal(gradeRace("race_winner", dogKey(1), r, false), "WON");
  assert.equal(gradeRace("race_winner", dogKey(4), r, false), "LOST", "the favourite came 4th");
  assert.equal(gradeRace("race_winner", dogKey(9), r, false), "LOST", "ran but didn't finish");
  assert.equal(gradeRace("race_forecast", forecastKey(1, 2), r, false), "WON");
  assert.equal(gradeRace("race_forecast", forecastKey(2, 1), r, false), "LOST", "the right dogs in the wrong order");
  assert.equal(gradeRace("race_winner", dogKey(1), { ...r, final: false }, false), null, "a provisional result waits");
});

test("withdrawn dogs are void; a dead heat splits a Winner and holds a Forecast for Super Admin", () => {
  const r = result([[1, 1, 3.5], [2, 2, 5]]);
  assert.equal(gradeRace("race_winner", dogKey(5), r, true), "VOID");
  assert.equal(gradeRace("race_forecast", forecastKey(1, 5), r, true), "VOID");
  const heat = result([[1, 1, 4], [2, 1, 6], [3, 3, 9]]);
  assert.equal(gradeRace("race_winner", dogKey(1), heat, false), "WON");
  assert.equal(gradeRace("race_winner", dogKey(2), heat, false), "WON");
  assert.equal(gradeRace("race_forecast", forecastKey(1, 2), heat, false), null);
  assert.equal(raceSettlePrice("race_winner", dogKey(2), heat, 0, 51), 3, "6.00 on half the stake: 3.00");
});

test("a winning race bet is paid at the SP or dividend, less the margin, never above the cap", () => {
  const r = result([[1, 1, 3.5], [2, 2, 80]], 950);
  assert.equal(raceSettlePrice("race_winner", dogKey(1), r, 5, RACE_CAP.race_winner), 3.32, "3.50 less 5%");
  assert.equal(raceSettlePrice("race_winner", dogKey(2), result([[2, 1, 80]]), 5, RACE_CAP.race_winner), 51, "an 80/1 winner is paid at the 50/1 ceiling");
  assert.equal(raceSettlePrice("race_forecast", forecastKey(1, 2), r, 0, RACE_CAP.race_forecast), 500);
  assert.equal(raceSettlePrice("race_forecast", forecastKey(1, 2), result([[1, 1, 3.5]], 12.4), 10, 500), 11.16);
  assert.equal(raceSettlePrice("race_winner", dogKey(1), result([[1, 1, null]]), 5, 51), null, "no SP yet: it waits");
});

test("race bets close a minute before the start and are quoted as SP", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  const race = { sport: "greyhounds", status: "UPCOMING", startsAt: new Date("2026-10-04T12:00:50Z"), suspended: false, hidden: false, liveStopped: false, liveOddsAt: null };
  assert.equal(eventOpen(race, now), false);
  assert.equal(eventOpen({ ...race, startsAt: new Date("2026-10-04T12:01:30Z") }, now), true);
  const quote = selectionQuote({ event: { ...race, startsAt: new Date("2026-10-04T12:05:00Z") }, market: { liveSuspended: false }, selection: { feedOdds: 0, liveOdds: null, result: null }, baseMargin: 5, ownerMargin: 0, override: null, now });
  assert.deepEqual(quote, { price: 0, bettable: true, live: false, suspended: false });
});
