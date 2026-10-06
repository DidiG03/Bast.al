"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { LeaguePicker } from "../../../components/league-picker";
import { MarketPriceHistory } from "../../../components/price-history";
import { usePolling } from "../../../lib/use-polling";
import { apiFetch, type MeResponse, type OddsEvent, type OddsFilter, type OddsSelection, type OddsSettings, type Sport, type UserRow } from "../../../lib/api";
import { RaceResultList, RaceRunnerList } from "../../../components/greyhound-races";
import { useI18n, type I18n } from "../../../components/i18n-provider";
import { useToast } from "../../../components/toaster";
import { msg } from "../../../lib/i18n/core";
import { HelpTip } from "../../../components/help-tip";
import { livePill } from "../../../lib/live";
import { isDaysFromToday } from "../../../lib/time";

const FILTERS: Array<[OddsFilter, string]> = [
  ["upcoming", msg("Upcoming")],
  ["live", msg("Live")],
  ["finished", msg("Finished")],
];

const odds = (value: number) => value.toFixed(2);
/** Matches drawn at first; "Show more matches" adds this many again. */
const MATCHES_SHOWN = 60;

function dayLabel(iso: string, { t, date: format }: I18n): string {
  if (isDaysFromToday(iso, 0)) return t("Today");
  if (isDaysFromToday(iso, 1)) return t("Tomorrow");
  const date = new Date(iso);
  return format(date, { weekday: "long", day: "numeric", month: "short" });
}

function statusText(event: OddsEvent, { t, date }: I18n): string {
  if (event.status === "LIVE") return livePill(event, t);
  if (event.status === "COMPLETED") return t("Full time");
  if (event.status === "POSTPONED") return t("Postponed");
  if (event.status === "CANCELLED") return t("Cancelled");
  return date(event.startsAt, { hour: "2-digit", minute: "2-digit" });
}

function feedLabel(feed: NonNullable<OddsSettings["feed"]>, t: I18n["t"]): string {
  if (feed.mode === "api-football") return "API-Football";
  if (feed.mode === "mock") return t("Test data (not real matches)");
  return t("Not connected");
}

