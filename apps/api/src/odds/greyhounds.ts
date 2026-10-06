import { SelectionResult } from "@prisma/client";
import { applyMargin } from "./pricing";
export { RACE_CLOSE_MS } from "./pricing";

/**
 * Greyhound racing from GreyhoundAPI (https://greyhoundapi.com): race cards
 * for GB, IE and AU tracks, and each race's official result. There are no
 * prices before a race, so race bets are paid the way UK bookmakers take
 * them: a Winner bet at the dog's starting price (SP), a Forecast (1st and
 * 2nd in order) at the official forecast dividend, and a Tricast (1st, 2nd
 * and 3rd in order) at the official tricast dividend, all less the team's
 * margin and never above a ceiling (RACE_CAP).
 *
 * Settling, the usual rules:
 * - A dog withdrawn before the race: Winner bets on it are void, and so are
 *   Forecasts and Tricasts that name it. A reserve that runs from its trap is
 *   a new runner.
 * - A void or abandoned race: everything is void.
 * - A dead heat for 1st: a Winner bet on one of the dogs is paid on its
 *   stake divided by how many dead-heated. A Forecast or Tricast touched by a
 *   dead heat waits for Super Admin.
 * - A dog that ran but didn't finish (or was disqualified) has lost.
 */

export const RACE_PROVIDER = "greyhoundapi";
export const RACE_WINNER = "race_winner";
export const RACE_FORECAST = "race_forecast";
export const RACE_TRICAST = "race_tricast";
export const isRaceMarket = (marketKey: string) => marketKey === RACE_WINNER || marketKey === RACE_FORECAST || marketKey === RACE_TRICAST;
/** A Tricast is offered on fields of up to this many dogs (6 is 120 outcomes; 8 would be 336). */
const TRICAST_MAX_FIELD = 6;

/** The most a race bet can be settled at, and what the team's open payouts count it at until then. */
export const RACE_CAP: Record<string, number> = {
  [RACE_WINNER]: Number(process.env.GREYHOUND_MAX_SP) || 51,
  [RACE_FORECAST]: Number(process.env.GREYHOUND_MAX_FORECAST) || 500,
  [RACE_TRICAST]: Number(process.env.GREYHOUND_MAX_TRICAST) || 2000,
};

export type RunnerStatus = "runner" | "reserve" | "withdrawn" | "disqualified";

export type FeedRunner = { dogId: number; name: string; trap: number; trainer: string | null; status: RunnerStatus };

export type FeedRace = {
  externalId: string;
  track: string;
  region: string;
  raceNumber: number;
  grade: string | null;
  distance: number | null;
  startsAt: Date;
  /** scheduled, off, results_pending, complete, void or abandoned. */
  status: string;
  runners: FeedRunner[];
  result: RaceResult | null;
};

/** What Event.raceResult keeps: the finishing order with each dog's SP, and the forecast and tricast dividends. */
export type RaceResult = {
  /** Provisional results wait; only final ones settle. */
  final: boolean;
  positions: Array<{ dogId: number; position: number; sp: number | null }>;
  forecastDividend: number | null;
  /** Missing on results saved before the Tricast was offered. */
  tricastDividend?: number | null;
};

/** What Event.race keeps. */
export type RaceInfo = { raceNumber: number; grade: string | null; distance: number | null; region: string; runners: Array<{ dogId: number; status: RunnerStatus }> };

type RawRunner = { trap?: number; dog_id?: number; dog_name?: string; trainer?: { name?: string } | null; runner_status?: string };
type RawPosition = { position?: number; dog_id?: number; sp?: { decimal?: number | string } | number | null };
export type RawRace = {
  race_id: number | string;
  region?: string;
  track?: { name?: string };
  race_number?: number;
  grade?: string | null;
  distance_m?: number | null;
  scheduled_start?: { utc?: string };
  status?: string;
  runners?: RawRunner[];
  result?: { result_status?: string; positions?: RawPosition[]; forecast_dividend?: string | number | null; tricast_dividend?: string | number | null } | null;
};

