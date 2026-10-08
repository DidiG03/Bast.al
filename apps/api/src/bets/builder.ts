import { SelectionResult } from "@prisma/client";
import { isGoalMarket } from "./goals";
import { gradeSelection } from "./grading";

/**
 * The bet builder: several picks from one football match, priced as one bet.
 * Picks from the same match aren't independent (a team that wins a high
 * scoring game has usually scored more than once), so the builder can't
 * multiply their prices like an accumulator does.
 *
 * Instead each match gets a goals model: the home and away goals in each half
 * are independent Poisson counts, 45% of them in the first half, with the
 * two teams' scoring rates fitted to the match's own result (1X2) and total
 * goals 2.5 prices. The model gives the chance of each pick and of all of
 * them together, and the builder's price is the product of the picks' own
 * prices (each with the team's margin or the Owner's price) corrected by how
 * much more, or less, likely they are together than apart:
 *
 *   price = product of the picks' prices × (product of their chances) / (chance of all together)
 *
 * less BUILDER_MARGIN. A single pick would get its own price back, so the
 * model only moves what it's needed for, the link between the picks. Every
 * pick is graded with the same gradeSelection that settles it, on every
 * score the grid holds, so a market the builder can't price (one needing
 * corners, cards or goalscorers, or one that can be void) is refused rather
 * than guessed.
 *
 * Pure: no database. bets.service.ts gives it the prices; the tests and the
 * price check use it as it is.
 */

/** The builder's own margin, in percent, on top of the picks' prices. */
export const BUILDER_MARGIN = 5;
/** Most picks in one builder. */
export const MAX_BUILDER_PICKS = 8;
/** Highest price a builder can have, the same as an accumulator. */
export const MAX_BUILDER_ODDS = 5000;
/** Share of a match's goals scored in the first half. */
export const FIRST_HALF_SHARE = 0.45;
/** Goals per team per half the grid goes up to; more is rare enough to leave out (the rest is scaled up to 1). */
const MAX_GOALS = 7;

export type BuilderLeg = { marketKey: string; selectionKey: string; price: number };
/** The match's result and total goals 2.5 prices, from the feed, to fit the model to. */
export type BuilderAnchor = { home: number; draw: number; away: number; over: number; under: number };

export type BuilderQuote =
  | { ok: true; odds: number; chance: number }
  | { ok: false; reason: "unsupported" | "impossible" | "covered" | "too-low" | "too-high"; leg?: number };

/** One score in the grid: goals in each half, and how likely it is. */
type Cell = { home: number; away: number; half: { home: number; away: number }; p: number };

function poisson(rate: number): number[] {
  const out: number[] = [];
  let term = Math.exp(-rate);
  for (let k = 0; k <= MAX_GOALS; k++) {
    out.push(term);
    term = (term * rate) / (k + 1);
  }
  return out;
}

/** Every score with each half, for these scoring rates, adding up to 1. */
export function scoreGrid(homeRate: number, awayRate: number): Cell[] {
  const h1 = poisson(homeRate * FIRST_HALF_SHARE);
  const a1 = poisson(awayRate * FIRST_HALF_SHARE);
  const h2 = poisson(homeRate * (1 - FIRST_HALF_SHARE));
  const a2 = poisson(awayRate * (1 - FIRST_HALF_SHARE));
  const cells: Cell[] = [];
  let total = 0;
  for (let hh = 0; hh <= MAX_GOALS; hh++)
    for (let ha = 0; ha <= MAX_GOALS; ha++)
      for (let sh = 0; sh <= MAX_GOALS; sh++)
        for (let sa = 0; sa <= MAX_GOALS; sa++) {
          const p = h1[hh] * a1[ha] * h2[sh] * a2[sa];
          if (p < 1e-12) continue;
          cells.push({ home: hh + sh, away: ha + sa, half: { home: hh, away: ha }, p });
          total += p;
        }
  for (const cell of cells) cell.p /= total;
  return cells;
}

/** The full-time chances of a home win, an away win and over 2.5 goals, for these rates. */
function fullTime(homeRate: number, awayRate: number) {
  const h = poisson(homeRate);
  const a = poisson(awayRate);
  let home = 0;
  let away = 0;
  let over = 0;
  for (let x = 0; x <= MAX_GOALS; x++)
    for (let y = 0; y <= MAX_GOALS; y++) {
      const p = h[x] * a[y];
      if (x > y) home += p;
      else if (y > x) away += p;
      if (x + y > 2) over += p;
    }
  return { home, away, over };
}

/**
 * The two teams' scoring rates (goals a match) that best fit the result and
 * total goals prices, with the bookmaker's margin taken out of each market.
 * Null when the prices can't be read.
 */
