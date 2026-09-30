"use client";

import { useAuth } from "@clerk/nextjs";
import { useMemo, useState } from "react";
import { apiFetch, type LeagueChoice } from "../lib/api";
import { useI18n } from "./i18n-provider";
import { LoadingSpinner } from "./loading-spinner";
import { useToast } from "./toaster";
import { HelpTip } from "./help-tip";

type League = NonNullable<LeagueChoice["available"]>[number];

const key = (country: string) => country.trim().toLowerCase();

/**
 * Super Admin's pick of competitions the odds feed syncs: single leagues, or
 * every league in a country. Loads when opened, since the list is long.
 */
export function LeaguePicker({ onSaved }: { onSaved: (message: string) => void }) {
  const { getToken } = useAuth();
  const { t, tn, ts } = useI18n();
  const [data, setData] = useState<LeagueChoice | null>(null);
  const [leagues, setLeagues] = useState<Set<number>>(new Set());
  const [countries, setCountries] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [onlyChosen, setOnlyChosen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  function apply(next: LeagueChoice) {
    setData(next);
    setLeagues(new Set(next.leagues));
    setCountries(new Set(next.countries.map(key)));
  }

  async function load() {
    if (data || busy) return;
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    try {
      const next = await apiFetch<LeagueChoice>("/odds/leagues", token);
      apply(next);
      if (next.available === null) toast.error(t("Couldn't load the list of leagues: {error}", { error: ts(next.availableError ?? "") }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  async function save(body: object, message: string) {
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    try {
      apply(await apiFetch<LeagueChoice>("/odds/leagues", token, { method: "PUT", body: JSON.stringify(body) }));
      onSaved(message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  const available = useMemo(() => data?.available ?? [], [data]);
  const countryNames = useMemo(() => new Map(available.map((league) => [key(league.country), league.country])), [available]);
  const knownIds = useMemo(() => new Set(available.map((league) => league.id)), [available]);

  const changed = data !== null && (!sameSet(leagues, new Set(data.leagues)) || !sameSet(countries, new Set(data.countries.map(key))));
  const unknownIds = data?.available ? Array.from(leagues).filter((id) => !knownIds.has(id)) : [];

  const query = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const byCountry = new Map<string, League[]>();
    for (const league of available) {
      const chosen = leagues.has(league.id) || countries.has(key(league.country));
      if (onlyChosen && !chosen) continue;
      if (query && !league.name.toLowerCase().includes(query) && !league.country.toLowerCase().includes(query)) continue;
      byCountry.set(league.country, [...(byCountry.get(league.country) ?? []), league]);
    }
    // International competitions ("World") first, then countries A to Z.
    return Array.from(byCountry).sort(([a], [b]) => (a === "World" ? -1 : b === "World" ? 1 : a.localeCompare(b)));
  }, [available, leagues, countries, onlyChosen, query]);

  function toggleLeague(id: number) {
    setLeagues((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleCountry(country: string) {
    setCountries((current) => {
      const next = new Set(current);
      if (next.has(key(country))) next.delete(key(country));
      else next.add(key(country));
      return next;
    });
  }

  function submit() {
    const chosenCountries = Array.from(countries).map((c) => countryNames.get(c) ?? data?.countries.find((saved) => key(saved) === c) ?? c);
    void save({ leagues: Array.from(leagues), countries: chosenCountries }, t("Leagues saved. The next sync uses them; press Sync now to load them straight away."));
  }

  function reset() {
    if (!window.confirm(t("Go back to the default leagues?"))) return;
    void save({ reset: true }, t("Back to the default leagues."));
  }

  const summary = data
    ? t("{leagues} and {countries}", {
        leagues: tn(leagues.size, "{count} league", "{count} leagues"),
        countries: tn(countries.size, "{count} whole country", "{count} whole countries"),
      })
    : t("Choose which competitions the odds feed brings in.");

  return (
    <details className="card league-picker" onToggle={(event) => (event.currentTarget.open ? void load() : undefined)}>
      <summary>
        <strong>{t("Leagues")}</strong><HelpTip text="Choose which football leagues and cups come into the site. Only matches from ticked leagues can be bet on. More leagues use more of the daily API-Football requests." />
        <span className="muted">{summary}</span>
        {data ? <span className={`league-picker-badge${data.custom ? " is-custom" : ""}`}>{data.custom ? t("Your pick") : t("Defaults")}</span> : null}
      </summary>

      <div className="stack league-picker-body">
        <p className="muted" style={{ margin: 0 }}>
          {t("Matches from the competitions you tick are synced. A whole country brings in every league and cup it has. Matches already listed stay until they're played.")}
        </p>
        {data?.requestsLeft != null ? (
          <p className="muted" style={{ margin: 0 }}>
            {t("API-Football requests left today: {count}. Each league costs up to about 70 a day on days it has matches.", { count: data.requestsLeft })}
          </p>
        ) : null}

        {data === null ? (
          busy ? (
            <div className="loading-state">
              <LoadingSpinner label="Loading leagues" />
            </div>
          ) : null
        ) : data.available === null ? null : (
          <>
            <div className="row league-picker-tools">
              <input type="search" placeholder={t("Search leagues or countries")} value={search} onChange={(event) => setSearch(event.target.value)} aria-label={t("Search leagues or countries")} />
              <label className="league-picker-check">
                <input type="checkbox" checked={onlyChosen} onChange={(event) => setOnlyChosen(event.target.checked)} />
                {t("Only what's ticked")}
              </label>
            </div>

            {unknownIds.length > 0 ? (
              <div className="league-picker-group">
                <strong>{t("Not in the feed this season")}</strong>
                {unknownIds.map((id) => (
                  <label key={id} className="league-picker-check">
                    <input type="checkbox" checked onChange={() => toggleLeague(id)} />
                    {t("League {id}", { id })}
                  </label>
                ))}
              </div>
            ) : null}

            <div className="league-picker-list">
              {groups.length === 0 ? <p className="muted">{t("No leagues match.")}</p> : null}
              {groups.map(([country, list]) => {
                const whole = countries.has(key(country));
                const ticked = whole ? list.length : list.filter((league) => leagues.has(league.id)).length;
                return (
                  <details key={country} className="league-picker-group" open={Boolean(query) || onlyChosen}>
                    <summary>
                      <span>{ts(country)}</span>
                      <span className="muted">{ticked > 0 ? t("{ticked} of {total}", { ticked, total: list.length }) : list.length}</span>
                    </summary>
                    {country !== "World" ? (
                      <label className="league-picker-check league-picker-whole">
                        <input type="checkbox" checked={whole} onChange={() => toggleCountry(country)} />
                        {t("Every league in {country}", { country: ts(country) })}
                      </label>
                    ) : null}
                    {list.map((league) => (
                      <label key={league.id} className="league-picker-check">
                        <input type="checkbox" checked={whole || leagues.has(league.id)} disabled={whole} onChange={() => toggleLeague(league.id)} />
                        {league.name}
                        {league.type === "Cup" ? <span className="muted"> · {t("Cup")}</span> : null}
                      </label>
                    ))}
                  </details>
                );
              })}
            </div>
          </>
        )}

        {data ? (
          <div className="row league-picker-actions">
            <button type="button" onClick={submit} disabled={busy || !changed}>
              {t("Save leagues")}
            </button>
            <button type="button" className="secondary" onClick={() => apply(data)} disabled={busy || !changed}>
              {t("Undo changes")}
            </button>
            {data.custom ? (
              <button type="button" className="secondary" onClick={reset} disabled={busy}>
                {t("Reset to defaults")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && Array.from(a).every((item) => b.has(item));
}
