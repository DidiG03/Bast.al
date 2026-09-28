"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { LoadingSpinner } from "../../../components/loading-spinner";
import { useRealtime } from "../../../components/realtime-provider";
import { apiFetch, type MeResponse, type RiskEvent, type RiskSelection, type RiskView, type UserRow } from "../../../lib/api";
import { formatMoney, formatSignedMoney } from "../../../lib/format";

const dateTimeFormat = new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function when(event: RiskEvent): string {
  if (event.status === "LIVE") return event.homeScore !== null && event.awayScore !== null ? `Live ${event.homeScore}–${event.awayScore}` : "Live";
  if (event.status === "COMPLETED") return "Finished, settling";
  if (event.status === "POSTPONED") return "Postponed";
  return dateTimeFormat.format(new Date(event.startsAt));
}

export default function RiskPage() {
  const { getToken } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [owners, setOwners] = useState<UserRow[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [view, setView] = useState<RiskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isAdmin = me?.role === "SUPER_ADMIN";
  const query = ownerId ? `?ownerId=${encodeURIComponent(ownerId)}` : "";

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) return;
      const profile = await apiFetch<MeResponse>("/users/me", token);
      setMe(profile);
      if (profile.role === "SUPER_ADMIN") {
        const list = (await apiFetch<UserRow[]>("/users", token)).filter((user) => user.role === "OWNER");
        setOwners(list);
        setOwnerId((current) => current || list[0]?.id || "");
      }
    })().catch((err) => setError(err instanceof Error ? err.message : "Could not load your account"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    setView(await apiFetch<RiskView>(`/risk${query}`, token));
    setError(null);
  }, [getToken, query]);

  const ready = me !== null && (!isAdmin || ownerId !== "");

  useEffect(() => {
    if (!ready) return;
    setView(null);
    load().catch((err) => setError(err instanceof Error ? err.message : "Could not load the risk view"));
    // Scores and new bets change the picture; refresh every 30 seconds while the page is open.
    const timer = setInterval(() => void load().catch(() => undefined), 30_000);
    return () => clearInterval(timer);
  }, [ready, load]);

  useRealtime((event) => {
    if (ready && event.type === "resync") void load().catch(() => undefined);
  });

  async function saveCap(cap: number | null): Promise<boolean> {
    const token = await getToken();
    if (!token) return false;
    setError(null);
    setNotice(null);
    try {
      setView(await apiFetch<RiskView>(`/risk/cap${query}`, token, { method: "PUT", body: JSON.stringify({ maxOutcomePayout: cap }) }));
      setNotice(cap === null ? "The payout cap is off." : `New bets are refused once one outcome would pay out more than ${formatMoney(cap)}.`);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the cap");
      return false;
    }
  }

  const noOwners = isAdmin && owners.length === 0;

  return (
    <div className="stack">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>Risk</h1>
          <p className="muted report-subtitle">What the team pays out on each result of the matches with open bets. Worst first.</p>
        </div>
        {isAdmin && owners.length > 0 ? (
          <label className="odds-team-picker">
            <span className="muted">Team</span>
            <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.username}&apos;s team
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="success-text" role="status">{notice}</p> : null}

      {noOwners ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>There are no Owners yet, so there is no team to show.</p>
        </div>
      ) : !view ? (
        !error ? <LoadingSpinner label="Loading risk" /> : null
      ) : (
        <>
          <section className="card stack">
            <dl className="bet-card-numbers risk-totals">
              <div>
                <dt className="muted">Open bets</dt>
                <dd>{view.totals.openBets}</dd>
              </div>
              <div>
                <dt className="muted">Staked</dt>
                <dd>{formatMoney(view.totals.staked)}</dd>
              </div>
              <div>
                <dt className="muted">Biggest payout</dt>
                <dd>
                  <strong>{formatMoney(view.totals.worstCase)}</strong>
                </dd>
              </div>
            </dl>
            {view.canEdit ? <CapEditor cap={view.cap} onSave={saveCap} /> : null}
          </section>

          {view.events.length === 0 ? (
            <div className="card">
              <p className="muted" style={{ margin: 0 }}>No open bets on any match right now.</p>
            </div>
          ) : (
            <div className="risk-events">
              {view.events.map((event) => (
                <RiskEventCard key={event.id} event={event} cap={view.cap} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CapEditor({ cap, onSave }: { cap: number | null; onSave: (cap: number | null) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(cap === null ? "" : String(cap));
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(cap === null ? "" : String(cap)), [cap]);

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 1) return;
    setSaving(true);
    if (await onSave(Math.round(amount * 100) / 100)) setEditing(false);
    setSaving(false);
  }

  async function turnOff() {
    setSaving(true);
    if (await onSave(null)) setEditing(false);
    setSaving(false);
  }

  if (!editing) {
    return (
      <div className="risk-cap">
        <div>
          <strong>Payout cap: {cap === null ? "off" : formatMoney(cap)}</strong>
          <p className="muted" style={{ margin: 0 }}>
            {cap === null
              ? "Set a cap to stop taking bets once one outcome would pay out more than you want to cover."
              : "A new bet is refused if it would take what one outcome pays out above this."}
          </p>
        </div>
        <button type="button" className="secondary" onClick={() => setEditing(true)}>
          {cap === null ? "Set a cap" : "Change"}
        </button>
      </div>
    );
  }

  return (
    <form className="risk-cap" onSubmit={submit}>
      <label className="bet-stake risk-cap-input">
        <span className="muted">Most one outcome can pay out, $</span>
        <input type="number" inputMode="decimal" min={1} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
      </label>
      <div className="odds-editor-actions">
        <button type="submit" disabled={saving}>
          Save
        </button>
        {cap !== null ? (
          <button type="button" className="secondary" onClick={turnOff} disabled={saving}>
            Turn off
          </button>
        ) : null}
        <button type="button" className="text-button" onClick={() => setEditing(false)} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RiskEventCard({ event, cap }: { event: RiskEvent; cap: number | null }) {
  const counts = [event.bets.singles ? `${event.bets.singles} ${event.bets.singles === 1 ? "single" : "singles"}` : "", event.bets.accumulators ? `${event.bets.accumulators} in accumulators` : ""].filter(Boolean).join(" · ");
  const overCap = event.markets.some((market) => market.selections.some((s) => s.overCap));
  return (
    <article className="card stack risk-event">
      <header className="odds-event-header">
        <span className="muted odds-league">{event.league}</span>
        <span className={`status-pill${event.status === "LIVE" ? " is-active" : ""}`}>{when(event)}</span>
      </header>
      <div className="risk-event-title">
        <strong>{event.name}</strong>
        <span className="muted">{counts}</span>
      </div>
      <p className={`risk-worst${overCap ? " is-over" : ""}`}>
        Worst case: <strong>{formatMoney(event.worst.payout)}</strong> if {event.worst.selection} ({event.worst.market})
      </p>
      {event.markets.map((market) => (
        <div key={market.id} className="risk-market">
          <span className="odds-market-name">{market.name}</span>
          <ul className="risk-rows">
            {market.selections.map((selection) => (
              <RiskRow key={selection.id} selection={selection} cap={cap} />
            ))}
          </ul>
        </div>
      ))}
    </article>
  );
}

function RiskRow({ selection, cap }: { selection: RiskSelection; cap: number | null }) {
  const detail = [
    selection.singles.bets ? `${selection.singles.bets} ${selection.singles.bets === 1 ? "single" : "singles"}, ${formatMoney(selection.singles.staked)} staked` : "",
    selection.accumulators.bets ? `${selection.accumulators.bets} ${selection.accumulators.bets === 1 ? "accumulator" : "accumulators"} ${formatMoney(selection.accumulators.payout)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const share = selection.share ?? 0;
  return (
    <li className={`risk-row${selection.overCap ? " is-over" : ""}`}>
      <div className="risk-row-top">
        <span className="risk-row-name">{selection.name}</span>
        <span className="risk-row-payout">
          <strong>{formatMoney(selection.payout)}</strong>
          <span className="muted"> pays out</span>
        </span>
      </div>
      {cap !== null ? (
        <div className="risk-bar" role="img" aria-label={`${Math.round(share * 100)}% of the cap`}>
          <span style={{ width: `${Math.max(share * 100, selection.payout > 0 ? 2 : 0)}%` }} />
        </div>
      ) : null}
      <div className="risk-row-bottom muted">
        <span>{detail || "No bets"}</span>
        {selection.singles.bets || selection.singlesResult !== 0 ? (
          <span className={selection.singlesResult < 0 ? "risk-loss" : "risk-win"}>Singles {formatSignedMoney(selection.singlesResult)}</span>
        ) : null}
      </div>
    </li>
  );
}
