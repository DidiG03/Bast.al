import { BetStatus, Prisma, SelectionResult } from "@prisma/client";

type Score = { home: number; away: number };
/** Corners and cards from the match statistics; every yellow and red counts as one card. */
export type Stats = { cornersHome: number; cornersAway: number; cardsHome: number; cardsAway: number };
type Side = "home" | "draw" | "away";

const sideOf = (score: Score): Side => (score.home > score.away ? "home" : score.home < score.away ? "away" : "draw");

/**
 * Whether a selection won, from the 90-minute score, plus the half-time score
 * for the half markets. Returns null for a market we don't know how to grade,
 * or a half market with no half-time score; its bets stay open for Super Admin.
 */
export function gradeSelection(
  marketKey: string,
  selectionKey: string,
  home: number,
  away: number,
  half: Score | null = null,
  stats: Stats | null = null,
): SelectionResult | null {
  const full = { home, away };
  const second = half ? { home: home - half.home, away: away - half.away } : null;
  const won = (yes: boolean) => (yes ? SelectionResult.WON : SelectionResult.LOST);
  const total = home + away;

  // Corners and cards: corners_9_5, home_corners_4_5, cards_3_5, away_cards_1_5 …
  const counted = /^(corners|home_corners|away_corners|cards|home_cards|away_cards)_(\d+)_5$/.exec(marketKey);
  if (counted) {
    if (!stats) return null;
    const [, scope, whole] = counted;
    const threshold = Number(whole) + 0.5;
    const corners = scope.endsWith("corners");
    const homeCount = corners ? stats.cornersHome : stats.cardsHome;
    const awayCount = corners ? stats.cornersAway : stats.cardsAway;
    const count = scope.startsWith("home") ? homeCount : scope.startsWith("away") ? awayCount : homeCount + awayCount;
    if (selectionKey === "over") return won(count > threshold);
    if (selectionKey === "under") return won(count < threshold);
    return null;
  }

  // Over/under lines: goals_1_5, home_goals_0_5, h1_goals_1_5, h2_goals_2_5 …
  const line = /^(goals|home_goals|away_goals|h1_goals|h2_goals)_(\d+)_5$/.exec(marketKey);
  if (line) {
    const [, scope, whole] = line;
    const threshold = Number(whole) + 0.5;
    const score = scope.startsWith("h1") ? half : scope.startsWith("h2") ? second : full;
    if (!score) return null;
    const goals = scope === "home_goals" ? score.home : scope === "away_goals" ? score.away : score.home + score.away;
    if (selectionKey === "over") return won(goals > threshold);
    if (selectionKey === "under") return won(goals < threshold);
    return null;
  }

  switch (marketKey) {
    case "match_winner":
      return result(selectionKey, full);
    case "double_chance":
      return doubleChance(selectionKey, full);
    case "btts":
      return bothScore(selectionKey, full);
    case "draw_no_bet":
      if (selectionKey !== "home" && selectionKey !== "away") return null;
      return sideOf(full) === "draw" ? SelectionResult.VOID : won(sideOf(full) === selectionKey);
    case "correct_score":
      return correctScore(selectionKey, full);
    case "exact_goals":
      if (selectionKey === "7+") return won(total >= 7);
      return /^\d$/.test(selectionKey) ? won(total === Number(selectionKey)) : null;
    case "odd_even":
      if (selectionKey === "odd") return won(total % 2 === 1);
      if (selectionKey === "even") return won(total % 2 === 0);
      return null;
    case "clean_sheet_home":
      return yesNo(selectionKey, away === 0);
    case "clean_sheet_away":
      return yesNo(selectionKey, home === 0);
    case "win_to_nil":
      if (selectionKey === "home") return won(home > away && away === 0);
      if (selectionKey === "away") return won(away > home && home === 0);
      return null;
    case "result_btts": {
      const [side, btts] = selectionKey.split("_");
      if (!["home", "draw", "away"].includes(side) || !["yes", "no"].includes(btts)) return null;
      return won(sideOf(full) === side && (home > 0 && away > 0) === (btts === "yes"));
    }
  }

  // Everything below needs the half-time score.
  if (!half || !second) return null;
  switch (marketKey) {
    case "h1_winner":
      return result(selectionKey, half);
    case "h1_double_chance":
      return doubleChance(selectionKey, half);
    case "h1_btts":
      return bothScore(selectionKey, half);
    case "h1_correct_score":
      return correctScore(selectionKey, half);
    case "h2_winner":
      return result(selectionKey, second);
    case "h2_btts":
      return bothScore(selectionKey, second);
    case "ht_ft": {
      const [ht, ft] = selectionKey.split("_");
      if (!["home", "draw", "away"].includes(ht) || !["home", "draw", "away"].includes(ft)) return null;
      return won(sideOf(half) === ht && sideOf(full) === ft);
    }
    case "highest_half": {
      const first = half.home + half.away;
      const later = second.home + second.away;
      const actual = first > later ? "first" : first < later ? "second" : "equal";
      return ["first", "second", "equal"].includes(selectionKey) ? won(actual === selectionKey) : null;
    }
    case "win_both_halves":
      if (selectionKey !== "home" && selectionKey !== "away") return null;
      return won(sideOf(half) === selectionKey && sideOf(second) === selectionKey);
    case "win_either_half":
      if (selectionKey !== "home" && selectionKey !== "away") return null;
      return won(sideOf(half) === selectionKey || sideOf(second) === selectionKey);
    default:
      return null;
  }
}