export default function OddsPage() {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t } = i18n;
  const [me, setMe] = useState<MeResponse | null>(null);
  const [owners, setOwners] = useState<UserRow[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [filter, setFilter] = useState<OddsFilter>("upcoming");
  const [sport, setSport] = useState<Sport>("football");
  const [settings, setSettings] = useState<OddsSettings | null>(null);
  const [events, setEvents] = useState<OddsEvent[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [limit, setLimit] = useState(MATCHES_SHOWN);
  /** Bumped after every change, so opened matches load their markets again. */
  const [version, setVersion] = useState(0);
  const toast = useToast();

  const team = ownerId ? `ownerId=${encodeURIComponent(ownerId)}` : "";

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const [nextSettings, nextEvents] = await Promise.all([
      apiFetch<OddsSettings>(`/odds/settings?${team}`, token),
      // Each match's main market only; a match's other markets load when it's opened.
      apiFetch<OddsEvent[]>(`/odds/events?filter=${filter}&view=list&sport=${sport}&${team}`, token),
    ]);
    setSettings(nextSettings);
    setEvents(nextEvents);
  }, [getToken, filter, sport, team]);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) return;
      const profile = await apiFetch<MeResponse>("/users/me", token);
      setMe(profile);
      if (profile.role === "SUPER_ADMIN") {
        const users = await apiFetch<UserRow[]>("/users", token);
        setOwners(users.filter((user) => user.role === "OWNER"));
      }
    })().catch((err) => {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Could not load your account"));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setEvents(null);
    setLimit(MATCHES_SHOWN);
    load().catch((err) => {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Could not load odds"));
    });
  }, [load, toast, t]);

  // Live scores change every few seconds at the source; refresh the Live tab every 30 while it's on screen.
  usePolling(() => void load().catch(() => undefined), 30_000, filter === "live");

  /** Runs a change, reloads, and says whether it worked. */
  async function run(action: (token: string) => Promise<unknown>, success?: string): Promise<boolean> {
    const token = await getToken();
    if (!token) return false;
    try {
      await action(token);
      await load();
      setVersion((v) => v + 1);
      if (success) toast.success(success);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Something went wrong"));
      return false;
    }
  }

  async function syncNow() {
    setSyncing(true);
    await run(async (token) => {
      const result = await apiFetch<{ events: number; markets: number }>("/odds/sync", token, { method: "POST" });
      toast.success(t("Synced {events} matches and {markets} markets.", { events: result.events, markets: result.markets }));
    });
    setSyncing(false);
  }

  const isOwner = me?.role === "OWNER";
  const isAdmin = me?.role === "SUPER_ADMIN";
  const canEditPrices = Boolean(settings?.canEditTeam);

  let subtitle = t("Your Owner's prices for every match. Only Owners can change them.");
  if (isOwner) subtitle = t("Prices come from the feed, less the margin. Tap any price to set your own for your team, up to {percent}% above the feed price.", { percent: settings?.limits.maxAboveFeed ?? 10 });
  if (isAdmin) subtitle = ownerId ? t("This Owner's prices. Changes here apply to their team only.") : t("Feed prices less your base margin, which every team starts from.");

  // The first time, only the spinner shows until your account, the prices and the matches are in.
  if (!me || !settings) return failed ? null : <PageLoading label="Loading odds" />;

  const groups: Array<[string, OddsEvent[]]> = [];
  for (const event of (events ?? []).slice(0, limit)) {
    const label = dayLabel(event.startsAt, i18n);
    const last = groups[groups.length - 1];
    if (last && last[0] === label) last[1].push(event);
    else groups.push([label, [event]]);
  }

  return (
    <div className="stack">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Odds")}</h1>
          <p className="muted report-subtitle">{subtitle}</p>
        </div>
        {isAdmin && owners.length > 0 ? (
          <label className="odds-team-picker">
            <span className="muted">{t("Prices for")}</span><HelpTip text="Pick “Base prices” to see the prices every team starts from, or pick an Owner to see and change that team's own prices." />
            <select id="odds-owner" value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
              <option value="">{t("Base prices")}</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {t("{name}'s team", { name: owner.username })}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {settings ? (
        <MarginsCard settings={settings} run={run} syncing={syncing} onSync={syncNow} ownerQuery={team} />
      ) : null}

      {settings?.canManageEvents && !ownerId && sport === "football" ? <LeaguePicker onSaved={toast.success} /> : null}


      <div className="sport-switch" role="group" aria-label={t("Sport")}>
        {(
          [
            ["football", t("Football")],
            ["greyhounds", t("Greyhounds")],
            ["tennis", t("Tennis")],
            ["basketball", t("Basketball")],
            ["nfl", t("NFL")],
            ["mma", t("MMA")],
          ] as Array<[Sport, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`sport-option${sport === key ? " is-active" : ""}`}
            aria-pressed={sport === key}
            onClick={() => {
              setSport(key);
              // Only football is bet on live: the other sports have no Live tab.
              if (key !== "football" && filter === "live") setFilter("upcoming");
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <nav className="tabs-nav" aria-label={t("Match filter")}>
        {FILTERS.filter(([key]) => sport === "football" || key !== "live").map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab-button ${filter === key ? "is-active" : ""}`}
            onClick={() => setFilter(key)}
            aria-current={filter === key ? "page" : undefined}
          >
            {t(label)}
          </button>
        ))}
      </nav>

      {events === null ? (
        <div className="loading-state">
          <LoadingSpinner label="Loading odds" />
        </div>
      ) : events.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {sport === "basketball"
              ? filter === "finished"
                ? t("No basketball games finished in the last three days.")
                : t("No basketball games yet. They're fetched every 3 hours, from the day before they're played.")
              : sport === "nfl"
              ? filter === "finished"
                ? t("No NFL games finished in the last three days.")
                : t("No NFL games yet. They're fetched every 3 hours, from the day before they're played.")
              : sport === "tennis"
              ? filter === "finished"
                ? t("No tennis matches finished in the last three days.")
                : t("No tennis matches yet. They're fetched every 30 minutes, two days ahead.")
              : sport === "mma"
              ? filter === "finished"
                ? t("No fights finished in the last three days.")
                : t("No fights yet. They're fetched every 2 hours, from the day before they take place.")
              : sport === "greyhounds"
              ? filter === "finished"
                ? t("No races finished in the last six hours.")
                : t("No races yet. Race cards are fetched every 15 minutes once the greyhound feed is connected.")
              : filter === "live"
              ? t("No matches are live right now.")
              : filter === "finished"
                ? t("No matches finished in the last three days.")
                : settings?.feed?.mode === "off"
                  ? t("No matches yet. They'll appear once the odds feed is connected.")
                  : t("No upcoming matches yet. The feed syncs every 10 minutes.")}
          </p>
        </div>
      ) : (
        groups.map(([label, dayEvents]) => (
          <section key={label} className="stack odds-day">
            <h2 className="odds-day-label">{label}</h2><HelpTip text="All matches on this day with their prices. Tap a price to change it for this team. Hide takes a match off the site; Suspend stops new bets on it." />
            {dayEvents.map((event) =>
              event.sport === "greyhounds" ? (
                <RaceAdminCard key={event.id} event={event} canManage={Boolean(settings?.canManageEvents)} run={run} />
              ) : (
                <EventCard key={event.id} event={event} canEditPrices={canEditPrices} canManage={Boolean(settings?.canManageEvents)} ownerQuery={team} run={run} version={version} />
              ),
            )}
          </section>
        ))
      )}
      {events && events.length > limit ? (
        <button type="button" className="secondary bet-show-more" onClick={() => setLimit(limit + MATCHES_SHOWN)}>
          {t("Show more matches ({count} more)", { count: events.length - limit })}
        </button>
      ) : null}
    </div>
  );
}

type Run = (action: (token: string) => Promise<unknown>, success?: string) => Promise<boolean>;

function MarginsCard({ settings, run, syncing, onSync, ownerQuery }: { settings: OddsSettings; run: Run; syncing: boolean; onSync: () => void; ownerQuery: string }) {
  const [base, setBase] = useState(String(settings.baseMargin));
  const [teamMargin, setTeamMargin] = useState(String(settings.team?.margin ?? 0));
  const { t, ts, date } = useI18n();

  useEffect(() => setBase(String(settings.baseMargin)), [settings.baseMargin]);
  const toast = useToast();
  const failedStatus = settings.feed?.status?.startsWith("Failed") ? settings.feed.status : null;
  // A failed feed sync is worth knowing about; it pops up once, not in the page.
  useEffect(() => {
    if (failedStatus) toast.warning(ts(failedStatus), { title: t("Odds feed") });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedStatus]);
  useEffect(() => setTeamMargin(String(settings.team?.margin ?? 0)), [settings.team?.margin, settings.team?.ownerId]);

  function saveBase(event: FormEvent) {
    event.preventDefault();
    void run((token) => apiFetch("/odds/settings/base-margin", token, { method: "PUT", body: JSON.stringify({ margin: Number(base) }) }), t("Base margin saved."));
  }

  function saveTeam(event: FormEvent) {
    event.preventDefault();
    void run(
      (token) => apiFetch(`/odds/settings/team-margin?${ownerQuery}`, token, { method: "PUT", body: JSON.stringify({ margin: Number(teamMargin) }) }),
      t("Team margin saved."),
    );
  }

  const { feed, team } = settings;

  return (
    <section className="card odds-settings">
      {feed ? (
        <div className="odds-setting">
          <span className="muted">{t("Odds feed")}</span><HelpTip text="Where the matches and prices come from (API-Football). It updates by itself; press Sync now to update right away." />
          <strong>{feedLabel(feed, t)}</strong>
          <span className="muted odds-setting-note">
            {feed.syncedAt ? t("Last synced {when}", { when: date(feed.syncedAt, { dateStyle: "medium", timeStyle: "short" }) }) : t("Not synced yet")}

          </span>
          {settings.canManageEvents && feed.mode !== "off" ? (
            <button type="button" className="secondary" onClick={onSync} disabled={syncing}>
              {syncing ? <LoadingSpinner label="Syncing" size="small" /> : t("Sync now")}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="odds-setting">
        <span className="muted">{t("Base margin")}</span><HelpTip text="The house's cut on every price, for every team. A bigger margin means slightly lower prices for Players and more profit for you. Example: with 5%, a 2.00 price is shown as 1.90." />
        {settings.canEditBase ? (
          <form className="commission-input" onSubmit={saveBase}>
            <input id="odds-base-margin" type="number" inputMode="decimal" min={0} max={settings.limits.maxMargin} step="0.1" value={base} onChange={(event) => setBase(event.target.value)} aria-label={t("Base margin in percent")} />
            <span>%</span>
            <button type="submit">{t("Save")}</button>
          </form>
        ) : (
          <strong>{settings.baseMargin}%</strong>
        )}
        <span className="muted odds-setting-note">{t("Set by Super Admin. Taken off every feed price for every team.")}</span>
      </div>

      {team ? (
        <div className="odds-setting">
          <span className="muted">{settings.canEditTeam && settings.team?.ownerName && !ownerQuery ? t("Your team's margin") : t("{name}'s team margin", { name: team.ownerName })}</span><HelpTip text="Extra margin for this team only, added to the base margin. Higher means lower prices for its Players. A minus number gives its Players better prices." />
          {settings.canEditTeam ? (
            <form className="commission-input" onSubmit={saveTeam}>
              <input
                id="odds-team-margin"
                type="number"
                inputMode="decimal"
                min={-settings.baseMargin}
                max={settings.limits.maxMargin - settings.baseMargin}
                step="0.1"
                value={teamMargin}
                onChange={(event) => setTeamMargin(event.target.value)}
                aria-label={t("Team margin in percent")}
              />
              <span>%</span>
              <button type="submit">{t("Save")}</button>
            </form>
          ) : (
            <strong>{team.margin}%</strong>
          )}
          <span className="muted odds-setting-note">
            {t("Added to the base margin, so this team's prices run at {margin}% under the feed. A negative number gives Players better odds, down to the feed price.", { margin: team.effectiveMargin })}
          </span>
        </div>
      ) : null}
    </section>
  );
}

/** Super Admin, Owner or Manager's view of a race: its dogs, or once run its result, and hide/suspend. Races have no prices to change. */
function RaceAdminCard({ event, canManage, run }: { event: OddsEvent; canManage: boolean; run: Run }) {
  const i18n = useI18n();
  const { t } = i18n;
  const finished = event.status === "COMPLETED" || event.status === "CANCELLED";
  const facts = [t("Race {number}", { number: event.race?.raceNumber ?? "" }), event.race?.grade, event.race?.distance ? `${event.race.distance}m` : null].filter(Boolean).join(" · ");

  function toggle(field: "hidden" | "suspended") {
    const next = !event[field];
    const vars = { match: event.name };
    const done = field === "hidden" ? (next ? t("{match} is hidden from everyone.", vars) : t("{match} is visible again.", vars)) : next ? t("{match} is suspended.", vars) : t("{match} is open for bets again.", vars);
    void run((token) => apiFetch(`/odds/events/${event.id}`, token, { method: "PATCH", body: JSON.stringify({ [field]: next }) }), done);
  }

  return (
    <article className={`card odds-event race-card${event.hidden ? " is-hidden" : ""}`}>
      <header className="odds-event-header">
        <span className="muted odds-league">
          {event.league}
          {event.country ? ` · ${event.country}` : ""}
        </span>
        <span className="odds-event-badges">
          {event.hidden ? <span className="status-pill">{t("Hidden")}</span> : null}
          {event.suspended ? <span className="status-pill odds-pill-warn">{t("Suspended")}</span> : null}
          <span className="status-pill">{event.status === "COMPLETED" ? t("Finished") : statusText(event, i18n)}</span>
        </span>
      </header>
      <strong>{facts}</strong>
      {finished ? <RaceResultList race={event} /> : <RaceRunnerList race={event} />}
      {finished ? null : <p className="muted odds-note">{t("Race bets are paid at the starting price (or forecast dividend), less the team margin. There are no prices to change.")}</p>}
      {canManage ? (
        <footer className="odds-event-footer">
          <span />
          <span className="odds-admin-actions">
            <button type="button" className="secondary" onClick={() => toggle("suspended")} disabled={finished}>
              {event.suspended ? t("Resume bets") : t("Suspend")}
            </button>
            <button type="button" className="secondary" onClick={() => toggle("hidden")}>
              {event.hidden ? t("Show") : t("Hide")}
            </button>
          </span>
        </footer>
      ) : null}
    </article>
  );
}

function EventCard({ event, canEditPrices, canManage, ownerQuery, run, version }: { event: OddsEvent; canEditPrices: boolean; canManage: boolean; ownerQuery: string; run: Run; version: number }) {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t, tn, ts } = i18n;
  const [showAll, setShowAll] = useState(false);
  /** Every market, loaded when the match is opened and again after each change. */
  const [full, setFull] = useState<OddsEvent | null>(null);
  useEffect(() => {
    if (!showAll) return;
    let stale = false;
    (async () => {
      const token = await getToken();
      if (!token) return;
      const next = await apiFetch<OddsEvent>(`/odds/events/${event.id}?${ownerQuery}`, token);
      if (!stale) setFull(next);
    })().catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [showAll, version, event.id, ownerQuery, getToken]);
  const [editing, setEditing] = useState<OddsSelection | null>(null);
  const [price, setPrice] = useState("");
  const finished = event.status === "COMPLETED" || event.status === "CANCELLED";
  const markets = showAll && full ? full.markets : event.markets.slice(0, 1);
  const more = Math.max(0, event.marketCount - 1);
  const hasScore = event.homeScore !== null && event.awayScore !== null && event.status !== "UPCOMING";

  function startEdit(selection: OddsSelection) {
    setEditing(selection);
    setPrice(odds(selection.price));
  }

  function savePrice(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!editing) return;
    const selection = editing;
    void run(
      (token) => apiFetch(`/odds/overrides/${selection.id}?${ownerQuery}`, token, { method: "PUT", body: JSON.stringify({ odds: Number(price) }) }),
      t("{pick} set to {odds} for your team.", { pick: ts(selection.name), odds: Number(price).toFixed(2) }),
    ).then((ok) => ok && setEditing(null));
  }

  function resetPrice() {
    if (!editing) return;
    const selection = editing;
    void run((token) => apiFetch(`/odds/overrides/${selection.id}?${ownerQuery}`, token, { method: "DELETE" }), t("{pick} is back to the feed price.", { pick: ts(selection.name) })).then((ok) => ok && setEditing(null));
  }

  function toggle(field: "hidden" | "suspended") {
    const next = !event[field];
    const vars = { match: event.name };
    const done =
      field === "hidden"
        ? next
          ? t("{match} is hidden from everyone.", vars)
          : t("{match} is visible again.", vars)
        : next
          ? t("{match} is suspended.", vars)
          : t("{match} is open for bets again.", vars);
    void run((token) => apiFetch(`/odds/events/${event.id}`, token, { method: "PATCH", body: JSON.stringify({ [field]: next }) }), done);
  }

  return (
    <article className={`card odds-event${event.hidden ? " is-hidden" : ""}`}>
      <header className="odds-event-header">
        <span className="muted odds-league">
          {event.league}
          {event.country ? ` · ${event.country}` : ""}
        </span>
        <span className="odds-event-badges">
          {event.hidden ? <span className="status-pill">{t("Hidden")}</span> : null}
          {event.suspended ? <span className="status-pill odds-pill-warn">{t("Suspended")}</span> : null}
          <span className={`status-pill${event.status === "LIVE" ? " is-active" : ""}`}>{statusText(event, i18n)}</span>
        </span>
      </header>

      <div className="odds-teams">
        <span>{event.homeTeam ?? event.name}</span>
        {hasScore ? <strong className="odds-score">{event.homeScore} – {event.awayScore}</strong> : <span className="muted">v</span>}
        <span>{event.awayTeam ?? ""}</span>
      </div>

      {event.status === "LIVE" ? (
        <p className="muted odds-note">
          {event.bettable
            ? t("Live prices from the feed, less the team margin. Your own fixed prices only apply before kick-off.")
            : t("Live betting on this match is paused: the feed has stopped or suspended it, or its prices are out of date.")}
        </p>
      ) : null}

      {event.markets.length === 0 ? (
        event.status === "LIVE" ? null : <p className="muted odds-note">{t("No odds from the feed yet.")}</p>
      ) : (
        markets.map((market) => (
          <div key={market.id} className="odds-market">
            <span className="odds-market-name">
              {ts(market.name)}
              {market.suspended ? <span className="muted"> · {t("Suspended")}</span> : null}
            </span>
            <div className="odds-selections">
              {market.selections.map((selection) => {
                const content = (
                  <>
                    <span className="odds-selection-name">{ts(selection.name)}</span>
                    <strong className="odds-price">{odds(selection.price)}</strong>
                    {selection.feedOdds !== undefined ? (
                      <span className="odds-feed">{selection.custom ? t("Your price") : t("Feed {odds}", { odds: odds(selection.feedOdds) })}</span>
                    ) : null}
                  </>
                );
                const className = `odds-selection${selection.custom ? " is-custom" : ""}${selection.result === "WON" ? " is-won" : ""}${editing?.id === selection.id ? " is-editing" : ""}`;
                return canEditPrices && !finished && event.status !== "LIVE" ? (
                  <button key={selection.id} type="button" className={className} onClick={() => startEdit(selection)} aria-label={t("Change the price for {pick}, now {odds}", { pick: ts(selection.name), odds: odds(selection.price) })}>
                    {content}
                  </button>
                ) : (
                  <div key={selection.id} className={className}>
                    {content}
                  </div>
                );
              })}
            </div>
            {editing && market.selections.some((s) => s.id === editing.id) ? (
              <form className="odds-editor" onSubmit={savePrice}>
                <label className="field">
                  <span>
                    {t("Your price for {pick}", { pick: ts(editing.name) })}
                    {editing.feedOdds !== undefined ? (
                      <span className="muted">
                        {" "}
                        ({editing.maxPrice !== undefined ? t("feed {odds}, at most {max}", { odds: odds(editing.feedOdds), max: odds(editing.maxPrice) }) : t("feed {odds}", { odds: odds(editing.feedOdds) })})
                      </span>
                    ) : null}
                  </span>
                  <input id={`odds-price-${editing.id}`} type="number" inputMode="decimal" min={1.01} max={editing.maxPrice ?? 1000} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
                </label>
                <div className="odds-editor-actions">
                  <button type="submit">{t("Save")}</button>
                  {editing.custom ? (
                    <button type="button" className="secondary" onClick={resetPrice}>
                      {t("Use feed price")}
                    </button>
                  ) : null}
                  <button type="button" className="secondary" onClick={() => setEditing(null)}>
                    {t("Cancel")}
                  </button>
                </div>
              </form>
            ) : null}
            {/* A goalscorer list is too long for the chart. */}
            {market.key.startsWith("scorer_") ? null : <MarketPriceHistory selections={market.selections} />}
          </div>
        ))
      )}

      <footer className="odds-event-footer">
        {more > 0 ? (
          <button type="button" className="text-button" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
            {showAll ? (full ? t("Fewer markets") : t("Loading markets")) : tn(more, "{count} more market", "{count} more markets")}
          </button>
        ) : (
          <span />
        )}
        {canManage ? (
          <span className="odds-admin-actions">
            <button type="button" className="secondary" onClick={() => toggle("suspended")} disabled={finished}>
              {event.suspended ? t("Resume bets") : t("Suspend")}
            </button>
            <button type="button" className="secondary" onClick={() => toggle("hidden")}>
              {event.hidden ? t("Show") : t("Hide")}
            </button>
          </span>
        ) : null}
      </footer>
    </article>
  );
}
