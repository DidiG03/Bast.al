import { SelectionResult } from "@prisma/client";

/**
 * Tennis from API-Tennis (api-tennis.com): matches with their tournament and
 * round, set-by-set scores, and bookmaker odds.
 *
 * Markets, at fixed prices like football:
 * - Match winner: either player.
 * - 1st set winner: either player.
 * - Set betting: the match's score in sets, e.g. "Sinner 2-1".
 * If a player retires, a market already decided stands (the 1st set winner
 * once the 1st set was finished) and the others are void. A walkover, or a
 * match cancelled, is void.
 */

export const TENNIS_PROVIDER = "api-tennis";
/** Times are asked for in UTC, so they're read as UTC. */
export const TENNIS_TIMEZONE = "UTC";

export type TennisStatus = "upcoming" | "live" | "finished" | "retired" | "postponed" | "cancelled";

/** What Event.fightResult keeps for a tennis match once it's over. */
export type TennisResult = {
  /** Who won or went through (the other player retired). */
  outcome: "home" | "away";
  /** Games in each set, as [home, away]: the last one unfinished when a player retired. */
  sets: Array<[number, number]>;
  /** False when a player retired: only markets already decided are settled. */
  completed: boolean;
};

export type FeedMatch = {
  externalId: string;
  /** "ATP Singles", "WTA Singles", … */
  tour: string;
  tournament: string;
  round: string | null;
  home: string;
  away: string;
  startsAt: Date;
  status: TennisStatus;
  result: TennisResult | null;
};

export type RawTennisMatch = {
  event_key?: string | number;
  event_date?: string;
  event_time?: string;
  event_first_player?: string;
  event_second_player?: string;
  event_final_result?: string;
  event_winner?: string | null;
  event_status?: string;
  event_type_type?: string;
  tournament_name?: string;
  tournament_round?: string;
  event_live?: string;
  scores?: Array<{ score_first?: string; score_second?: string; score_set?: string }>;
};

/** Odds per market, then per outcome, then per bookmaker: { "Home/Away": { "Home": { "bet365": "1.50" } } }. */
export type RawTennisOdds = Record<string, Record<string, Record<string, string>>>;

/** "Atp Singles" → "ATP Singles". */
const tourName = (type: string) => type.replace(/\b(atp|wta|itf|utr)\b/gi, (word) => word.toUpperCase());

function statusOf(raw: RawTennisMatch): TennisStatus {
  const status = (raw.event_status ?? "").trim();
  if (/^finished$/i.test(status)) return "finished";
  if (/retire/i.test(status)) return "retired";
  if (/walk\s*-?over|^w\.?o\.?$/i.test(status) || /cancel|abandon/i.test(status)) return "cancelled";
  if (/postpon/i.test(status)) return "postponed";
  if (raw.event_live === "1" || /^set \d|interrupt|suspend/i.test(status)) return "live";
  return "upcoming";
}

/** A set's games, from "6", "7.5" (a tie-break) or "7(5)". */
const games = (value: string | undefined) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

export function parseTennisMatch(raw: RawTennisMatch): FeedMatch | null {
  const home = raw.event_first_player?.trim();
  const away = raw.event_second_player?.trim();
  const time = /^\d{2}:\d{2}$/.test(raw.event_time ?? "") ? raw.event_time : null;
  const startsAt = new Date(`${raw.event_date}T${time}:00Z`);
  // Doubles pairs come as "A. Smith/B. Jones": kept, the name just reads that way.
  if (!raw.event_key || !home || !away || !time || Number.isNaN(startsAt.getTime())) return null;
  const status = statusOf(raw);
  const sets = [...(raw.scores ?? [])]
    .sort((a, b) => Number(a.score_set) - Number(b.score_set))
    .map((set) => [games(set.score_first), games(set.score_second)] as const)
    .filter((set): set is readonly [number, number] => set[0] !== null && set[1] !== null)
    .map(([a, b]) => [a, b] as [number, number]);
  const winner = /first/i.test(raw.event_winner ?? "") ? "home" : /second/i.test(raw.event_winner ?? "") ? "away" : null;
  const over = status === "finished" || status === "retired";
  return {
    externalId: String(raw.event_key),
    tour: tourName(raw.event_type_type?.trim() || "Tennis"),
    tournament: raw.tournament_name?.trim() || "Tennis",
    round: raw.tournament_round?.trim() || null,
    home,
    away,
    startsAt,
    status,
    result: over && winner && sets.length > 0 ? { outcome: winner, sets, completed: status === "finished" } : null,
  };
}

/** Sets each player won, counting only finished sets. */
export function setsWon(result: TennisResult): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const [a, b] of result.sets) {
    if (!setFinished(a, b)) continue;
    if (a > b) home++;
    else away++;
  }
  return { home, away };
}

