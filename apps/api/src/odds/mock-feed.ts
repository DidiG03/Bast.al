import type { ApiResponse, FetchJson, RawFixture, RawOdds } from "./api-football";

/**
 * A stand-in for API-Football, used when ODDS_FEED_MOCK=true and no API key is
 * set. It answers the same paths with the same JSON shape, so the real
 * parsing and sync code run end to end. Kick-off times are relative to now:
 * two matches are live, one has finished and the rest start over the next
 * two days. League and match ids are made up; the sync takes every league
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

function fixture(match: MockMatch, now: number): RawFixture {
  const start = now + match.kickoff * 60_000;
  const minutes = Math.floor((now - start) / 60_000);
  const status = minutes < 0 ? "NS" : minutes >= 110 ? "FT" : minutes >= 45 && minutes < 60 ? "HT" : minutes < 45 ? "1H" : "2H";
  const elapsed = status === "NS" || status === "FT" ? (status === "FT" ? 90 : null) : status === "HT" ? 45 : Math.min(90, minutes < 45 ? minutes + 1 : minutes - 14);
  // A goal every half hour or so, split by the match id, so live scores move.
  const goals = elapsed === null ? null : Math.floor(elapsed / 30);
  return {
    fixture: { id: match.id, date: new Date(start).toISOString(), status: { short: status, elapsed } },
    league: { id: match.league[0], name: match.league[1], country: match.league[2], season: SEASON },
    teams: { home: { name: match.home }, away: { name: match.away } },
    goals: { home: goals === null ? null : Math.ceil(goals / 2) + (match.id % 2), away: goals === null ? null : Math.floor(goals / 2) },
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

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function mockFetchJson(clock: () => number = Date.now): FetchJson {
  return async (path, params): Promise<ApiResponse<unknown>> => {
    const now = clock();
    const all = MATCHES.map((m) => fixture(m, now));
    if (path === "/fixtures") {
      if (params.live === "all") return { response: all.filter((f) => !["NS", "FT"].includes(f.fixture.status.short)) };
      if (params.ids) {
        const ids = String(params.ids).split("-");
        return { response: all.filter((f) => ids.includes(String(f.fixture.id))) };
      }
      return { response: all.filter((f) => f.fixture.date.slice(0, 10) === params.date) };
    }
    if (path === "/odds") {
      const response = MATCHES.filter((m) => m.league[0] === Number(params.league) && utcDate(now + m.kickoff * 60_000) === params.date).map(odds);
      return { paging: { current: 1, total: 1 }, response };
    }
    return { response: [] };
  };
}
