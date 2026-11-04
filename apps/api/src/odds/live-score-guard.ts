/**
 * Live markets that can't take a bet at the current score, because what we
 * settle them on would already be known, or would differ from what the price
 * was made for:
 *
 * - First team to score, first goalscorer, and the Nth goal once N goals are
 *   in: their answer is decided. The feed should stop pricing them; this
 *   makes sure a late price never goes through.
 * - Asian and 3-way handicaps: in play, the bookmaker's prices (bet365 via
 *   API-Football) are for the rest of the match (goals from the bet on),
 *   while we settle handicaps on the whole match's score. The two agree only
 *   while the score is level, so that's the only time they take bets: the
 *   whole match's handicaps at a level score, the 1st half's during the 1st
 *   half at a level score. Second-half and corner handicaps never do live (we
 *   don't keep the half-time score or the corner count to check them against).
 */
export function liveScoreBlocked(marketKey: string, score: { home: number | null | undefined; away: number | null | undefined }, period: string | null | undefined): boolean {
  const guarded = /^(first_team_score|scorer_first|nth_goal_\d+|(ah|eh|h1_ah|h1_eh|h2_ah|h2_eh|corners_ah)_.+)$/.test(marketKey);
  if (!guarded) return false;
  if (/^(h2_ah|h2_eh|corners_ah)_/.test(marketKey)) return true;
  const home = score.home;
  const away = score.away;
  // A guarded market at a score we don't know: no bet.
  if (home === null || home === undefined || away === null || away === undefined) return true;
  const total = home + away;
  if (marketKey === "first_team_score" || marketKey === "scorer_first") return total > 0;
  const nth = /^nth_goal_(\d+)$/.exec(marketKey);
  if (nth) return total >= Number(nth[1]);
  if (/^h1_(ah|eh)_/.test(marketKey)) return period !== "1H" || home !== away;
  return home !== away;
}