const STATUSES: RunnerStatus[] = ["runner", "reserve", "withdrawn", "disqualified"];

const decimal = (value: unknown): number | null => {
  const n = typeof value === "object" && value !== null ? Number((value as { decimal?: unknown }).decimal) : Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) && n > 0 ? n : null;
};

export function parseRace(raw: RawRace): FeedRace | null {
  const startsAt = new Date(raw.scheduled_start?.utc ?? "");
  if (!raw.race_id || Number.isNaN(startsAt.getTime()) || !raw.track?.name) return null;
  const runners: FeedRunner[] = (raw.runners ?? [])
    .filter((r) => Number.isInteger(r.dog_id) && Number.isInteger(r.trap) && r.dog_name)
    .map((r) => ({
      dogId: r.dog_id!,
      name: r.dog_name!.trim(),
      trap: r.trap!,
      trainer: r.trainer?.name?.trim() || null,
      status: STATUSES.includes(r.runner_status as RunnerStatus) ? (r.runner_status as RunnerStatus) : "runner",
    }))
    .sort((a, b) => a.trap - b.trap);
  const positions = (raw.result?.positions ?? [])
    .filter((p) => Number.isInteger(p.dog_id) && Number.isInteger(p.position))
    .map((p) => ({ dogId: p.dog_id!, position: p.position!, sp: decimal(p.sp) }))
    .sort((a, b) => a.position - b.position);
  return {
    externalId: String(raw.race_id),
    track: raw.track.name.trim(),
    region: raw.region ?? "",
    raceNumber: raw.race_number ?? 0,
    grade: raw.grade?.trim() || null,
    distance: raw.distance_m ?? null,
    startsAt,
    status: raw.status ?? "scheduled",
    runners,
    result: positions.length > 0 ? { final: raw.result?.result_status === "final", positions, forecastDividend: decimal(raw.result?.forecast_dividend), tricastDividend: decimal(raw.result?.tricast_dividend) } : null,
  };
}

export const dogKey = (dogId: number) => `d${dogId}`;
export const forecastKey = (first: number, second: number) => `d${first}-d${second}`;
export const tricastKey = (first: number, second: number, third: number) => `d${first}-d${second}-d${third}`;

export type RaceMarket = {
  key: string;
  name: string;
  sortOrder: number;
  selections: Array<{ key: string; name: string; sortOrder: number; info: Record<string, unknown>; withdrawn: boolean }>;
};

/**
 * A race's markets. Every dog on the card is listed (a withdrawn one can't
 * be bet on); Forecast has every 1st–2nd pair of dogs, and Tricast (on
 * fields of up to TRICAST_MAX_FIELD) every 1st–2nd–3rd.
 */
export function raceMarkets(race: FeedRace): RaceMarket[] {
  const dogs = race.runners;
  const out = (dog: FeedRunner) => dog.status === "withdrawn";
  const tricast: RaceMarket[] =
    dogs.length >= 3 && dogs.length <= TRICAST_MAX_FIELD
      ? [
          {
            key: RACE_TRICAST,
            name: "Tricast",
            sortOrder: 2,
            selections: dogs.flatMap((first) =>
              dogs.flatMap((second) =>
                dogs
                  .filter((third) => second.dogId !== first.dogId && third.dogId !== first.dogId && third.dogId !== second.dogId)
                  .map((third) => ({
                    key: tricastKey(first.dogId, second.dogId, third.dogId),
                    name: `${first.name} → ${second.name} → ${third.name}`,
                    sortOrder: first.trap * 10_000 + second.trap * 100 + third.trap,
                    info: { traps: [first.trap, second.trap, third.trap] },
                    withdrawn: out(first) || out(second) || out(third),
                  })),
              ),
            ),
          },
        ]
      : [];
  return [
    {
      key: RACE_WINNER,
      name: "Winner",
      sortOrder: 0,
      selections: dogs.map((dog) => ({ key: dogKey(dog.dogId), name: dog.name, sortOrder: dog.trap, info: { trap: dog.trap, trainer: dog.trainer }, withdrawn: out(dog) })),
    },
    {
      key: RACE_FORECAST,
      name: "Forecast",
      sortOrder: 1,
      selections: dogs.flatMap((first) =>
        dogs
          .filter((second) => second.dogId !== first.dogId)
          .map((second) => ({
            key: forecastKey(first.dogId, second.dogId),
            name: `${first.name} → ${second.name}`,
            sortOrder: first.trap * 100 + second.trap,
            info: { traps: [first.trap, second.trap] },
            withdrawn: out(first) || out(second),
          })),
      ),
    },
    ...tricast,
  ];
}

