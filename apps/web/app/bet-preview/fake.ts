import type { OddsEvent } from "../../lib/api";

// PREVIEW ONLY: fakes sign-in and the API: live, just-finished and upcoming matches, and open bets with match updates.
const PREVIEW_AUTH = { getToken: async () => "preview", userId: "preview-user" };
export const useAuth = () => PREVIEW_AUTH;
/** Two real crests so the preview shows a picture where the feed has one, and a letter where it doesn't. */
const CRESTS: Record<number, [string, string, string, string]> = {
  0: ["Arsenal", "Chelsea", "https://media.api-sports.io/football/teams/42.png", "https://media.api-sports.io/football/teams/49.png"],
  4: ["Liverpool", "Newcastle", "https://media.api-sports.io/football/teams/40.png", "https://media.api-sports.io/football/teams/34.png"],
};
const WORLD = { name: "AFC Champions League Elite", country: "World", logo: "https://media.api-sports.io/football/leagues/17.png", flag: null as string | null };
const LEAGUES = [
  { name: "Premier League", country: "England", logo: "https://media.api-sports.io/football/leagues/39.png", flag: "https://media.api-sports.io/flags/gb.svg" as string | null },
  { name: "La Liga", country: "Spain", logo: "https://media.api-sports.io/football/leagues/140.png", flag: "https://media.api-sports.io/flags/es.svg" },
  { name: "Serie A", country: "Italy", logo: "https://media.api-sports.io/football/leagues/135.png", flag: "https://media.api-sports.io/flags/it.svg" },
  { name: "Bundesliga", country: "Germany", logo: "https://media.api-sports.io/football/leagues/78.png", flag: "https://media.api-sports.io/flags/de.svg" },
];
const sides = (i: number) => {
  const crest = CRESTS[i];
  const home = crest?.[0] ?? `Club ${i}`;
  const away = crest?.[1] ?? `Club ${i + 1}`;
  return { home, away, homeLogo: crest?.[2] ?? null, awayLogo: crest?.[3] ?? null };
};
const FAKE_EVENTS: OddsEvent[] = Array.from({ length: 30 }, (_, i) => {
  const live = i < 4, ended = i === 1 || i === 3, halfTime = i === 2;
  const { home, away, homeLogo, awayLogo } = sides(i);
  const league = i === 4 ? WORLD : LEAGUES[i % LEAGUES.length];
  return {
    id: `ev${i}`, sport: "football", name: `${home} v ${away}`, league: league.name, country: league.country, homeTeam: home, awayTeam: away, homeLogo, awayLogo, leagueLogo: league.logo, countryFlag: league.flag,
    startsAt: new Date(Date.now() + (live ? -3_000_000 : (i - 2) * 86_400_000)).toISOString(), status: live ? "LIVE" : "UPCOMING", elapsed: halfTime ? 45 : live ? 67 : null, period: ended ? "FT" : halfTime ? "HT" : live ? "2H" : null,
    homeScore: live ? 2 : null, awayScore: live ? 1 : null, hidden: false, suspended: false, provider: "api-football", bettable: !ended && !halfTime, livePause: halfTime ? "break" : null, live, marketCount: 5,
    markets: [{ id: `m${i}`, key: "match_winner", name: "Match winner", suspended: halfTime || i === 0, selections: ["home", "draw", "away"].map((key, k) => ({ id: `s${i}-${k}`, key, name: key === "draw" ? "Draw" : k === 2 ? away : home, price: [1.8, 3.6, 4.1][k], custom: false, result: null, suspended: false })) }],
  } as unknown as OddsEvent;
});
const CENTRE = {
  moments: [
    { minute: 66, extra: null, side: "home", kind: "var", player: "Hoxha", other: null, detail: "Goal cancelled" },
    { minute: 63, extra: null, side: "away", kind: "own_goal", player: "Leka", other: null, detail: null },
    { minute: 60, extra: null, side: "home", kind: "sub", player: "Dervishi", other: "Hoxha", detail: null },
    { minute: 55, extra: null, side: "away", kind: "red", player: "Berisha", other: null, detail: null },
    { minute: 44, extra: 2, side: "away", kind: "penalty", player: "Gashi", other: null, detail: null },
    { minute: 30, extra: null, side: "away", kind: "yellow", player: "Berisha", other: null, detail: null },
    { minute: 12, extra: null, side: "home", kind: "goal", player: "Hoxha", other: "Krasniqi", detail: null },
  ],
  corners: [7, 3], yellow: [0, 1], red: [0, 1], shotsOnTarget: [6, 2], possession: [59, 41],
  stats: [["expected_goals", 1.91, 0.84], ["Ball Possession", 59, 41], ["Total Shots", 14, 7], ["Shots on Goal", 6, 2], ["Shots off Goal", 5, 3], ["Blocked Shots", 3, 2], ["Shots insidebox", 9, 4], ["Shots outsidebox", 5, 3], ["Corner Kicks", 7, 3], ["Offsides", 1, 2], ["Fouls", 9, 12], ["Yellow Cards", 0, 1], ["Red Cards", 0, 1], ["Goalkeeper Saves", 1, 4], ["Total passes", 512, 344], ["Passes accurate", 441, 268], ["Passes %", 86, 78]].map(([type, home, away]) => ({ type, home, away })),
};
const SHEET = (coach: string) => ({ formation: "4-3-3", coach, starting: ["Strakosha", "Hysaj", "Djimsiti", "Ismajli", "Mitaj", "Asllani", "Ramadani", "Bajrami", "Asani", "Broja", "Manaj"].map((name, k) => ({ name, number: k + 1, pos: k === 0 ? "G" : k < 5 ? "D" : k < 8 ? "M" : "F" })), bench: ["Berisha", "Laçi", "Muçi"].map((name, k) => ({ name, number: 12 + k, pos: null })) });
const FULL = { ...CENTRE, lineups: { home: SHEET("Sylvinho"), away: SHEET("Kuqi") } };
const betEvent = (i: number) => { const { home, away } = sides(i); return { id: `ev${i}`, name: `${home} v ${away}`, league: "League", startsAt: new Date(Date.now() - 3_000_000).toISOString(), status: "LIVE", homeScore: 2, awayScore: 1, result: null, elapsed: 67, period: "2H", centre: CENTRE }; };
const FAKE_BETS = [
  { id: "b1", kind: "SINGLE", system: null, legs: [], description: null, stake: 100, odds: 1.8, sp: false, spCap: null, potentialPayout: 180, payout: 0, status: "OPEN", placedAt: new Date().toISOString(), settledAt: null, voidReason: null, selection: { name: "Arsenal", market: "Match winner" }, event: betEvent(0) },
  { id: "b2", kind: "ACCUMULATOR", system: null, description: "Accumulator · 2 picks", stake: 50, odds: 7.38, sp: false, spCap: null, potentialPayout: 369, payout: 0, status: "OPEN", placedAt: new Date().toISOString(), settledAt: null, voidReason: null, selection: null, event: null,
    legs: [{ name: "Club 2", market: "Match winner", odds: 1.8, result: null, voidReason: null, event: betEvent(2) }, { name: "Club 6", market: "Match winner", odds: 4.1, result: null, voidReason: null, event: { ...betEvent(5), status: "UPCOMING", homeScore: null, awayScore: null, centre: null } }] },
];
export async function apiFetch<T>(path: string, _token?: string, _init?: unknown): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (path.startsWith("/odds/events?")) return (path.includes("filter=live") ? FAKE_EVENTS.filter((e) => e.live) : FAKE_EVENTS.filter((e) => !e.live)) as T;
  if (path.startsWith("/odds/favourites")) return ["ev2", "ev9"] as T;
  if (path.endsWith("/centre")) { const id = path.split("/")[3]; const live = ["ev0", "ev2"].includes(id); return { id, status: live ? "LIVE" : id === "ev1" ? "COMPLETED" : "UPCOMING", elapsed: 67, period: "2H", homeScore: 2, awayScore: 1, centre: live ? FULL : null, updatedAt: null } as T; }
  if (path.startsWith("/odds/events/")) {
    const found = FAKE_EVENTS.find((event) => event.id === path.split("/").pop());
    if (found?.id !== "ev0" || !found) return found as T;
    const line = (key: string, name: string, price: number, suspended = false) => ({
      id: key, key, name, suspended,
      selections: [
        { id: `${key}-over`, key: "over", name: `Over ${name.split(" ").pop()}`, price, custom: false, result: null, suspended },
        { id: `${key}-under`, key: "under", name: `Under ${name.split(" ").pop()}`, price: Number((price + 0.2).toFixed(2)), custom: false, result: null, suspended },
      ],
    });
    return {
      ...found,
      marketCount: 10,
      markets: [
        found.markets[0],
        line("goals_0_5", "Total goals 0.5", 1.12, true),
        line("goals_1_5", "Total goals 1.5", 1.35, true),
        line("goals_2_5", "Total goals 2.5", 1.85),
        line("goals_3_5", "Total goals 3.5", 2.4),
        line("goals_4_5", "Total goals 4.5", 4.1, true),
        line("corners_8_5", "Total corners 8.5", 1.9),
        line("corners_9_5", "Total corners 9.5", 2.05),
        line("corners_10_5", "Total corners 10.5", 2.3),
        { id: "btts", key: "btts", name: "Both teams score", suspended: false, selections: [
          { id: "btts-yes", key: "yes", name: "Yes", price: 1.72, custom: false, result: null, suspended: false },
          { id: "btts-no", key: "no", name: "No", price: 2.05, custom: false, result: null, suspended: false },
        ] },
      ],
    } as T;
  }
  if (path.startsWith("/bets/slip")) return { balance: 10000, maxStake: null, dailyLossLimit: null, dailyLossUsed: 0, blocked: null } as T;
  if (path.startsWith("/bets/mine")) return { balance: 10000, open: { count: 2, staked: 150 }, week: { count: 0, staked: 0, returned: 0 }, bets: path.includes("open") ? FAKE_BETS : [], hasMore: false } as T;
  return [] as T;
}
