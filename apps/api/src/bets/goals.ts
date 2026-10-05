import { SelectionResult } from "@prisma/client";

/**
 * The goal-event markets: first and last team to score, winning from behind,
 * and the goalscorer markets. They settle on the match's goals in order and
 * on who took part, which the feed sends after full time (see
 * OddsSyncService.syncGoals) and Event.resultGoals keeps.
 *
 * The rules, the usual bookmaker ones:
 * - Only the 90 minutes and stoppage time count, never extra time.
 * - Own goals count for the team they're given to, never for a goalscorer.
 * - A goalscorer bet on a player who didn't take part is void (stake back),
 *   and so is a first-goalscorer bet on a player who came on after the first
 *   goal. Anyone who took part can be the anytime or last goalscorer.
 * - "No goalscorer" wins when no player scored (0–0, or own goals only).
 * - A name that can't be matched for sure to one player waits for Super
 *   Admin instead of settling on a guess.
 */

export type Side = "home" | "away";

export type Goal = {
  /** The minute, stoppage time not added: a goal at 90+3 is 90. */
  minute: number;
  /** The team the goal counts for: the other team's for an own goal. */
  side: Side;
  /** Who put it in, as the feed names them; the player's own team for an own goal. */
  playerId: number | null;
  player: string | null;
  ownGoal: boolean;
  penalty: boolean;
  /** Position in the match's events, so a goal and a substitution in the same minute keep their order. */
  at: number;
};

export type Participant = {
  id: number;
  side: Side;
  /** Every way the feed spelt this player's name (lineups, events, player stats). */
  names: string[];
  /** Started, or came on. */
  played: boolean;
  /** Where in the match's events they came on; null for a starter or one who didn't play. */
  cameOnAt: number | null;
};

export type GoalRecord = {
  goals: Goal[];
  /** Everyone in the matchday squads, or null when the feed sent no lineups. */
  players: Participant[] | null;
};

export const GOAL_MARKET_KEYS = ["first_team_score", "last_team_score", "win_from_behind", "scorer_anytime", "scorer_first", "scorer_last"];

export const isGoalMarket = (marketKey: string) => GOAL_MARKET_KEYS.includes(marketKey);

/** The goals add up to the score the match settles on; otherwise the record can't be trusted (a goal ruled out, a corrected score). */
export function matchesScore(record: GoalRecord, home: number, away: number): boolean {
  return record.goals.filter((g) => g.side === "home").length === home && record.goals.filter((g) => g.side === "away").length === away;
}

/**
 * Grades one outcome of a goal-event market. `selectionName` is the outcome's
 * name (the player, for a goalscorer market) and `marketNames` every outcome's
 * name in that market. Null means it can't be settled from what's known.
 */