const dogsOf = (selectionKey: string): number[] => selectionKey.split("-").map((part) => Number(part.slice(1)));

/**
 * One race outcome's result: null while the result isn't final, or when it
 * can't be settled for sure (a dead heat in a Forecast). `withdrawn` is the
 * selection's flag: a dog withdrawn or taken off the card, or a pair with one.
 */
export function gradeRace(marketKey: string, selectionKey: string, result: RaceResult | null, withdrawn: boolean): SelectionResult | null {
  if (withdrawn) return SelectionResult.VOID;
  const dogs = dogsOf(selectionKey);
  if (!result?.final) return null;
  const at = (position: number) => result.positions.filter((p) => p.position === position).map((p) => p.dogId);
  if (marketKey === RACE_WINNER) return at(1).includes(dogs[0]) ? SelectionResult.WON : SelectionResult.LOST;
  if (marketKey === RACE_FORECAST) {
    const [first, second] = [at(1), at(2)];
    if (first.length !== 1 || second.length > 1) return null;
    if (second.length === 0) return first[0] === dogs[0] ? null : SelectionResult.LOST;
    return first[0] === dogs[0] && second[0] === dogs[1] ? SelectionResult.WON : SelectionResult.LOST;
  }
  if (marketKey === RACE_TRICAST) {
    const placed = [at(1), at(2), at(3)];
    // A dead heat anywhere in the first three waits for Super Admin.
    if (placed.some((dogsAt) => dogsAt.length > 1)) return null;
    // Fewer than three finished: lost unless the ones that did match so far (then it waits).
    const finished = placed.filter((dogsAt) => dogsAt.length === 1).map((dogsAt) => dogsAt[0]);
    const matches = finished.every((dog, i) => dog === dogs[i]);
    if (finished.length < 3) return matches ? null : SelectionResult.LOST;
    return matches ? SelectionResult.WON : SelectionResult.LOST;
  }
  return null;
}

/**
 * The price a winning race bet is paid at: the SP (Winner), or the forecast
 * or tricast dividend, less the margin, never above the cap, and for a dead heat
 * divided by how many dogs shared 1st. Null while the feed hasn't sent it.
 */
export function raceSettlePrice(marketKey: string, selectionKey: string, result: RaceResult | null, margin: number, cap: number): number | null {
  if (!result) return null;
  let raw: number | null = null;
  let share = 1;
  if (marketKey === RACE_WINNER) {
    const dog = dogsOf(selectionKey)[0];
    raw = result.positions.find((p) => p.dogId === dog)?.sp ?? null;
    share = Math.max(1, result.positions.filter((p) => p.position === 1).length);
  } else if (marketKey === RACE_FORECAST) {
    raw = result.forecastDividend;
  } else if (marketKey === RACE_TRICAST) {
    raw = result.tricastDividend ?? null;
  }
  if (raw === null) return null;
  const price = Math.min(applyMargin(raw, margin), cap);
  return Math.floor((price / share) * 100 + 1e-6) / 100;
}

export function raceResultOf(value: unknown): RaceResult | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as RaceResult).positions)) return null;
  return value as RaceResult;
}

/** GET from GreyhoundAPI. Throws on anything but a 200. */
export function greyhoundFetch(key: string) {
  return async <T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(`https://api.greyhoundapi.com/v1${path}`);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
    const res = await fetch(url, { headers: { "X-API-Key": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GreyhoundAPI ${path} answered ${res.status}`);
    return (await res.json()) as T;
  };
}
