import { BetStatus, Prisma, SelectionResult } from "@prisma/client";
import { GoalRecord, gradeGoalMarket, isGoalMarket } from "./goals";

type Score = { home: number; away: number };
/** Corners and cards from the match statistics; every yellow and red counts as one card. */
export type Stats = { cornersHome: number; cornersAway: number; cardsHome: number; cardsAway: number };
type Side = "home" | "draw" | "away";

const sideOf = (score: Score): Side => (score.home > score.away ? "home" : score.home < score.away ? "away" : "draw");

/** What the goal-event markets settle on: the match's goals in order, and the outcome's and its market's names (players, for a goalscorer market). */
export type GoalsInput = { record: GoalRecord | null; selectionName: string; marketNames: string[] };

/**
 * Whether a selection won, from the 90-minute score, plus the half-time score
 * for the half markets, the match statistics for corners and cards, and the
 * goals in order for the goal-event markets. Returns null for a market we
 * don't know how to grade, or one whose numbers aren't known yet; its bets
 * stay open for Super Admin.
 */
export function gradeSelection(
  marketKey: string,
  selectionKey: string,
  home: number,
  away: number,
  half: Score | null = null,
  stats: Stats | null = null,
  goals: GoalsInput | null = null,
): SelectionResult | null {
  const full = { home, away };
  const second = half ? { home: home - half.home, away: away - half.away } : null;
  const won = (yes: boolean) => (yes ? SelectionResult.WON : SelectionResult.LOST);
  const total = home + away;

  if (isGoalMarket(marketKey)) return gradeGoalMarket(marketKey, selectionKey, goals?.record ?? null, full, goals?.selectionName, goals?.marketNames);

  // Result and total goals (result_goals_2_5: home_over …), total goals and both teams score (goals_btts_2_5: over_yes …).
  const combo = /^(result_goals|goals_btts)_(\d+)_5$/.exec(marketKey);
  if (combo) {
    const [, kind, whole] = combo;
    const threshold = Number(whole) + 0.5;
    const [left, right] = selectionKey.split("_");
    if (kind === "result_goals") {
      if (!["home", "draw", "away"].includes(left) || !["over", "under"].includes(right)) return null;
      return won(sideOf(full) === left && (total > threshold) === (right === "over"));
    }
    if (!["over", "under"].includes(left) || !["yes", "no"].includes(right)) return null;
    return won((total > threshold) === (left === "over") && (home > 0 && away > 0) === (right === "yes"));
  }

  // Corners: who takes the most, and the total in bands (u6, 6-8, o14).
  if (marketKey === "corners_1x2" || marketKey === "corners_range") {
    if (!stats) return null;
    if (marketKey === "corners_1x2") return result(selectionKey, { home: stats.cornersHome, away: stats.cornersAway });
    return inRange(selectionKey, stats.cornersHome + stats.cornersAway);
  }

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

  // Handicaps: ah_m1_5 (Asian, home/away), eh_p1 (European, home/draw/away), on the
  // 90 minutes, the 1st half (h1_), the 2nd half (h2_, handball) or corners. The line is the home team's.
  const handicap = /^(ah|eh|h1_ah|h1_eh|h2_ah|h2_eh|corners_ah)_(m|p)?(\d+)(?:_(\d))?$/.exec(marketKey);
  if (handicap) {
    const [, kind, sign, whole, tenth] = handicap;
    const line = (sign === "m" ? -1 : 1) * Number(`${whole}.${tenth ?? 0}`);
    const score = kind.startsWith("h1") ? half : kind.startsWith("h2") ? second : kind === "corners_ah" ? (stats ? { home: stats.cornersHome, away: stats.cornersAway } : null) : full;
    if (!score) return null;
    const margin = score.home + line - score.away;
    if (kind.endsWith("eh")) return result(selectionKey, { home: margin, away: 0 });
    if (selectionKey !== "home" && selectionKey !== "away") return null;
    return won(selectionKey === "home" ? margin > 0 : margin < 0);
  }

  // Over/under lines: goals_1_5, home_goals_0_5, h1_goals_1_5, h2_goals_2_5, h1_home_goals_0_5 …
  const line = /^(goals|home_goals|away_goals|h1_goals|h2_goals|h1_home_goals|h1_away_goals|h2_home_goals|h2_away_goals)_(\d+)_5$/.exec(marketKey);
  if (line) {
    const [, scope, whole] = line;
    const threshold = Number(whole) + 0.5;
    const score = scope.startsWith("h1") ? half : scope.startsWith("h2") ? second : full;
    if (!score) return null;
    const goals = scope.endsWith("home_goals") ? score.home : scope.endsWith("away_goals") ? score.away : score.home + score.away;
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
      return exactCount(selectionKey, total);
    case "odd_even":
      return oddEven(selectionKey, total);
    case "clean_sheet_home":
      return yesNo(selectionKey, away === 0);
    case "clean_sheet_away":
      return yesNo(selectionKey, home === 0);
    case "home_scores":
      return yesNo(selectionKey, home > 0);
    case "away_scores":
      return yesNo(selectionKey, away > 0);
    case "win_to_nil_home":
      return yesNo(selectionKey, home > away && away === 0);
    case "win_to_nil_away":
      return yesNo(selectionKey, away > home && home === 0);
    case "win_to_nil":
      if (selectionKey === "home") return won(home > away && away === 0);
      if (selectionKey === "away") return won(away > home && home === 0);
      return null;
    case "home_exact_goals":
      return exactCount(selectionKey, home);
    case "away_exact_goals":
      return exactCount(selectionKey, away);
    case "home_odd_even":
      return oddEven(selectionKey, home);
    case "away_odd_even":
      return oddEven(selectionKey, away);
    case "goal_range":
      if (selectionKey === "0-1") return won(total <= 1);
      if (selectionKey === "2-3") return won(total === 2 || total === 3);
      if (selectionKey === "4+") return won(total >= 4);
      return null;
    case "winning_margin": {
      if (selectionKey === "no_goal") return won(total === 0);
      if (selectionKey === "score_draw") return won(home === away && total > 0);
      const margin = /^(home|away)_(\d)(\+?)$/.exec(selectionKey);
      if (!margin) return null;
      const [, side, by, more] = margin;
      const actual = side === "home" ? home - away : away - home;
      return won(more ? actual >= Number(by) : actual === Number(by));
    }
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
    case "h1_draw_no_bet":
    case "h2_draw_no_bet": {
      if (selectionKey !== "home" && selectionKey !== "away") return null;
      const score = marketKey === "h1_draw_no_bet" ? half : second;
      return sideOf(score) === "draw" ? SelectionResult.VOID : won(sideOf(score) === selectionKey);
    }
    case "h1_double_chance":
      return doubleChance(selectionKey, half);
    case "h1_btts":
      return bothScore(selectionKey, half);
    case "h1_correct_score":
      return correctScore(selectionKey, half);
    case "h2_winner":
      return result(selectionKey, second);
    case "h2_double_chance":
      return doubleChance(selectionKey, second);
    case "home_win_both_halves":
      return yesNo(selectionKey, sideOf(half) === "home" && sideOf(second) === "home");
    case "away_win_both_halves":
      return yesNo(selectionKey, sideOf(half) === "away" && sideOf(second) === "away");
    case "h2_btts":
      return bothScore(selectionKey, second);
    case "ht_ft": {
      const [ht, ft] = selectionKey.split("_");
      if (!["home", "draw", "away"].includes(ht) || !["home", "draw", "away"].includes(ft)) return null;
      return won(sideOf(half) === ht && sideOf(full) === ft);
    }
    case "h1_exact_goals":
      return exactCount(selectionKey, half.home + half.away);
    case "h2_exact_goals":
      return exactCount(selectionKey, second.home + second.away);
    case "h1_odd_even":
      return oddEven(selectionKey, half.home + half.away);
    case "h2_odd_even":
      return oddEven(selectionKey, second.home + second.away);
    case "score_both_halves":
      if (selectionKey !== "home" && selectionKey !== "away") return null;
      return won(half[selectionKey] > 0 && second[selectionKey] > 0);
    case "home_highest_half":
    case "away_highest_half": {
      const side = marketKey === "home_highest_half" ? "home" : "away";
      const actual = half[side] > second[side] ? "first" : half[side] < second[side] ? "second" : "equal";
      return ["first", "second", "equal"].includes(selectionKey) ? won(actual === selectionKey) : null;
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

/** An exact count: "0", "1", … or "N+" for N or more. */
function exactCount(selectionKey: string, count: number): SelectionResult | null {
  const match = /^(\d+)(\+?)$/.exec(selectionKey);
  if (!match) return null;
  const n = Number(match[1]);
  return (match[2] ? count >= n : count === n) ? SelectionResult.WON : SelectionResult.LOST;
}

function oddEven(selectionKey: string, count: number): SelectionResult | null {
  if (selectionKey === "odd") return count % 2 === 1 ? SelectionResult.WON : SelectionResult.LOST;
  if (selectionKey === "even") return count % 2 === 0 ? SelectionResult.WON : SelectionResult.LOST;
  return null;
}

/** A band of a count: "u6" is under 6, "6-8" from 6 to 8, "o14" over 14. */
function inRange(selectionKey: string, count: number): SelectionResult | null {
  const under = /^u(\d+)$/.exec(selectionKey);
  const over = /^o(\d+)$/.exec(selectionKey);
  const band = /^(\d+)-(\d+)$/.exec(selectionKey);
  const hit = under ? count < Number(under[1]) : over ? count > Number(over[1]) : band ? count >= Number(band[1]) && count <= Number(band[2]) : null;
  if (hit === null) return null;
  return hit ? SelectionResult.WON : SelectionResult.LOST;
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
