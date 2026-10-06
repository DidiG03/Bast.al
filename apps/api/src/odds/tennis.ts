import { SelectionResult } from "@prisma/client";

/**
 * Tennis from API-Tennis (api-tennis.com): matches with their tournament and
 * round, set-by-set scores, and bookmaker odds.
 *
 * Markets, at fixed prices like football, each when the feed prices it:
 * - Match winner, and 1st set winner: either player.
 * - Set betting: the match's score in sets, e.g. "Sinner 2-1".
 * - To win in straight sets, for each player: yes or no.
 * - 1st set correct score, e.g. "Sinner 6-4".
 * - Total games in the match, and in the 1st set: over or under.
 * - Games handicap: a player with games added or taken away.
 * Games count a tie-break as one game, and a match tie-break (to 10) too.
 * If a player retires, the 1st set markets stand once the 1st set was
 * finished and everything else is void. A walkover, or a match cancelled,
 * is void.
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

/** Lines offered per over/under or handicap market: the even one and those nearest it. */
const LINES_SHOWN = 3;
const isHalf = (line: number) => Math.abs((Math.abs(line) % 1) - 0.5) < 1e-9;
/** "-3.5" → "m3_5", "22.5" → "22_5", for a market key. */
const lineKey = (line: number) => `${line < 0 ? "m" : ""}${Math.abs(line).toFixed(1).replace(".", "_")}`;
const lineOf = (key: string) => {
  const match = /(m?)(\d+)_(\d)$/.exec(key);
  return match ? (match[1] ? -1 : 1) * Number(`${match[2]}.${match[3]}`) : null;
};
const signed = (line: number) => `${line > 0 ? "+" : line < 0 ? "−" : ""}${Math.abs(line)}`;

