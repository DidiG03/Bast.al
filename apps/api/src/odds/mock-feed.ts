import type { ApiResponse, FetchJson, RawFixture, RawLiveOdds, RawOdds } from "./api-football";

/**
 * A stand-in for API-Football, used when ODDS_FEED_MOCK=true and no API key is
 * set. It answers the same paths with the same JSON shape, so the real
 * parsing and sync code run end to end. Kick-off times are relative to when the
 * API started: two matches are live, one has finished and the rest start over
 * the next two days. League and match ids are made up; the sync takes every league
 * in mock mode.
 */

type MockMatch = {
  id: number;
  league: [id: number, name: string, country: string];
  home: string;
  away: string;
  /** Kick-off, in minutes from now. */
  kickoff: number;
  odds: [home: number, draw: number, away: number, over: number, under: number];
};

const MATCHES: MockMatch[] = [
  { id: 900001, league: [9001, "Abissnet Superiore", "Albania"], home: "Tirana", away: "Partizani", kickoff: -50, odds: [2.1, 3.2, 3.4, 2.05, 1.75] },
  { id: 900002, league: [9001, "Abissnet Superiore", "Albania"], home: "Vllaznia", away: "Egnatia", kickoff: -130, odds: [2.6, 3.1, 2.7, 2.2, 1.65] },
  { id: 900003, league: [9001, "Abissnet Superiore", "Albania"], home: "Dinamo City", away: "Teuta", kickoff: 180, odds: [1.95, 3.3, 3.9, 1.9, 1.9] },
  { id: 900004, league: [9002, "Premier League", "England"], home: "Arsenal", away: "Chelsea", kickoff: 25, odds: [1.8, 3.8, 4.4, 1.7, 2.15] },
  { id: 900005, league: [9002, "Premier League", "England"], home: "Liverpool", away: "Newcastle", kickoff: 1500, odds: [1.55, 4.3, 5.6, 1.6, 2.3] },
  { id: 900006, league: [9003, "Serie A", "Italy"], home: "Inter", away: "Juventus", kickoff: 300, odds: [2.05, 3.25, 3.7, 2.1, 1.72] },
  { id: 900007, league: [9004, "UEFA Champions League", "World"], home: "Real Madrid", away: "Bayern Munich", kickoff: 2700, odds: [2.2, 3.6, 3.0, 1.6, 2.35] },
  { id: 900008, league: [9005, "La Liga", "Spain"], home: "Barcelona", away: "Sevilla", kickoff: -20, odds: [1.4, 4.9, 7.5, 1.45, 2.7] },
];

const SEASON = 2026;

function fixture(match: MockMatch, now: number, anchor: number): RawFixture {
  const start = anchor + match.kickoff * 60_000;
  const minutes = Math.floor((now - start) / 60_000);
  const status = minutes < 0 ? "NS" : minutes >= 110 ? "FT" : minutes >= 45 && minutes < 60 ? "HT" : minutes < 45 ? "1H" : "2H";
  const elapsed = status === "NS" || status === "FT" ? (status === "FT" ? 90 : null) : status === "HT" ? 45 : Math.min(90, minutes < 45 ? minutes + 1 : minutes - 14);
  // A goal every half hour or so, split by the match id, so live scores move.
  const goals = elapsed === null ? null : Math.floor(elapsed / 30);
  const score = { home: goals === null ? null : Math.ceil(goals / 2) + (match.id % 2), away: goals === null ? null : Math.floor(goals / 2) };
  return {
    fixture: { id: match.id, date: new Date(start).toISOString(), status: { short: status, elapsed } },
    league: { id: match.league[0], name: match.league[1], country: match.league[2], season: SEASON },
    teams: { home: { name: match.home }, away: { name: match.away } },
    goals: score,
    score: { fulltime: status === "FT" ? score : { home: null, away: null } },
  };
}

function odds(match: MockMatch): RawOdds {
  const [home, draw, away, over, under] = match.odds.map(String);
  const dc = (a: number, b: number) => String(Math.max(1.02, Math.round((1 / (1 / a + 1 / b)) * 100) / 100));
  return {
    fixture: { id: match.id },
    bookmakers: [
      {
        id: 8,
        name: "Bet365",
        bets: [
          { id: 1, name: "Match Winner", values: [{ value: "Home", odd: home }, { value: "Draw", odd: draw }, { value: "Away", odd: away }] },
          { id: 5, name: "Goals Over/Under", values: [{ value: "Over 1.5", odd: "1.25" }, { value: "Over 2.5", odd: over }, { value: "Under 2.5", odd: under }] },
          { id: 8, name: "Both Teams Score", values: [{ value: "Yes", odd: "1.80" }, { value: "No", odd: "1.95" }] },
          {
            id: 12,
            name: "Double Chance",
            values: [
              { value: "Home/Draw", odd: dc(match.odds[0], match.odds[1]) },
              { value: "Home/Away", odd: dc(match.odds[0], match.odds[2]) },
              { value: "Draw/Away", odd: dc(match.odds[1], match.odds[2]) },
            ],
          },
        ],
      },
    ],
  };
}

