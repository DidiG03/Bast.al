import { SelectionResult } from "@prisma/client";

/**
 * MMA from API-Sports (the same account as API-Football, its own quota):
 * fights with their card, weight class and fighters, bookmaker odds, and
 * each fight's result (who won, how, in which round and at what time).
 *
 * Markets, at fixed prices like football:
 * - Fight winner: either fighter. A draw or no contest is void.
 * - Fight result: either fighter or a draw. A no contest is void.
 * - Total rounds over/under X.5: "Over 1.5" wins when the fight goes past
 *   2:30 of round 2 (1.5 rounds of 5 minutes). A no contest is void.
 * - Fight goes the distance (when the bookmaker prices it): yes when it went
 *   to the judges. A no contest is void.
 * Bets on every fight of a card close when the card's first fight starts.
 */

export const MMA_PROVIDER = "api-sports-mma";
/** A round is 5 minutes in every promotion the feed covers. */
const ROUND_MINUTES = 5;

export type FightStatus = "upcoming" | "live" | "finished" | "postponed" | "cancelled";

export type FeedFight = {
  externalId: string;
  /** The card, e.g. "UFC 332: Silva vs. Wang". */
  card: string;
  weightClass: string | null;
  home: string;
  away: string;
  startsAt: Date;
  status: FightStatus;
  /** Set once the fight is over: the winner flags from the feed. */
  winner: "home" | "away" | null;
};

/** What Event.fightResult keeps once a fight is over. */
export type FightResult = {
  outcome: "home" | "away" | "draw" | "no_contest";
  /** As the feed says it: "KO", "Submission", "Points" (a decision), … */
  method: string | null;
  round: number | null;
  /** Time into the round it ended, "3:12". */
  time: string | null;
};

type RawFighter = { id?: number; name?: string; winner?: boolean | null };
export type RawFight = {
  id: number;
  date?: string;
  slug?: string;
  category?: string | null;
  status?: { short?: string; long?: string };
  fighters?: { first?: RawFighter; second?: RawFighter };
};
export type RawFightResult = { fight?: { id?: number }; won_type?: string | null; round?: number | null; minute?: string | null };
type RawOdds = { fight?: { id?: number }; bookmakers?: Array<{ id: number; name: string; bets?: Array<{ id: number; name: string | null; values?: Array<{ value: string; odd: string }> }> }> };

const UPCOMING = new Set(["NS", "TBD"]);
const POSTPONED = new Set(["PST"]);
const CANCELLED = new Set(["CANC", "ABD", "WO"]);

export function parseFight(raw: RawFight): FeedFight | null {
  const startsAt = new Date(raw.date ?? "");
  const home = raw.fighters?.first?.name?.trim();
  const away = raw.fighters?.second?.name?.trim();
  if (!raw.id || Number.isNaN(startsAt.getTime()) || !home || !away) return null;
  const short = raw.status?.short ?? "NS";
  const status: FightStatus = short === "FT" ? "finished" : UPCOMING.has(short) ? "upcoming" : POSTPONED.has(short) ? "postponed" : CANCELLED.has(short) ? "cancelled" : "live";
  return {
    externalId: String(raw.id),
    card: raw.slug?.trim() || "MMA",
    weightClass: raw.category?.trim() || null,
    home,
    away,
    startsAt,
    status,
    winner: raw.fighters?.first?.winner ? "home" : raw.fighters?.second?.winner ? "away" : null,
  };
}

/** How long a finished fight waits for its result details (method, round, time) before settling on the winner alone. */
export const DETAILS_WAIT_MS = 6 * 3_600_000;

/**
 * A finished fight's result, from its winner flags and the feed's result
 * details. Without the details it waits (the round bets need them), unless
 * they still haven't come DETAILS_WAIT_MS after the fight: then the winner
 * settles the winner markets and the round bets wait for Super Admin.
 */
export function fightResult(fight: FeedFight, details: RawFightResult | undefined, now = new Date()): FightResult | null {
  if (fight.status !== "finished") return null;
  if (!details && (!fight.winner || now.getTime() - fight.startsAt.getTime() < DETAILS_WAIT_MS)) return null;
  const method = details?.won_type?.trim() || null;
  const noContest = /no.?contest|^nc$/i.test(method ?? "");
  return {
    outcome: noContest ? "no_contest" : fight.winner ?? "draw",
    method,
    round: details?.round ?? null,
    time: details?.minute?.trim() || null,
  };
}

