"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { LoadingSpinner } from "../../../components/loading-spinner";
import { MarketPriceHistory } from "../../../components/price-history";
import { apiFetch, type MeResponse, type OddsEvent, type OddsFilter, type OddsSelection, type OddsSettings, type UserRow } from "../../../lib/api";

const FILTERS: Array<[OddsFilter, string]> = [
  ["upcoming", "Upcoming"],
  ["live", "Live"],
  ["finished", "Finished"],
];

const odds = (value: number) => value.toFixed(2);

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "short" }).format(date);
}

const timeFormat = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });

function statusText(event: OddsEvent): string {
  if (event.status === "LIVE") return event.elapsed === null ? "Live" : `Live ${event.elapsed}'`;
  if (event.status === "COMPLETED") return "Full time";
  if (event.status === "POSTPONED") return "Postponed";
  if (event.status === "CANCELLED") return "Cancelled";
  return timeFormat.format(new Date(event.startsAt));
}

function feedLabel(feed: NonNullable<OddsSettings["feed"]>): string {
  if (feed.mode === "api-football") return "API-Football";
  if (feed.mode === "mock") return "Test data (not real matches)";
  return "Not connected";
}

export default function OddsPage() {
  const { getToken } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [owners, setOwners] = useState<UserRow[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [filter, setFilter] = useState<OddsFilter>("upcoming");
  const [settings, setSettings] = useState<OddsSettings | null>(null);
  const [events, setEvents] = useState<OddsEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const team = ownerId ? `ownerId=${encodeURIComponent(ownerId)}` : "";

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const [nextSettings, nextEvents] = await Promise.all([
      apiFetch<OddsSettings>(`/odds/settings?${team}`, token),
      apiFetch<OddsEvent[]>(`/odds/events?filter=${filter}&${team}`, token),
    ]);
    setSettings(nextSettings);
    setEvents(nextEvents);
    setError(null);
  }, [getToken, filter, team]);

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
    })().catch((err) => setError(err instanceof Error ? err.message : "Could not load your account"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setEvents(null);
    load().catch((err) => setError(err instanceof Error ? err.message : "Could not load odds"));
  }, [load]);

  // Live scores change every few seconds at the source; refresh the Live tab every 30.
  useEffect(() => {
    if (filter !== "live") return;
    const timer = setInterval(() => void load().catch(() => undefined), 30_000);
    return () => clearInterval(timer);
  }, [filter, load]);

  /** Runs a change, reloads, and says whether it worked. */
  async function run(action: (token: string) => Promise<unknown>, success?: string): Promise<boolean> {
    const token = await getToken();
    if (!token) return false;
    setError(null);
    setNotice(null);
    try {
      await action(token);
      await load();
      if (success) setNotice(success);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      return false;
    }
  }

  async function syncNow() {
    setSyncing(true);
    await run(async (token) => {
      const result = await apiFetch<{ events: number; markets: number }>("/odds/sync", token, { method: "POST" });
      setNotice(`Synced ${result.events} matches and ${result.markets} markets.`);
    });
    setSyncing(false);
  }

  const isOwner = me?.role === "OWNER";
  const isAdmin = me?.role === "SUPER_ADMIN";
  const canEditPrices = Boolean(settings?.canEditTeam);

  let subtitle = "Your Owner's prices for every match. Only Owners can change them.";
  if (isOwner) subtitle = "Prices come from the feed, less the margin. Tap any price to set your own for your team.";
  if (isAdmin) subtitle = ownerId ? "This Owner's prices. Changes here apply to their team only." : "Feed prices less your base margin, which every team starts from.";

  const groups: Array<[string, OddsEvent[]]> = [];
  for (const event of events ?? []) {
    const label = dayLabel(event.startsAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === label) last[1].push(event);
    else groups.push([label, [event]]);
  }

  return (
    <div className="stack">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>Odds</h1>
          <p className="muted report-subtitle">{subtitle}</p>
        </div>
        {isAdmin && owners.length > 0 ? (
          <label className="odds-team-picker">
            <span className="muted">Prices for</span>
            <select id="odds-owner" value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
              <option value="">Base prices</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.username}&apos;s team
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {settings ? (
        <MarginsCard settings={settings} run={run} syncing={syncing} onSync={syncNow} ownerQuery={team} />
      ) : null}

      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="success-text" role="status">{notice}</p> : null}

      <nav className="tabs-nav" aria-label="Match filter">
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab-button ${filter === key ? "is-active" : ""}`}
            onClick={() => setFilter(key)}
            aria-current={filter === key ? "page" : undefined}
          >
            {label}
          </button>
        ))}
      </nav>

      {events === null ? (
        <LoadingSpinner label="Loading odds" />
      ) : events.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {filter === "live" ? "No matches are live right now." : filter === "finished" ? "No matches finished in the last three days." : settings?.feed?.mode === "off" ? "No matches yet. They'll appear once the odds feed is connected." : "No upcoming matches yet. The feed syncs every 10 minutes."}
          </p>
        </div>
      ) : (
        groups.map(([label, dayEvents]) => (
          <section key={label} className="stack odds-day">
            <h2 className="odds-day-label">{label}</h2>
            {dayEvents.map((event) => (
              <EventCard key={event.id} event={event} canEditPrices={canEditPrices} canManage={Boolean(settings?.canManageEvents)} ownerQuery={team} run={run} />
            ))}
          </section>
        ))
      )}
    </div>
  );
}

type Run = (action: (token: string) => Promise<unknown>, success?: string) => Promise<boolean>;

function MarginsCard({ settings, run, syncing, onSync, ownerQuery }: { settings: OddsSettings; run: Run; syncing: boolean; onSync: () => void; ownerQuery: string }) {
  const [base, setBase] = useState(String(settings.baseMargin));
  const [teamMargin, setTeamMargin] = useState(String(settings.team?.margin ?? 0));

  useEffect(() => setBase(String(settings.baseMargin)), [settings.baseMargin]);
  useEffect(() => setTeamMargin(String(settings.team?.margin ?? 0)), [settings.team?.margin, settings.team?.ownerId]);

  function saveBase(event: FormEvent) {
    event.preventDefault();
    void run((token) => apiFetch("/odds/settings/base-margin", token, { method: "PUT", body: JSON.stringify({ margin: Number(base) }) }), "Base margin saved.");
  }

  function saveTeam(event: FormEvent) {
    event.preventDefault();
    void run(
      (token) => apiFetch(`/odds/settings/team-margin?${ownerQuery}`, token, { method: "PUT", body: JSON.stringify({ margin: Number(teamMargin) }) }),
      "Team margin saved.",
    );
  }

  const { feed, team } = settings;

  return (
    <section className="card odds-settings">
      {feed ? (
        <div className="odds-setting">
          <span className="muted">Odds feed</span>
          <strong>{feedLabel(feed)}</strong>
          <span className="muted odds-setting-note">
            {feed.syncedAt ? `Last synced ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(feed.syncedAt))}` : "Not synced yet"}
            {feed.status?.startsWith("Failed") ? <span className="error-text"> · {feed.status}</span> : null}
          </span>
          {settings.canManageEvents && feed.mode !== "off" ? (
            <button type="button" className="secondary" onClick={onSync} disabled={syncing}>
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="odds-setting">
        <span className="muted">Base margin</span>
        {settings.canEditBase ? (
          <form className="commission-input" onSubmit={saveBase}>
            <input id="odds-base-margin" type="number" inputMode="decimal" min={0} max={settings.limits.maxMargin} step="0.1" value={base} onChange={(event) => setBase(event.target.value)} aria-label="Base margin in percent" />
            <span>%</span>
            <button type="submit">Save</button>
          </form>
        ) : (
          <strong>{settings.baseMargin}%</strong>
        )}
        <span className="muted odds-setting-note">Set by Super Admin. Taken off every feed price for every team.</span>
      </div>

      {team ? (
        <div className="odds-setting">
          <span className="muted">{settings.canEditTeam && settings.team?.ownerName && !ownerQuery ? "Your team's margin" : `${team.ownerName}'s team margin`}</span>
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
                aria-label="Team margin in percent"
              />
              <span>%</span>
              <button type="submit">Save</button>
            </form>
          ) : (
            <strong>{team.margin}%</strong>
          )}
          <span className="muted odds-setting-note">
            Added to the base margin, so this team&apos;s prices run at {team.effectiveMargin}% under the feed. A negative number gives Players better odds, down to the feed price.
          </span>
        </div>
      ) : null}
    </section>
  );
}