const price = (p: number) => String(Math.max(1.01, Math.floor((0.94 / Math.max(0.01, p)) * 100) / 100));

/**
 * In-play prices that follow the mock score: the side ahead shortens as the
 * clock runs down. Every market is suspended for the first two minutes after
 * a goal, like a real bookmaker, and a decided market drops off the board.
 */
function liveOdds(match: MockMatch, raw: RawFixture): RawLiveOdds {
  const elapsed = raw.fixture.status.elapsed ?? 0;
  const home = raw.goals.home ?? 0;
  const away = raw.goals.away ?? 0;
  const t = Math.min(0.95, elapsed / 90);
  const inv = match.odds.slice(0, 3).map((o) => 1 / o);
  const sum = inv[0] + inv[1] + inv[2];
  const start = inv.map((p) => p / sum);
  const target = home > away ? [0.9, 0.07, 0.03] : home < away ? [0.03, 0.07, 0.9] : [0.28, 0.44, 0.28];
  const [ph, pd, pa] = start.map((p, i) => (1 - t) * p + t * target[i]);
  const goals = home + away;
  const suspended = elapsed >= 30 && elapsed % 30 < 2;
  const v = (value: string, p: number, handicap: string | null = null) => ({ value, odd: price(p), handicap, main: handicap ? true : null, suspended });
  const odds: RawLiveOdds["odds"] = [
    { id: 59, name: "Fulltime Result", values: [v("Home", ph), v("Draw", pd), v("Away", pa)] },
    { id: 72, name: "Double Chance", values: [v("Home/Draw", ph + pd), v("Home/Away", ph + pa), v("Draw/Away", pd + pa)] },
  ];
  // Every line still open: the chance of `needed` more goals shrinks as the clock runs down.
  const lines = ["0.5", "1.5", "2.5", "3.5", "4.5"].filter((line) => Number(line) > goals);
  if (lines.length > 0) {
    const values = lines.flatMap((line) => {
      const over = (1 - t) * [0.7, 0.45, 0.25, 0.12, 0.05][Math.ceil(Number(line) - goals) - 1];
      return [v("Over", over, line), v("Under", 1 - over, line)];
    });
    odds.push({ id: 36, name: "Over/Under Line", values });
  }
  if (home === 0 || away === 0) {
    const yes = (1 - t) * (home + away > 0 ? 0.55 : 0.45);
    odds.push({ id: 69, name: "Both Teams To Score", values: [v("Yes", yes), v("No", 1 - yes)] });
  }
  return {
    fixture: { id: match.id, status: { long: raw.fixture.status.short, elapsed } },
    teams: { home: { goals: home }, away: { goals: away } },
    status: { stopped: false, blocked: false, finished: false },
    update: new Date().toISOString(),
    odds,
  };
}

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Kick-off times are fixed relative to `anchor` (when the API started), so
 * matches really kick off, finish and get settled while you test.
 */
export function mockFetchJson(clock: () => number = Date.now, anchor: number = clock()): FetchJson {
  return async (path, params): Promise<ApiResponse<unknown>> => {
    const now = clock();
    const all = MATCHES.map((m) => fixture(m, now, anchor));
    if (path === "/fixtures") {
      if (params.live === "all") return { response: all.filter((f) => !["NS", "FT"].includes(f.fixture.status.short)) };
      if (params.ids) {
        const ids = String(params.ids).split("-");
        return { response: all.filter((f) => ids.includes(String(f.fixture.id))) };
      }
      return { response: all.filter((f) => f.fixture.date.slice(0, 10) === params.date) };
    }
    if (path === "/odds/live") {
      const live = MATCHES.map((m) => [m, fixture(m, now, anchor)] as const).filter(([, f]) => ["1H", "HT", "2H"].includes(f.fixture.status.short));
      return { response: live.map(([m, f]) => liveOdds(m, f)) };
    }
    if (path === "/odds") {
      const response = MATCHES.filter((m) => m.league[0] === Number(params.league) && utcDate(anchor + m.kickoff * 60_000) === params.date).map(odds);
      return { paging: { current: 1, total: 1 }, response };
    }
    return { response: [] };
  };
}