/**
 * The match's markets from the chosen bookmaker's prices, else from the
 * first bookmaker that prices the whole market. "Home" is the first player.
 * Markets are found by name loosely, since the feed's names vary a little
 * ("Over/Under by Games in Match", "Over/Under (1st Set)", "Asian Handicap").
 * Only half-point lines are offered, so a bet never lands exactly on the line.
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
  const names = Object.keys(raw);
  const find = (test: (name: string) => boolean) => names.find(test) ?? null;
  const markets: TennisMarket[] = [];
  const two = (market: string | null, key: string, name: string, sortOrder: number) => {
    const odds = market ? prices(market, ["Home", "Away"]) : null;
    if (odds) markets.push({ key, name, sortOrder, selections: [{ key: "home", name: home, odds: odds[0], sortOrder: 0 }, { key: "away", name: away, odds: odds[1], sortOrder: 1 }] });
  };
  two("Home/Away", "tn_winner", "Match winner", 0);
  two(find((n) => /^home\/away \(1st set\)$/i.test(n)), "tn_set1", "1st set winner", 1);

  // "2:1" is the first player winning two sets to one; best of five has 3:0, 3:1 and 3:2.
  const scores = (market: string | null) =>
    Object.keys((market && raw[market]) ?? {})
      .map((score) => /^(\d+)[:-](\d+)$/.exec(score.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => {
        const odds = prices(market!, [m[0]]);
        return odds ? { a: Number(m[1]), b: Number(m[2]), odds: odds[0] } : null;
      })
      .filter((s): s is { a: number; b: number; odds: number } => s !== null && s.a !== s.b)
      // The first player's wins first, each in order of what the loser got, then the second player's.
      .sort((x, y) => Number(x.a < x.b) - Number(y.a < y.b) || Math.min(x.a, x.b) - Math.min(y.a, y.b));
  const sets = scores("Set Betting");
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

  const yesNo = (market: string | null, key: string, name: string, sortOrder: number) => {
    const odds = market ? prices(market, ["Yes", "No"]) : null;
    if (odds) markets.push({ key, name, sortOrder, selections: [{ key: "yes", name: "Yes", odds: odds[0], sortOrder: 0 }, { key: "no", name: "No", odds: odds[1], sortOrder: 1 }] });
  };
  const players = [["1", "home", home], ["2", "away", away]] as const;
  // For each player, yes or no: wins in straight sets (the feed spells it "Straigh"), wins at least one set, wins from a set down.
  players.forEach(([player, key, name], i) => {
    const named = (pattern: string) => find((n) => new RegExp(`${pattern}.*\\(player ${player}\\)`, "i").test(n));
    yesNo(named("straigh?t? sets"), `tn_straight_${key}`, `${name} to win in straight sets`, 3 + i);
    yesNo(named("at least one set"), `tn_one_set_${key}`, `${name} to win at least one set`, 5 + i);
    yesNo(named("from behind"), `tn_behind_${key}`, `${name} to win from a set down`, 7 + i);
  });

  // 1st set and match winners together: "Home/Away" is the first player taking the 1st set and the second the match.
  const setMatch = find((n) => /^set\s*\/\s*match$/i.test(n));
  if (setMatch) {
    const side = (v: string) => (/^(home|1)$/i.test(v) ? "home" : /^(away|2)$/i.test(v) ? "away" : null);
    const combos = Object.keys(raw[setMatch] ?? {})
      .map((outcome) => {
        const [a, b] = outcome.split("/").map((v) => side(v.trim()));
        const odds = a && b ? prices(setMatch, [outcome]) : null;
        return a && b && odds ? { key: `${a}_${b}`, name: `${a === "home" ? home : away} / ${b === "home" ? home : away}`, odds: odds[0] } : null;
      })
      .filter((c): c is { key: string; name: string; odds: number } => c !== null);
    const order = ["home_home", "home_away", "away_home", "away_away"];
    if (combos.length === 4 && new Set(combos.map((c) => c.key)).size === 4) {
      markets.push({ key: "tn_set_match", name: "1st set / match", sortOrder: 9, selections: combos.sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key)).map((c, i) => ({ ...c, sortOrder: i })) });
    }
  }

  /**
   * Over/under or handicap lines from a market's outcomes, "Over 22.5" or
   * "Home -3.5": the even one and those nearest it. A handicap's away side
   * may be written as the home team's line ("Away -3.5", as API-Sports does)
   * or as its own ("Away +3.5"); the one whose prices make a fair pair (the
   * two chances adding up to just over 100%) is taken.
   */
  const lines = (market: string | null, a: string, b: string) => {
    if (!market) return [];
    const read = (side: string) =>
      Object.keys(raw[market] ?? {})
        .map((outcome) => ({ outcome, match: new RegExp(`^(${side})\\s*\\(?([+-]?\\d+(?:\\.\\d+)?)\\)?$`, "i").exec(outcome.trim()) }))
        .filter((o): o is { outcome: string; match: RegExpExecArray } => o.match !== null && isHalf(Number(o.match[2])))
        .map((o) => ({ outcome: o.outcome, line: Number(o.match[2]) }));
    const others = read(b);
    const handicap = a === "Home";
    const priced = read(a)
      .map(({ outcome, line }) => {
        const candidates = others.filter((o) => (handicap ? o.line === -line || o.line === line : o.line === line));
        const fair = candidates
          .map((o) => ({ o, odds: prices(market, [outcome, o.outcome]) }))
          .filter((c): c is { o: { outcome: string; line: number }; odds: number[] } => c.odds !== null)
          .map((c) => ({ ...c, book: 1 / c.odds[0] + 1 / c.odds[1] }))
          .filter((c) => c.book > 0.98 && c.book < 1.2)
          .sort((x, y) => Math.abs(x.book - 1.06) - Math.abs(y.book - 1.06))[0];
        return fair ? { line, a: fair.odds[0], b: fair.odds[1] } : null;
      })
      .filter((l): l is { line: number; a: number; b: number } => l !== null);
    if (priced.length === 0) return [];
    const even = priced.reduce((best, l) => (Math.abs(l.a - l.b) < Math.abs(best.a - best.b) ? l : best));
    return [...priced].sort((x, y) => Math.abs(x.line - even.line) - Math.abs(y.line - even.line)).slice(0, LINES_SHOWN).sort((x, y) => x.line - y.line);
  };
  /** `minLine`: lines below it are left out (a plain "Over/Under" at 2.5 is sets, not games). */
  const overUnder = (market: string | null, key: string, name: string, sortOrder: number, minLine = 0) =>
    lines(market, "Over", "Under")
      .filter((l) => l.line > minLine)
      .forEach((l, i) =>
        markets.push({
          key: `${key}_${lineKey(l.line)}`,
          name: `${name} ${l.line}`,
          sortOrder: sortOrder + i,
          selections: [
            { key: "over", name: `Over ${l.line}`, odds: l.a, sortOrder: 0 },
            { key: "under", name: `Under ${l.line}`, odds: l.b, sortOrder: 1 },
          ],
        }),
      );
  const handicap = (market: string | null, key: string, name: string, sortOrder: number) =>
    lines(market, "Home", "Away").forEach((l, i) =>
      markets.push({
        key: `${key}_${lineKey(l.line)}`,
        name: `${name} ${home} ${signed(l.line)}`,
        sortOrder: sortOrder + i,
        selections: [
          { key: "home", name: `${home} ${signed(l.line)}`, odds: l.a, sortOrder: 0 },
          { key: "away", name: `${away} ${signed(-l.line)}`, odds: l.b, sortOrder: 1 },
        ],
      }),
    );
  const oddEven = (market: string | null, key: string, name: string, sortOrder: number) => {
    const odds = market ? prices(market, ["Odd", "Even"]) : null;
    if (odds) markets.push({ key, name, sortOrder, selections: [{ key: "odd", name: "Odd", odds: odds[0], sortOrder: 0 }, { key: "even", name: "Even", odds: odds[1], sortOrder: 1 }] });
  };

  // The whole match. "Over/Under" alone is taken as games only when its lines are (over 10); sets are their own market.
  const gamesTotal = find((n) => /^over\/under by games in match$/i.test(n));
  overUnder(gamesTotal ?? find((n) => /^over\/under$/i.test(n)), "tn_games", "Total games", 10, 10);
  handicap(find((n) => /^asian handicap \(games\)$/i.test(n)), "tn_handicap", "Games handicap", 30);
  handicap(find((n) => /^asian handicap \(sets\)$/i.test(n)), "tn_sets_handicap", "Sets handicap", 35);
  overUnder(find((n) => /^total - home$/i.test(n)), "tn_home_games", `${home} games`, 40);
  overUnder(find((n) => /^total - away$/i.test(n)), "tn_away_games", `${away} games`, 45);
  oddEven(find((n) => /^odd\/even$/i.test(n)), "tn_odd_even", "Total games odd/even", 50);

  // The 1st and 2nd sets: winner, exact score ("Correct Score 1st Half" in the feed), games, games handicap, each player's games, odd/even.
  (["1st", "2nd"] as const).forEach((nth, i) => {
    const set = `set${i + 1}`;
    const label = `${nth} set`;
    const base = 100 + i * 50;
    if (i === 1) {
      const odds = prices("Home/Away (2nd Set)", ["Home", "Away"]);
      if (odds) markets.push({ key: "tn_set2", name: "2nd set winner", sortOrder: base, selections: [{ key: "home", name: home, odds: odds[0], sortOrder: 0 }, { key: "away", name: away, odds: odds[1], sortOrder: 1 }] });
    }
    const exact = scores(find((n) => new RegExp(`^correct score ${nth} (half|set)$`, "i").test(n))).filter((s) => setFinished(s.a, s.b) && Math.max(s.a, s.b) <= 7);
    if (exact.length >= 4) {
      markets.push({
        key: `tn_${set}_score`,
        name: `${label} correct score`,
        sortOrder: base + 1,
        selections: exact.map((s, k) => ({ key: `${s.a}_${s.b}`, name: `${s.a > s.b ? home : away} ${Math.max(s.a, s.b)}-${Math.min(s.a, s.b)}`, odds: s.odds, sortOrder: k })),
      });
    }
    overUnder(find((n) => new RegExp(`^over\\/under( by games)? \\(${nth} set\\)$`, "i").test(n)), `tn_${set}_games`, `${label} total games`, base + 5);
    handicap(find((n) => new RegExp(`^asian handicap \\(${nth} set\\)$`, "i").test(n)), `tn_${set}_handicap`, `${label} games handicap`, base + 10);
    overUnder(find((n) => new RegExp(`^home team total \\(${nth} set\\)$`, "i").test(n)), `tn_${set}_home_games`, `${home} ${label} games`, base + 15);
    overUnder(find((n) => new RegExp(`^away team total \\(${nth} set\\)$`, "i").test(n)), `tn_${set}_away_games`, `${away} ${label} games`, base + 20);
    oddEven(find((n) => new RegExp(`^odd\\/even \\(${nth} set\\)$`, "i").test(n)), `tn_${set}_odd_even`, `${label} games odd/even`, base + 25);
  });
  return markets;
}