/** Whether a set with these games is over: 6 with a two-game lead, 7-5 or 7-6, or a match tie-break (to 10). */
export function setFinished(a: number, b: number): boolean {
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  return (high >= 6 && high - low >= 2) || (high === 7 && low === 6) || (high >= 10 && high - low >= 2);
}

export type TennisMarket = { key: string; name: string; sortOrder: number; selections: Array<{ key: string; name: string; odds: number; sortOrder: number }> };

const price = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 1 ? Math.round(n * 100) / 100 : null;
};

/**
 * The match's markets from the chosen bookmaker's prices, else from the
 * first bookmaker that prices the whole market. "Home" is the first player.
 */
export function parseTennisOdds(raw: RawTennisOdds, home: string, away: string, bookmaker: string): TennisMarket[] {
  const wanted = bookmaker.toLowerCase();
  /** One bookmaker's prices for every outcome named, or null if no bookmaker has them all. */
  const prices = (market: string, outcomes: string[]): number[] | null => {
    const byOutcome = outcomes.map((outcome) => raw[market]?.[outcome] ?? {});
    const books = [...new Set(byOutcome.flatMap((books) => Object.keys(books)))].sort((a, b) => (a.toLowerCase() === wanted ? -1 : b.toLowerCase() === wanted ? 1 : 0));
    for (const book of books) {
      const odds = byOutcome.map((books) => price(books[book]));
      if (odds.every((o) => o !== null)) return odds as number[];
    }
    return null;
  };
  const markets: TennisMarket[] = [];
  const two = (market: string, key: string, name: string, sortOrder: number) => {
    const odds = prices(market, ["Home", "Away"]);
    if (odds) markets.push({ key, name, sortOrder, selections: [{ key: "home", name: home, odds: odds[0], sortOrder: 0 }, { key: "away", name: away, odds: odds[1], sortOrder: 1 }] });
  };
  two("Home/Away", "tn_winner", "Match winner", 0);
  two("Home/Away (1st Set)", "tn_set1", "1st set winner", 1);
  // "2:1" is the first player winning two sets to one; best of five has 3:0, 3:1 and 3:2.
  const scores = Object.keys(raw["Set Betting"] ?? {}).filter((score) => /^\d:\d$/.test(score));
  const sets = scores
    .map((score) => {
      const [a, b] = score.split(":").map(Number);
      const odds = prices("Set Betting", [score]);
      return odds && a !== b ? { a, b, odds: odds[0] } : null;
    })
    .filter((s): s is { a: number; b: number; odds: number } => s !== null)
    // The first player's wins first, each in order of sets lost, then the second player's.
    .sort((x, y) => Number(x.a < x.b) - Number(y.a < y.b) || Math.min(x.a, x.b) - Math.min(y.a, y.b));
  const best = Math.max(0, ...sets.map((s) => Math.max(s.a, s.b)));
  // Every score has to be there, or the market would be missing outcomes.
  if (best >= 2 && sets.length === best * 2) {
    markets.push({
      key: "tn_sets",
      name: "Set betting",
      sortOrder: 2,
      selections: sets.map((s, i) => ({ key: `${s.a}_${s.b}`, name: `${s.a > s.b ? home : away} ${Math.max(s.a, s.b)}-${Math.min(s.a, s.b)}`, odds: s.odds, sortOrder: i })),
    });
  }
  return markets;
}

export const isTennisMarket = (marketKey: string) => marketKey.startsWith("tn_");

/** One tennis outcome's result; null when it can't be settled from what's known. */
export function gradeTennis(marketKey: string, selectionKey: string, result: TennisResult | null): SelectionResult | null {
  if (!result) return null;
  const won = (yes: boolean) => (yes ? SelectionResult.WON : SelectionResult.LOST);
  if (marketKey === "tn_set1") {
    const first = result.sets[0];
    // A player retired before the 1st set was over: it's undecided.
    if (!first || !setFinished(first[0], first[1])) return result.completed ? null : SelectionResult.VOID;
    return won((first[0] > first[1]) === (selectionKey === "home"));
  }
  // The match itself is undecided when a player retired.
  if (!result.completed) return marketKey === "tn_winner" || marketKey === "tn_sets" ? SelectionResult.VOID : null;
  if (marketKey === "tn_winner") return won(result.outcome === selectionKey);
  if (marketKey === "tn_sets") {
    const { home, away } = setsWon(result);
    return won(selectionKey === `${home}_${away}`);
  }
  return null;
}

export function tennisResultOf(value: unknown): TennisResult | null {
  if (!value || typeof value !== "object" || !("sets" in value) || !("outcome" in value)) return null;
  return value as TennisResult;
}
