"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, type OddsEvent, type OddsSelection } from "../lib/api";
import { msg } from "../lib/i18n/core";
import { usePolling } from "../lib/use-polling";
import { HelpTip } from "./help-tip";
import { useI18n } from "./i18n-provider";
import { LoadingSpinner } from "./loading-spinner";

/** Races drawn at first; "Show more races" adds this many again. */
const RACES_SHOWN = 30;
/** Bets close this long before a race's scheduled start (the API's RACE_CLOSE_MS). */
const CLOSE_MS = 60_000;
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/**
 * The jacket colours of each trap: the GB and Irish ones, and Australia's,
 * which differ from trap 2 on.
 */
const TRAP_COLOURS: Record<"GB" | "AU", Array<[string, string]>> = {
  GB: [
    ["#d8262b", "#fff"],
    ["#1f5fbf", "#fff"],
    ["#f4f4f2", "#111"],
    ["#141414", "#fff"],
    ["#f28c1b", "#111"],
    ["repeating-linear-gradient(90deg, #141414 0 4px, #f4f4f2 4px 8px)", "#d8262b"],
    ["#1f8a3b", "#fff"],
    ["#f5d21a", "#111"],
  ],
  AU: [
    ["#d8262b", "#fff"],
    ["repeating-linear-gradient(0deg, #141414 0 4px, #f4f4f2 4px 8px)", "#d8262b"],
    ["#f4f4f2", "#111"],
    ["#1f5fbf", "#fff"],
    ["#f5d21a", "#111"],
    ["#1f8a3b", "#fff"],
    ["#141414", "#fff"],
    ["#f18ab8", "#111"],
    ["#6b3fa0", "#fff"],
    ["#f28c1b", "#111"],
  ],
};

export function Trap({ trap, region }: { trap: number; region: string | null | undefined }) {
  const colours = TRAP_COLOURS[region === "AU" ? "AU" : "GB"];
  const [background, color] = colours[(trap - 1) % colours.length] ?? ["#888", "#fff"];
  return (
    <span className={`race-trap${background.startsWith("repeating") ? " is-striped" : ""}`} style={{ background, color }} aria-label={`Trap ${trap}`}>
      <span>{trap}</span>
    </span>
  );
}

const ORDINALS = [msg("1st"), msg("2nd"), msg("3rd"), msg("4th"), msg("5th"), msg("6th"), msg("7th"), msg("8th"), msg("9th"), msg("10th")];

/**
 * A run race's finishing order: each dog's trap, name and starting price,
 * and the forecast dividend. The dogs' names come from its Winner market.
 */
export function RaceResultList({ race }: { race: OddsEvent }) {
  const { t } = useI18n();
  const region = race.race?.region ?? race.country;
  const dogs = new Map((race.markets.find((m) => m.key === "race_winner")?.selections ?? []).map((dog) => [dog.key, dog]));
  if (race.status === "CANCELLED") return <p className="muted race-result-note">{t("Race called off. Every bet on it was refunded.")}</p>;
  const result = race.raceResult;
  if (!result || result.positions.length === 0) return <p className="muted race-result-note">{t("Waiting for the official result")}</p>;
  return (
    <div className="race-result">
      <ol className="race-result-list">
        {result.positions.map((place) => {
          const dog = dogs.get(`d${place.dogId}`);
          return (
            <li key={place.dogId}>
              <span className="race-result-place">{t(ORDINALS[place.position - 1] ?? `${place.position}`)}</span>
              {dog?.info?.trap ? <Trap trap={dog.info.trap} region={region} /> : null}
              <span className="race-result-dog">{dog?.name ?? "–"}</span>
              <span className="muted">{place.sp ? `SP ${place.sp.toFixed(2)}` : ""}</span>
            </li>
          );
        })}
      </ol>
      {result.positions.filter((p) => p.position === 1).length > 1 ? <p className="muted race-result-note">{t("Dead heat for 1st: Winner bets on these dogs are paid on half the stake.")}</p> : null}
      {result.forecastDividend ? <p className="muted race-result-note">{t("Forecast dividend {amount}", { amount: result.forecastDividend.toFixed(2) })}</p> : null}
      {!result.final ? <p className="muted race-result-note">{t("Provisional result. Bets settle once it's final.")}</p> : null}
    </div>
  );
}