function result(selectionKey: string, score: Score): SelectionResult | null {
  if (!["home", "draw", "away"].includes(selectionKey)) return null;
  return sideOf(score) === selectionKey ? SelectionResult.WON : SelectionResult.LOST;
}

function doubleChance(selectionKey: string, score: Score): SelectionResult | null {
  const covers: Record<string, Side[]> = { home_draw: ["home", "draw"], home_away: ["home", "away"], draw_away: ["draw", "away"] };
  if (!covers[selectionKey]) return null;
  return covers[selectionKey].includes(sideOf(score)) ? SelectionResult.WON : SelectionResult.LOST;
}

function bothScore(selectionKey: string, score: Score): SelectionResult | null {
  return yesNo(selectionKey, score.home > 0 && score.away > 0);
}

function yesNo(selectionKey: string, happened: boolean): SelectionResult | null {
  if (selectionKey === "yes") return happened ? SelectionResult.WON : SelectionResult.LOST;
  if (selectionKey === "no") return happened ? SelectionResult.LOST : SelectionResult.WON;
  return null;
}

function correctScore(selectionKey: string, score: Score): SelectionResult | null {
  const match = /^(\d+)-(\d+)$/.exec(selectionKey);
  if (!match) return null;
  return Number(match[1]) === score.home && Number(match[2]) === score.away ? SelectionResult.WON : SelectionResult.LOST;
}

/**
 * What a bet pays back, stake included: stake x odds for a win (rounded
 * down to the cent), the stake for a void, nothing for a loss.
 */
export function payoutFor(status: BetStatus, stake: Prisma.Decimal, odds: Prisma.Decimal): Prisma.Decimal {
  if (status === BetStatus.WON) return stake.mul(odds).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  if (status === BetStatus.VOID) return stake;
  return new Prisma.Decimal(0);
}

/** Multiplies leg prices and rounds down to the cent, so the price shown is never more than what's paid. */
export function combinedOdds(odds: Prisma.Decimal[]): Prisma.Decimal {
  return odds.reduce((product, price) => product.mul(price), new Prisma.Decimal(1)).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
}

/**
 * Where an accumulator stands from its legs: lost as soon as any leg loses,
 * open while any leg is undecided, void if every leg is void, otherwise won
 * at the combined price of the legs that weren't void.
 */
export function accumulatorOutcome(legs: Array<{ odds: Prisma.Decimal; result: SelectionResult | null }>): { status: BetStatus; odds: Prisma.Decimal } {
  const live = legs.filter((leg) => leg.result !== SelectionResult.VOID);
  const odds = combinedOdds(live.map((leg) => leg.odds));
  if (legs.some((leg) => leg.result === SelectionResult.LOST)) return { status: BetStatus.LOST, odds };
  if (legs.some((leg) => leg.result === null)) return { status: BetStatus.OPEN, odds };
  if (live.length === 0) return { status: BetStatus.VOID, odds: new Prisma.Decimal(1) };
  return { status: BetStatus.WON, odds };
}