export function gradeGoalMarket(
  marketKey: string,
  selectionKey: string,
  record: GoalRecord | null,
  score: { home: number; away: number },
  selectionName = "",
  marketNames: string[] = [],
): SelectionResult | null {
  if (!record || !matchesScore(record, score.home, score.away)) return null;
  const won = (yes: boolean) => (yes ? SelectionResult.WON : SelectionResult.LOST);
  const { goals } = record;

  switch (marketKey) {
    case "first_team_score":
    case "last_team_score": {
      const goal = marketKey === "first_team_score" ? goals[0] : goals[goals.length - 1];
      if (selectionKey === "none") return won(!goal);
      if (selectionKey !== "home" && selectionKey !== "away") return null;
      return won(goal?.side === selectionKey);
    }
    case "win_from_behind": {
      if (selectionKey !== "home" && selectionKey !== "away") return null;
      const other = selectionKey === "home" ? "away" : "home";
      let mine = 0;
      let theirs = 0;
      let behind = false;
      for (const goal of goals) {
        if (goal.side === selectionKey) mine++;
        else theirs++;
        if (theirs > mine) behind = true;
      }
      return won(behind && score[selectionKey] > score[other]);
    }
  }

  if (!marketKey.startsWith("scorer_")) return null;
  // Own goals never count for a goalscorer.
  const scored = goals.filter((g) => !g.ownGoal);
  const first = scored[0];
  const last = scored[scored.length - 1];
  if (selectionKey === "none") {
    if (marketKey === "scorer_anytime") return null;
    return won(scored.length === 0);
  }

  const players = record.players;
  if (players) {
    const found = matchPlayer(selectionName, players);
    if (found === "ambiguous") return null;
    if (found === null) {
      // Not in either squad: void, but only when every goal's scorer is a
      // player this market names, so it can't be the scorer under another spelling.
      const accounted = scored.every((goal) => {
        const scorer = players.find((p) => p.id === goal.playerId);
        return scorer !== undefined && marketNames.some((name) => name !== selectionName && sameOrNull(matchPlayer(name, players), scorer.id));
      });
      return accounted ? SelectionResult.VOID : null;
    }
    if (!found.played) return SelectionResult.VOID;
    switch (marketKey) {
      case "scorer_anytime":
        return won(scored.some((g) => g.playerId === found.id));
      case "scorer_first":
        if (first && found.cameOnAt !== null && found.cameOnAt > first.at) return SelectionResult.VOID;
        return won(first?.playerId === found.id);
      case "scorer_last":
        return won(last?.playerId === found.id);
      default:
        return null;
    }
  }

  // No lineups: only a goal the player is named for settles anything.
  const scorers: Participant[] = scored
    .filter((g) => g.playerId !== null && g.player)
    .map((g) => ({ id: g.playerId!, side: g.side, names: [g.player!], played: true, cameOnAt: null }));
  const found = matchPlayer(selectionName, scorers);
  if (found === null || found === "ambiguous") return null;
  switch (marketKey) {
    case "scorer_anytime":
      return SelectionResult.WON;
    case "scorer_first":
      return first?.playerId === found.id ? SelectionResult.WON : null;
    case "scorer_last":
      return last?.playerId === found.id ? SelectionResult.WON : null;
    default:
      return null;
  }
}

const sameOrNull = (found: Participant | "ambiguous" | null, id: number) => found !== null && found !== "ambiguous" && found.id === id;

/** A name in plain lowercase words: "Agustín Sant'Anna" → ["agustin", "sant", "anna"]. */
export function nameWords(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Finds the player a bookmaker's name means among the squads. The feed spells
 * the same player differently in different places ("Memphis Depay",
 * "M. Depay"), so it tries, from surest to loosest, and stops at the first
 * step that finds anyone:
 *   1. the same name;
 *   2. the same surname and first initial ("K. Serna" for "Kevin Serna");
 *   3. one name that is a word of the other ("Hulk", "Pedro" for "Pedro Raul" only if no closer match);
 *   4. the same surname alone.
 * A step that finds two different players is "ambiguous".
 */
export function matchPlayer(name: string, players: Participant[]): Participant | "ambiguous" | null {
  const wanted = nameWords(name);
  if (wanted.length === 0) return null;
  const joined = wanted.join(" ");
  const surname = wanted[wanted.length - 1];
  const steps: Array<(words: string[]) => boolean> = [
    (words) => words.join(" ") === joined,
    (words) => words.length >= 2 && words[words.length - 1] === surname && words[0][0] === wanted[0][0] && (words[0].length === 1 || wanted[0].length === 1 || words[0] === wanted[0]),
    (words) => (words.length === 1 && wanted.includes(words[0])) || (wanted.length === 1 && words.includes(wanted[0])),
    (words) => words.length >= 2 && wanted.length >= 2 && words[words.length - 1] === surname,
  ];
  for (const step of steps) {
    const hits = new Map<number, Participant>();
    for (const player of players) if (player.names.some((n) => step(nameWords(n)))) hits.set(player.id, player);
    if (hits.size === 1) return [...hits.values()][0];
    if (hits.size > 1) return "ambiguous";
  }
  return null;
}