export function fitRates(anchor: BuilderAnchor): { home: number; away: number } | null {
  const prices = [anchor.home, anchor.draw, anchor.away, anchor.over, anchor.under];
  if (prices.some((price) => !Number.isFinite(price) || price <= 1)) return null;
  const sides = 1 / anchor.home + 1 / anchor.draw + 1 / anchor.away;
  const totals = 1 / anchor.over + 1 / anchor.under;
  const target = { home: 1 / anchor.home / sides, away: 1 / anchor.away / sides, over: 1 / anchor.over / totals };
  const error = (h: number, a: number) => {
    const got = fullTime(h, a);
    return (got.home - target.home) ** 2 + (got.away - target.away) ** 2 + (got.over - target.over) ** 2;
  };
  // A coarse search, then smaller and smaller steps around the best point.
  let best = { h: 1.4, a: 1.1, e: Infinity };
  for (let h = 0.1; h <= 5; h += 0.1)
    for (let a = 0.1; a <= 5; a += 0.1) {
      const e = error(h, a);
      if (e < best.e) best = { h, a, e };
    }
  for (let step = 0.05; step > 0.0005; step /= 2) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const [dh, da] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const h = best.h + dh;
        const a = best.a + da;
        if (h < 0.02 || a < 0.02 || h > 6 || a > 6) continue;
        const e = error(h, a);
        if (e < best.e) {
          best = { h, a, e };
          moved = true;
        }
      }
    }
  }
  return { home: best.h, away: best.a };
}

/**
 * Where each pick stands on each score: won or lost. Null when a pick can't
 * be priced by the builder: a market graded on something other than the
 * score (corners, cards, goalscorers), or one that can be void.
 */
export function gradeOnGrid(legs: Array<Pick<BuilderLeg, "marketKey" | "selectionKey">>, cells: Cell[]): { wins: boolean[][] } | { unsupported: number } {
  const wins: boolean[][] = [];
  for (let i = 0; i < legs.length; i++) {
    const { marketKey, selectionKey } = legs[i];
    if (isGoalMarket(marketKey)) return { unsupported: i };
    const row: boolean[] = [];
    for (const cell of cells) {
      const grade = gradeSelection(marketKey, selectionKey, cell.home, cell.away, cell.half);
      if (grade === null || grade === SelectionResult.VOID) return { unsupported: i };
      row.push(grade === SelectionResult.WON);
    }
    wins.push(row);
  }
  return { wins };
}

/** Whether a market can go in a builder at all (checked on a small grid, as a hint for the match page). */
export function builderMarket(marketKey: string, selectionKeys: string[]): boolean {
  const cells = SAMPLE_GRID();
  return selectionKeys.length > 0 && !("unsupported" in gradeOnGrid(selectionKeys.map((selectionKey) => ({ marketKey, selectionKey })), cells));
}

let sample: Cell[] | null = null;
const SAMPLE_GRID = () => (sample ??= scoreGrid(1.4, 1.1));

/**
 * The builder's price for these picks, or why there isn't one. The legs'
 * `price` is what the Player's team sees for each pick on its own.
 */
export function priceBuilder(legs: BuilderLeg[], anchor: BuilderAnchor, margin = BUILDER_MARGIN): BuilderQuote {
  const rates = fitRates(anchor);
  if (!rates) return { ok: false, reason: "unsupported" };
  const cells = scoreGrid(rates.home, rates.away);
  const graded = gradeOnGrid(legs, cells);
  if ("unsupported" in graded) return { ok: false, reason: "unsupported", leg: graded.unsupported };
  const { wins } = graded;

  const chances = wins.map((row) => row.reduce((sum, won, i) => sum + (won ? cells[i].p : 0), 0));
  let together = 0;
  for (let i = 0; i < cells.length; i++) if (wins.every((row) => row[i])) together += cells[i].p;
  if (together < 1e-7 || chances.some((chance) => chance < 1e-7)) return { ok: false, reason: "impossible" };
  // One pick that wins whenever another does adds nothing (City to win and City win or draw).
  for (let a = 0; a < wins.length; a++)
    for (let b = 0; b < wins.length; b++) {
      if (a === b) continue;
      if (wins[a].every((won, i) => !won || wins[b][i])) return { ok: false, reason: "covered", leg: b };
    }

  const product = legs.reduce((total, leg) => total * leg.price, 1);
  const apart = chances.reduce((total, chance) => total * chance, 1);
  const odds = Math.floor(((product * apart) / together) * (1 - margin / 100) * 100 + 1e-6) / 100;
  if (odds < 1.01) return { ok: false, reason: "too-low" };
  if (odds > MAX_BUILDER_ODDS) return { ok: false, reason: "too-high" };
  return { ok: true, odds, chance: together };
}

/** What a builder pays from its picks' results: lost on any lost pick, open while any is undecided, refunded if any is void, otherwise won at its locked price. */
export function builderOutcome(legs: Array<{ result: SelectionResult | null }>): "WON" | "LOST" | "OPEN" | "VOID" {
  if (legs.some((leg) => leg.result === SelectionResult.LOST)) return "LOST";
  if (legs.some((leg) => leg.result === null)) return "OPEN";
  if (legs.some((leg) => leg.result === SelectionResult.VOID)) return "VOID";
  return "WON";
}