/** The races run in the last few hours, newest first, with their finishing order. */
function LatestResults({ races }: { races: OddsEvent[] }) {
  const { t, tn, date } = useI18n();
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(10);
  if (races.length === 0) return null;
  return (
    <section className="card race-results">
      <button type="button" className="race-results-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <strong>{t("Latest results")}</strong>
        <span className="muted">{tn(races.length, "{count} race", "{count} races")}</span>
      </button>
      {open ? (
        <div className="stack">
          {races.slice(0, limit).map((race) => (
            <article key={race.id} className="race-results-item">
              <header className="race-card-title">
                <strong>
                  {race.league} · {t("Race {number}", { number: race.race?.raceNumber ?? "" })}
                </strong>
                <span className="muted">{date(race.startsAt, TIME)}</span>
              </header>
              <RaceResultList race={race} />
            </article>
          ))}
          {races.length > limit ? (
            <button type="button" className="secondary" onClick={() => setLimit(limit + 10)}>
              {tn(races.length - limit, "Show more races ({count} more)", "Show more races ({count} more)")}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Greyhound races on the bet page: the next races to run, each with its dogs
 * to back to win at the starting price, and a Forecast picker (1st and 2nd in
 * order) paid at the official dividend.
 */
export function GreyhoundRaces({ selected, onPick, active }: { selected: Set<string>; onPick: (event: OddsEvent, market: string, selection: OddsSelection) => void; active: boolean }) {
  const { getToken } = useAuth();
  const { t, tn } = useI18n();
  const [races, setRaces] = useState<OddsEvent[] | null>(null);
  const [results, setResults] = useState<OddsEvent[]>([]);
  const [failed, setFailed] = useState(false);
  const [track, setTrack] = useState("");
  const [limit, setLimit] = useState(RACES_SHOWN);
  /** Races opened for a Forecast, and their full markets once loaded. */
  const [details, setDetails] = useState<Record<string, OddsEvent>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const openRef = useRef(open);
  openRef.current = open;

  const loadDetail = useCallback(
    async (id: string) => {
      const token = await getToken();
      if (!token) return;
      const full = await apiFetch<OddsEvent>(`/odds/events/${id}`, token, { revalidate: true });
      setDetails((current) => (current[id] === full ? current : { ...current, [id]: full }));
    },
    [getToken],
  );

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const [list, finished] = await Promise.all([
      apiFetch<OddsEvent[]>("/odds/events?filter=upcoming&view=list&sport=greyhounds", token, { revalidate: true }),
      apiFetch<OddsEvent[]>("/odds/events?filter=finished&view=list&sport=greyhounds", token, { revalidate: true }).catch(() => null),
    ]);
    setRaces((current) => (current === list ? current : list));
    if (finished) setResults((current) => (current === finished ? current : finished));
    setFailed(false);
    await Promise.all(Array.from(openRef.current, (id) => loadDetail(id).catch(() => undefined)));
  }, [getToken, loadDetail]);

  useEffect(() => {
    if (active) load().catch(() => setFailed(true));
  }, [active, load]);
  usePolling(() => void load().catch(() => undefined), 60_000, active);

  // A race closes a minute before its start: the list is asked again right then.
  useEffect(() => {
    if (!active || !races) return;
    const now = Date.now();
    const next = races.reduce((soonest, race) => {
      const closes = new Date(race.startsAt).getTime() - CLOSE_MS;
      return closes > now && closes < soonest ? closes : soonest;
    }, Infinity);
    if (next - now > 60_000) return;
    const timer = window.setTimeout(() => void load().catch(() => undefined), next - now + 500);
    return () => window.clearTimeout(timer);
  }, [active, races, load]);

  const bettable = useMemo(() => (races ?? []).filter((race) => race.bettable && race.markets.length > 0), [races]);
  const tracks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const race of bettable) counts.set(race.league, (counts.get(race.league) ?? 0) + 1);
    return Array.from(counts).sort((a, b) => a[0].localeCompare(b[0]));
  }, [bettable]);
  const shown = bettable.filter((race) => !track || race.league === track);

  function toggleForecast(id: string) {
    const opening = !open.has(id);
    setOpen((current) => {
      const next = new Set(current);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    if (opening && !details[id]) void loadDetail(id).catch(() => undefined);
  }

  if (races === null) {
    return failed ? (
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>{t("Couldn't load the races")}</p>
      </div>
    ) : (
      <div className="loading-state">
        <LoadingSpinner label="Loading races" />
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="muted race-intro">
        {t("Winner bets pay the dog's starting price (SP), set when the race starts. Forecasts (1st and 2nd in order) pay the official forecast dividend.")}
        <HelpTip text="UK and Irish greyhound racing is bet this way: the price isn't known when you bet. A dog at 3/1 pays back 4 times your stake if it wins. Bets close a minute before the start and settle about 15 minutes after the race." />
      </p>
      {tracks.length > 1 ? (
        <div className="bet-chips" role="group" aria-label={t("Track")}>
          <button type="button" className={`bet-chip${track === "" ? " is-active" : ""}`} onClick={() => (setTrack(""), setLimit(RACES_SHOWN))}>
            {t("All")}
          </button>
          {tracks.map(([name, count]) => (
            <button key={name} type="button" className={`bet-chip${track === name ? " is-active" : ""}`} onClick={() => (setTrack(track === name ? "" : name), setLimit(RACES_SHOWN))}>
              {name}
              <span className="bet-chip-count">{count}</span>
            </button>
          ))}
        </div>
      ) : null}
      <LatestResults races={results} />
      {shown.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>{t("No races are open for bets right now. Check back soon.")}</p>
        </div>
      ) : (
        <>
          {shown.slice(0, limit).map((race) => (
            <RaceCard
              key={race.id}
              race={race}
              detail={details[race.id]}
              forecastOpen={open.has(race.id)}
              onForecast={() => toggleForecast(race.id)}
              selected={selected}
              onPick={onPick}
            />
          ))}
          {shown.length > limit ? (
            <button type="button" className="secondary bet-show-more" onClick={() => setLimit(limit + RACES_SHOWN)}>
              {tn(shown.length - limit, "Show more races ({count} more)", "Show more races ({count} more)")}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Every dog on a race card, for the Odds page: trap, name, trainer, and whether it was withdrawn. */
export function RaceRunnerList({ race }: { race: OddsEvent }) {
  const { t } = useI18n();
  const region = race.race?.region ?? race.country;
  const winner = race.markets.find((market) => market.key === "race_winner");
  return (
    <ul className="race-runners">
      {winner?.selections.map((dog) => (
        <li key={dog.id} className={`race-runner is-plain${dog.suspended ? " is-withdrawn" : ""}`}>
          <Trap trap={dog.info?.trap ?? 0} region={region} />
          <span className="race-runner-name">
            <strong>{dog.name}</strong>
            {dog.suspended ? <span className="muted">{t("Withdrawn")}</span> : dog.info?.trainer ? <span className="muted">{dog.info.trainer}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RaceCard({
  race,
  detail,
  forecastOpen,
  onForecast,
  selected,
  onPick,
}: {
  race: OddsEvent;
  detail?: OddsEvent;
  forecastOpen: boolean;
  onForecast: () => void;
  selected: Set<string>;
  onPick: (event: OddsEvent, market: string, selection: OddsSelection) => void;
}) {
  const { t, date } = useI18n();
  const region = race.race?.region ?? race.country;
  const winner = race.markets.find((market) => market.key === "race_winner");
  const forecast = detail?.markets.find((market) => market.key === "race_forecast");
  const minutes = Math.round((new Date(race.startsAt).getTime() - Date.now()) / 60_000);
  const facts = [race.race?.grade, race.race?.distance ? `${race.race.distance}m` : null].filter(Boolean).join(" · ");
  return (
    <article className="card race-card">
      <header className="race-card-head">
        <div className="race-card-title">
          <strong>{race.league}</strong>
          <span className="muted">
            {t("Race {number}", { number: race.race?.raceNumber ?? "" })}
            {facts ? ` · ${facts}` : ""}
            {region ? ` · ${region}` : ""}
          </span>
        </div>
        <span className="status-pill">
          {date(race.startsAt, TIME)}
          {minutes >= 1 && minutes <= 60 ? ` · ${t("in {count} min", { count: minutes })}` : ""}
        </span>
      </header>
      <ul className="race-runners">
        {winner?.selections.map((dog) => {
          const picked = selected.has(dog.id);
          return (
            <li key={dog.id} className={`race-runner${dog.suspended ? " is-withdrawn" : ""}`}>
              <Trap trap={dog.info?.trap ?? 0} region={region} />
              <span className="race-runner-name">
                <strong>{dog.name}</strong>
                {dog.suspended ? <span className="muted">{t("Withdrawn")}</span> : dog.info?.trainer ? <span className="muted">{dog.info.trainer}</span> : null}
              </span>
              <button
                type="button"
                className={`odds-selection bet-pick race-sp${picked ? " is-selected" : ""}`}
                disabled={dog.suspended}
                aria-pressed={picked}
                aria-label={t("{dog} to win at SP", { dog: dog.name })}
                onClick={() => onPick(race, winner.name, dog)}
              >
                <strong className="odds-price">SP</strong>
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className={`text-button race-forecast-toggle${forecastOpen ? " is-open" : ""}`} onClick={onForecast} aria-expanded={forecastOpen}>
        {forecastOpen ? t("Hide forecast") : t("Forecast: pick 1st and 2nd")}
      </button>
      {forecastOpen ? (
        forecast ? (
          <ForecastPicker race={race} region={region} market={forecast} dogs={winner?.selections ?? []} selected={selected} onPick={onPick} />
        ) : (
          <LoadingSpinner label="Loading" size="small" />
        )
      ) : null}
    </article>
  );
}

function ForecastPicker({
  race,
  region,
  market,
  dogs,
  selected,
  onPick,
}: {
  race: OddsEvent;
  region: string | null | undefined;
  market: OddsEvent["markets"][number];
  dogs: OddsSelection[];
  selected: Set<string>;
  onPick: (event: OddsEvent, market: string, selection: OddsSelection) => void;
}) {
  const { t } = useI18n();
  const [first, setFirst] = useState<number | null>(null);
  const [second, setSecond] = useState<number | null>(null);
  const running = dogs.filter((dog) => !dog.suspended && dog.info?.trap);
  const pair = first !== null && second !== null ? market.selections.find((s) => s.info?.traps?.[0] === first && s.info?.traps?.[1] === second && !s.suspended) : undefined;
  const row = (label: string, value: number | null, other: number | null, set: (trap: number) => void) => (
    <div className="race-forecast-row" role="group" aria-label={label}>
      <span className="muted">{label}</span>
      {running.map((dog) => {
        const trap = dog.info!.trap!;
        return (
          <button
            key={trap}
            type="button"
            className={`race-forecast-trap${value === trap ? " is-active" : ""}`}
            disabled={other === trap}
            aria-pressed={value === trap}
            aria-label={`${label}: ${dog.name}`}
            onClick={() => set(trap)}
          >
            <Trap trap={trap} region={region} />
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="race-forecast">
      {row(t("1st"), first, second, setFirst)}
      {row(t("2nd"), second, first, setSecond)}
      <button
        type="button"
        className={pair && selected.has(pair.id) ? "secondary" : ""}
        disabled={!pair}
        onClick={() => pair && onPick(race, market.name, pair)}
      >
        {pair ? (selected.has(pair.id) ? t("Remove {pick} from the slip", { pick: pair.name }) : t("Add {pick} to the slip", { pick: pair.name })) : t("Pick 1st and 2nd")}
      </button>
    </div>
  );
}