function EventCard({ event, canEditPrices, canManage, ownerQuery, run }: { event: OddsEvent; canEditPrices: boolean; canManage: boolean; ownerQuery: string; run: Run }) {
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<OddsSelection | null>(null);
  const [price, setPrice] = useState("");
  const finished = event.status === "COMPLETED" || event.status === "CANCELLED";
  const markets = showAll ? event.markets : event.markets.slice(0, 1);
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
      `${selection.name} set to ${Number(price).toFixed(2)} for your team.`,
    ).then((ok) => ok && setEditing(null));
  }

  function resetPrice() {
    if (!editing) return;
    const selection = editing;
    void run((token) => apiFetch(`/odds/overrides/${selection.id}?${ownerQuery}`, token, { method: "DELETE" }), `${selection.name} is back to the feed price.`).then((ok) => ok && setEditing(null));
  }

  function toggle(field: "hidden" | "suspended") {
    const next = !event[field];
    const verb = field === "hidden" ? (next ? "hidden from everyone" : "visible again") : next ? "suspended" : "open for bets again";
    void run((token) => apiFetch(`/odds/events/${event.id}`, token, { method: "PATCH", body: JSON.stringify({ [field]: next }) }), `${event.name} is ${verb}.`);
  }

  return (
    <article className={`card odds-event${event.hidden ? " is-hidden" : ""}`}>
      <header className="odds-event-header">
        <span className="muted odds-league">
          {event.league}
          {event.country ? ` · ${event.country}` : ""}
        </span>
        <span className="odds-event-badges">
          {event.hidden ? <span className="status-pill">Hidden</span> : null}
          {event.suspended ? <span className="status-pill odds-pill-warn">Suspended</span> : null}
          <span className={`status-pill${event.status === "LIVE" ? " is-active" : ""}`}>{statusText(event)}</span>
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
            ? "Live prices from the feed, less the team margin. Your own fixed prices only apply before kick-off."
            : "Live betting on this match is paused: the feed has stopped or suspended it, or its prices are out of date."}
        </p>
      ) : null}

      {event.markets.length === 0 ? (
        event.status === "LIVE" ? null : <p className="muted odds-note">No odds from the feed yet.</p>
      ) : (
        markets.map((market) => (
          <div key={market.id} className="odds-market">
            <span className="odds-market-name">
              {market.name}
              {market.suspended ? <span className="muted"> · Suspended</span> : null}
            </span>
            <div className="odds-selections">
              {market.selections.map((selection) => {
                const content = (
                  <>
                    <span className="odds-selection-name">{selection.name}</span>
                    <strong className="odds-price">{odds(selection.price)}</strong>
                    {selection.feedOdds !== undefined ? (
                      <span className="odds-feed">{selection.custom ? "Your price" : `Feed ${odds(selection.feedOdds)}`}</span>
                    ) : null}
                  </>
                );
                const className = `odds-selection${selection.custom ? " is-custom" : ""}${selection.result === "WON" ? " is-won" : ""}${editing?.id === selection.id ? " is-editing" : ""}`;
                return canEditPrices && !finished && event.status !== "LIVE" ? (
                  <button key={selection.id} type="button" className={className} onClick={() => startEdit(selection)} aria-label={`Change the price for ${selection.name}, now ${odds(selection.price)}`}>
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
                    Your price for {editing.name}
                    {editing.feedOdds !== undefined ? <span className="muted"> (feed {odds(editing.feedOdds)})</span> : null}
                  </span>
                  <input id={`odds-price-${editing.id}`} type="number" inputMode="decimal" min={1.01} max={1000} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
                </label>
                <div className="odds-editor-actions">
                  <button type="submit">Save</button>
                  {editing.custom ? (
                    <button type="button" className="secondary" onClick={resetPrice}>
                      Use feed price
                    </button>
                  ) : null}
                  <button type="button" className="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
            <MarketPriceHistory selections={market.selections} />
          </div>
        ))
      )}

      <footer className="odds-event-footer">
        {event.markets.length > 1 ? (
          <button type="button" className="text-button" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Fewer markets" : `${event.markets.length - 1} more markets`}
          </button>
        ) : (
          <span />
        )}
        {canManage ? (
          <span className="odds-admin-actions">
            <button type="button" className="secondary" onClick={() => toggle("suspended")} disabled={finished}>
              {event.suspended ? "Resume bets" : "Suspend"}
            </button>
            <button type="button" className="secondary" onClick={() => toggle("hidden")}>
              {event.hidden ? "Show" : "Hide"}
            </button>
          </span>
        ) : null}
      </footer>
    </article>
  );
}