/** Minutes the fight lasted, from the round and the time into it; null if unknown. */
export function fightMinutes(result: FightResult): number | null {
  if (!result.round) return null;
  const match = /^(\d+):(\d{2})$/.exec(result.time ?? "");
  if (!match) return null;
  return (result.round - 1) * ROUND_MINUTES + Number(match[1]) + Number(match[2]) / 60;
}

export type FightMarket = { key: string; name: string; sortOrder: number; selections: Array<{ key: string; name: string; odds: number; sortOrder: number }> };

/**
 * The fight's markets from one bookmaker's prices (the chosen one, else the
 * first that has each bet). Outcomes the feed calls Home and Away are the
 * fighters in the order the feed lists them.
 */
export function parseFightOdds(raw: RawOdds, home: string, away: string, bookmakerId: number): FightMarket[] {
  const books = [...(raw.bookmakers ?? [])].sort((a, b) => (a.id === bookmakerId ? -1 : b.id === bookmakerId ? 1 : 0));
  const bet = (name: string) => books.flatMap((book) => book.bets ?? []).find((b) => b.name === name)?.values ?? null;
  const price = (odd: string) => {
    const n = Number(odd);
    return Number.isFinite(n) && n > 1 ? Math.round(n * 100) / 100 : null;
  };
  const markets: FightMarket[] = [];
  const pick = (values: Array<{ value: string; odd: string }>, wanted: Array<[string, string, string]>) =>
    wanted.flatMap(([feed, key, name], sortOrder) => {
      const value = values.find((v) => v.value === feed);
      const odds = value ? price(value.odd) : null;
      return odds ? [{ key, name, odds, sortOrder }] : [];
    });

  const winner = bet("Home/Away");
  if (winner) {
    const selections = pick(winner, [["Home", "home", home], ["Away", "away", away]]);
    if (selections.length === 2) markets.push({ key: "fight_winner", name: "Fight winner", sortOrder: 0, selections });
  }
  const threeWay = bet("3Way Result");
  if (threeWay) {
    const selections = pick(threeWay, [["Home", "home", home], ["Draw", "draw", "Draw"], ["Away", "away", away]]);
    if (selections.length === 3) markets.push({ key: "fight_result", name: "Fight result", sortOrder: 1, selections });
  }
  const totals = bet("Over/Under");
  if (totals) {
    const lines = [...new Set(totals.map((v) => /^(?:Over|Under) (\d+\.5)$/.exec(v.value)?.[1]).filter((l): l is string => Boolean(l)))].sort((a, b) => Number(a) - Number(b));
    for (const line of lines) {
      const selections = pick(totals, [[`Over ${line}`, "over", `Over ${line} rounds`], [`Under ${line}`, "under", `Under ${line} rounds`]]);
      if (selections.length === 2) markets.push({ key: `rounds_${line.replace(".", "_")}`, name: `Total rounds ${line}`, sortOrder: 10 + Number(line), selections });
    }
  }
  const distance = bet("Fight To Go the Distance");
  if (distance) {
    const selections = pick(distance, [["Yes", "yes", "Yes"], ["No", "no", "No"]]);
    if (selections.length === 2) markets.push({ key: "fight_distance", name: "Fight goes the distance", sortOrder: 5, selections });
  }
  return markets;
}

export const isFightMarket = (marketKey: string) => marketKey.startsWith("fight_") || /^rounds_\d+_5$/.test(marketKey);

/** One fight outcome's result; null when it can't be settled from what's known. */
export function gradeFight(marketKey: string, selectionKey: string, result: FightResult | null): SelectionResult | null {
  if (!result) return null;
  const won = (yes: boolean) => (yes ? SelectionResult.WON : SelectionResult.LOST);
  if (result.outcome === "no_contest") return SelectionResult.VOID;
  if (marketKey === "fight_winner") return result.outcome === "draw" ? SelectionResult.VOID : won(result.outcome === selectionKey);
  if (marketKey === "fight_result") return won(result.outcome === selectionKey);
  if (marketKey === "fight_distance") {
    if (!result.method) return null;
    return won(/points|decision/i.test(result.method) === (selectionKey === "yes"));
  }
  const line = /^rounds_(\d+)_5$/.exec(marketKey);
  if (line) {
    const minutes = fightMinutes(result);
    if (minutes === null) return null;
    const over = minutes > (Number(line[1]) + 0.5) * ROUND_MINUTES;
    return won(over === (selectionKey === "over"));
  }
  return null;
}

export function fightResultOf(value: unknown): FightResult | null {
  if (!value || typeof value !== "object" || !("outcome" in value)) return null;
  return value as FightResult;
}
