"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { BetLegs } from "../../../components/bet-legs";
import { LoadingSpinner } from "../../../components/loading-spinner";
import { apiFetch, type AdminBet, type BetStatus, type SettlementEvent } from "../../../lib/api";
import { formatMoney } from "../../../lib/format";
import { useIdempotencyKey } from "../../../lib/use-idempotency-key";

const dateTimeFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const STATUS_TEXT: Record<SettlementEvent["status"], string> = {
  UPCOMING: "Not started",
  LIVE: "Live",
  COMPLETED: "Finished",
  POSTPONED: "Postponed",
  CANCELLED: "Cancelled",
};

type Run = (path: string, body: object, success: string) => Promise<boolean>;

/**
 * Super Admin: bets settle on their own from the feed's final scores. This
 * page is for the exceptions: a wrong or missing result, a match that needs
 * voiding, or a single bet to void.
 */
export default function SettlementPage() {
  const { getToken } = useAuth();
  const idempotency = useIdempotencyKey();
  const [events, setEvents] = useState<SettlementEvent[] | null>(null);
  const [bets, setBets] = useState<AdminBet[] | null>(null);
  const [status, setStatus] = useState<BetStatus | "">("");
  const [player, setPlayer] = useState("");
  const [eventId, setEventId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    setEvents(await apiFetch<SettlementEvent[]>("/bets/admin/events", token));
  }, [getToken]);

  const loadBets = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const query = new URLSearchParams();
    if (status) query.set("status", status);
    if (player.trim()) query.set("player", player.trim());
    if (eventId) query.set("eventId", eventId);
    setBets(await apiFetch<AdminBet[]>(`/bets/admin?${query}`, token));
  }, [getToken, status, player, eventId]);

  useEffect(() => {
    loadEvents().catch((err) => setError(err instanceof Error ? err.message : "Could not load matches"));
  }, [loadEvents]);

  useEffect(() => {
    const timer = setTimeout(() => loadBets().catch((err) => setError(err instanceof Error ? err.message : "Could not load bets")), 250);
    return () => clearTimeout(timer);
  }, [loadBets]);

  const run: Run = async (path, body, success) => {
    const token = await getToken();
    if (!token) return false;
    setError(null);
    setNotice(null);
    const json = JSON.stringify(body);
    try {
      await apiFetch(path, token, { method: "POST", body: json, idempotencyKey: idempotency.keyFor(path, json) });
      idempotency.done();
      await Promise.all([loadEvents(), loadBets()]);
      setNotice(success);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      return false;
    }
  };

  const attention = (events ?? []).filter((e) => e.needsAttention);
  const rest = (events ?? []).filter((e) => !e.needsAttention);

  return (
    <div className="stack">
      <div>
        <h1 style={{ margin: 0 }}>Settlement</h1>
        <p className="muted report-subtitle">
          Bets settle by themselves a minute or so after the feed reports a final score. Use this page to correct a result, void a match, or void one bet. Every change is refunded or charged to the Player straight away and written to the audit log.
        </p>
      </div>

      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="success-text" role="status">{notice}</p> : null}

      <section className="stack">
        <h2 style={{ margin: 0 }}>Matches with bets</h2>
        {events === null ? (
          <LoadingSpinner label="Loading matches" />
        ) : events.length === 0 ? (
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>No bets have been placed yet.</p>
          </div>
        ) : (
          <>
            {attention.length > 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {attention.length === 1 ? "1 match started" : `${attention.length} matches started`} over 3 hours ago and still {attention.length === 1 ? "has" : "have"} open bets. Set the result if the feed hasn&apos;t.
              </p>
            ) : null}
            <div className="settle-events">
              {[...attention, ...rest].map((event) => (
                <SettlementEventCard key={event.id} event={event} run={run} onShowBets={() => setEventId(event.id)} />
              ))}
            </div>
          </>
        )}
      </section>

      <section className="stack">
        <h2 style={{ margin: 0 }}>Bets</h2>
        <div className="settle-filters">
          <input type="search" placeholder="Player username" value={player} onChange={(e) => setPlayer(e.target.value)} aria-label="Filter by Player" />
          <select value={status} onChange={(e) => setStatus(e.target.value as BetStatus | "")} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="OPEN">Open</option>
            <option value="WON">Won</option>
            <option value="LOST">Lost</option>
            <option value="VOID">Void</option>
          </select>
          {eventId ? (
            <button type="button" className="secondary" onClick={() => setEventId("")}>
              {events?.find((e) => e.id === eventId)?.name ?? "This match"} ✕
            </button>
          ) : null}
        </div>
        {bets === null ? (
          <LoadingSpinner label="Loading bets" />
        ) : bets.length === 0 ? (
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>No bets match.</p>
          </div>
        ) : (
          <ul className="bet-list">
            {bets.map((bet) => (
              <AdminBetRow key={bet.id} bet={bet} run={run} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SettlementEventCard({ event, run, onShowBets }: { event: SettlementEvent; run: Run; onShowBets: () => void }) {
  const [mode, setMode] = useState<"result" | "void" | null>(null);
  const [home, setHome] = useState(String(event.result?.home ?? event.homeScore ?? 0));
  const [away, setAway] = useState(String(event.result?.away ?? event.awayScore ?? 0));
  const [reason, setReason] = useState("");
  const started = new Date(event.startsAt).getTime() <= Date.now();

  function saveResult(formEvent: FormEvent) {
    formEvent.preventDefault();
    const settled = event.bets.total - event.bets.open;
    const warning = settled > 0 ? ` ${settled} settled ${settled === 1 ? "bet" : "bets"} will be re-settled, and Players' balances changed to match.` : "";
    if (!window.confirm(`Set ${event.name} to ${home}–${away}?${warning}`)) return;
    void run(`/bets/admin/events/${event.id}/result`, { home: Number(home), away: Number(away) }, `${event.name} is now ${home}–${away}. Its bets were settled on that score.`).then((ok) => ok && setMode(null));
  }

  function voidAll(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!window.confirm(`Void all ${event.bets.total} bets on ${event.name} and refund every stake? This also stops new bets on it.`)) return;
    void run(`/bets/admin/events/${event.id}/void`, { reason: reason.trim() }, `Every bet on ${event.name} was voided and refunded.`).then((ok) => ok && setMode(null));
  }

  return (
    <article className={`card settle-event${event.needsAttention ? " needs-attention" : ""}`}>
      <header className="odds-event-header">
        <span className="muted odds-league">
          {event.league} · {dateTimeFormat.format(new Date(event.startsAt))}
        </span>
        <span className="odds-event-badges">
          {event.needsAttention ? <span className="status-pill odds-pill-warn">Needs a result</span> : null}
          {event.resultSource === "manual" ? <span className="status-pill">Set by hand</span> : null}
          <span className={`status-pill${event.status === "LIVE" ? " is-active" : ""}`}>{STATUS_TEXT[event.status]}</span>
        </span>
      </header>
      <div className="settle-event-name">
        <strong>{event.name}</strong>
        {event.result ? <strong className="odds-score">{event.result.home} – {event.result.away}</strong> : event.homeScore !== null && event.awayScore !== null && event.status !== "UPCOMING" ? <span className="odds-score muted">{event.homeScore} – {event.awayScore}</span> : null}
      </div>
      <p className="muted odds-note">
        {event.bets.total} {event.bets.total === 1 ? "bet" : "bets"} · {formatMoney(event.bets.staked)} staked
        {event.bets.open > 0 ? ` · ${event.bets.open} open (${formatMoney(event.bets.openStaked)})` : " · all settled"}
      </p>

      {mode === "result" ? (
        <form className="odds-editor" onSubmit={saveResult}>
          <label>
            <span>Score after 90 minutes</span>
            <span className="settle-score-inputs">
              <input type="number" inputMode="numeric" min={0} max={99} value={home} onChange={(e) => setHome(e.target.value)} aria-label="Home goals" required />
              <span>–</span>
              <input type="number" inputMode="numeric" min={0} max={99} value={away} onChange={(e) => setAway(e.target.value)} aria-label="Away goals" required />
            </span>
          </label>
          <div className="odds-editor-actions">
            <button type="submit">Save result</button>
            <button type="button" className="secondary" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {mode === "void" ? (
        <form className="odds-editor" onSubmit={voidAll}>
          <label>
            <span>Why? Players see this.</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={200} placeholder="e.g. Match abandoned" required />
          </label>
          <div className="odds-editor-actions">
            <button type="submit" className="danger-button">
              Void all bets
            </button>
            <button type="button" className="secondary" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <footer className="odds-event-footer">
        <button type="button" className="text-button" onClick={onShowBets}>
          Show bets
        </button>
        {mode === null ? (
          <span className="odds-admin-actions">
            <button type="button" className="secondary" onClick={() => setMode("result")} disabled={!started || event.status === "CANCELLED"} title={!started ? "The match hasn't started" : undefined}>
              {event.result ? "Correct result" : "Set result"}
            </button>
            <button type="button" className="secondary" onClick={() => setMode("void")}>
              Void match
            </button>
          </span>
        ) : null}
      </footer>
    </article>
  );
}

function AdminBetRow({ bet, run }: { bet: AdminBet; run: Run }) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const alreadyVoid = bet.status === "VOID" && Boolean(bet.voidReason);

  function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    const change = bet.stake - bet.payout;
    const effect = change === 0 ? "" : change > 0 ? ` ${formatMoney(change)} goes back to ${bet.player.username}.` : ` ${formatMoney(-change)} is taken back from ${bet.player.username}.`;
    if (!window.confirm(`Void this bet and refund the ${formatMoney(bet.stake)} stake?${effect}`)) return;
    void run(`/bets/admin/${bet.id}/void`, { reason: reason.trim() }, `${bet.player.username}'s bet was voided.`).then((ok) => ok && setVoiding(false));
  }

  return (
    <li className={`card bet-card is-${bet.status.toLowerCase()}`}>
      <div className="bet-card-top">
        <div className="bet-card-name">
          <strong>{bet.player.username}</strong>
          <span className="muted">{bet.description}</span>
        </div>
        <span className={`status-pill bet-status-${bet.status.toLowerCase()}`}>{bet.status === "OPEN" ? "Open" : bet.status === "WON" ? "Won" : bet.status === "LOST" ? "Lost" : "Void"}</span>
      </div>
      {bet.kind === "ACCUMULATOR" ? <BetLegs legs={bet.legs} /> : null}
      <dl className="bet-card-numbers">
        <div>
          <dt className="muted">Stake</dt>
          <dd>{formatMoney(bet.stake)}</dd>
        </div>
        <div>
          <dt className="muted">Odds</dt>
          <dd>{bet.odds?.toFixed(2) ?? "–"}</dd>
        </div>
        <div>
          <dt className="muted">{bet.status === "OPEN" ? "To return" : "Returned"}</dt>
          <dd>{formatMoney(bet.status === "OPEN" ? bet.potentialPayout ?? 0 : bet.payout)}</dd>
        </div>
      </dl>
      <p className="muted bet-card-when">
        Placed {dateTimeFormat.format(new Date(bet.placedAt))}
        {bet.voidReason ? ` · Voided: ${bet.voidReason}` : ""}
      </p>
      {voiding ? (
        <form className="odds-editor" onSubmit={submit}>
          <label>
            <span>Why? The Player sees this.</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={200} placeholder="e.g. Placed at a wrong price" required autoFocus />
          </label>
          <div className="odds-editor-actions">
            <button type="submit" className="danger-button">
              Void bet
            </button>
            <button type="button" className="secondary" onClick={() => setVoiding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : !alreadyVoid ? (
        <button type="button" className="secondary" style={{ justifySelf: "start" }} onClick={() => setVoiding(true)}>
          Void bet
        </button>
      ) : null}
    </li>
  );
}