export const isTennisMarket = (marketKey: string) => marketKey.startsWith("tn_");

/** Games in a set for the games markets: a match tie-break (to 10) counts as one game. */
const setGames = ([a, b]: [number, number]): [number, number] => (Math.max(a, b) >= 10 ? (a > b ? [1, 0] : [0, 1]) : [a, b]);

/** One tennis outcome's result; null when it can't be settled from what's known. */
export function gradeTennis(marketKey: string, selectionKey: string, result: TennisResult | null): SelectionResult | null {
  if (!result) return null;
  const won = (yes: boolean) => (yes ? SelectionResult.WON : SelectionResult.LOST);
  const yesNo = (happened: boolean) => (selectionKey === "yes" || selectionKey === "no" ? won(happened === (selectionKey === "yes")) : null);
  const overUnder = (count: number, line: number) => (selectionKey === "over" || selectionKey === "under" ? won((count > line) === (selectionKey === "over")) : null);
  const oddEven = (count: number) => (selectionKey === "odd" || selectionKey === "even" ? won((count % 2 === 1) === (selectionKey === "odd")) : null);
  const ahead = (margin: number) => (selectionKey === "home" || selectionKey === "away" ? won((margin > 0) === (selectionKey === "home")) : null);
  const line = lineOf(marketKey);

  // One set's markets: tn_set1, tn_set2_score, tn_set1_games_9_5, tn_set2_handicap_m1_5, tn_set1_home_games_4_5, tn_set1_odd_even.
  const setMarket = /^tn_set([12])(?:_(score|games|handicap|home_games|away_games|odd_even))?(?:_|$)/.exec(marketKey);
  if (setMarket) {
    const set = result.sets[Number(setMarket[1]) - 1];
    // A player retired before that set was over: it's undecided.
    if (!set || !setFinished(set[0], set[1])) return result.completed ? null : SelectionResult.VOID;
    const [a, b] = setGames(set);
    switch (setMarket[2]) {
      case undefined:
        return ahead(a - b);
      case "score":
        return won(selectionKey === `${set[0]}_${set[1]}`);
      case "odd_even":
        return oddEven(a + b);
    }
    if (line === null) return null;
    if (setMarket[2] === "games") return overUnder(a + b, line);
    if (setMarket[2] === "home_games") return overUnder(a, line);
    if (setMarket[2] === "away_games") return overUnder(b, line);
    return ahead(a + line - b);
  }

  const sets = setsWon(result);
  // Winning at least one set is decided once a player has, even if the other retires later.
  const oneSet = /^tn_one_set_(home|away)$/.exec(marketKey);
  if (oneSet && sets[oneSet[1] as "home" | "away"] > 0) return yesNo(true);

  // Everything else is about the whole match, so it's undecided when a player retired.
  if (!result.completed) return isTennisMarket(marketKey) ? SelectionResult.VOID : null;
  if (oneSet) return yesNo(false);
  if (marketKey === "tn_winner") return won(result.outcome === selectionKey);
  if (marketKey === "tn_sets") return won(selectionKey === `${sets.home}_${sets.away}`);
  const straight = /^tn_straight_(home|away)$/.exec(marketKey);
  if (straight) return yesNo(result.outcome === straight[1] && (straight[1] === "home" ? sets.away : sets.home) === 0);
  const first = result.sets[0];
  const firstWinner = first && setFinished(first[0], first[1]) ? (first[0] > first[1] ? "home" : "away") : null;
  const behind = /^tn_behind_(home|away)$/.exec(marketKey);
  if (behind) return firstWinner ? yesNo(result.outcome === behind[1] && firstWinner !== behind[1]) : null;
  if (marketKey === "tn_set_match") return firstWinner ? won(selectionKey === `${firstWinner}_${result.outcome}`) : null;
  const games = result.sets.map(setGames).reduce((sum, [a, b]) => ({ home: sum.home + a, away: sum.away + b }), { home: 0, away: 0 });
  if (marketKey === "tn_odd_even") return oddEven(games.home + games.away);
  if (line === null) return null;
  if (marketKey.startsWith("tn_games_")) return overUnder(games.home + games.away, line);
  if (marketKey.startsWith("tn_home_games_")) return overUnder(games.home, line);
  if (marketKey.startsWith("tn_away_games_")) return overUnder(games.away, line);
  if (marketKey.startsWith("tn_handicap_")) return ahead(games.home + line - games.away);
  if (marketKey.startsWith("tn_sets_handicap_")) return ahead(sets.home + line - sets.away);
  return null;
}

export function tennisResultOf(value: unknown): TennisResult | null {
  if (!value || typeof value !== "object" || !("sets" in value) || !("outcome" in value)) return null;
  return value as TennisResult;
}
