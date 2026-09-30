"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { BetLegs } from "../../../components/bet-legs";
import { LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { useToast } from "../../../components/toaster";
import { apiFetch, type AdminBet, type BetStatus, type MeResponse, type SettlementEvent } from "../../../lib/api";
import { formatMoney } from "../../../lib/format";
import { useIdempotencyKey } from "../../../lib/use-idempotency-key";
import { useI18n } from "../../../components/i18n-provider";
import { msg } from "../../../lib/i18n/core";
import { HelpTip } from "../../../components/help-tip";

const DATE_TIME: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

const STATUS_TEXT: Record<SettlementEvent["status"], string> = {
  UPCOMING: msg("Not started"),
  LIVE: msg("Live"),
  COMPLETED: msg("Finished"),
  POSTPONED: msg("Postponed"),
  CANCELLED: msg("Cancelled"),
};

const BET_STATUS: Record<AdminBet["status"], string> = { OPEN: msg("Open"), WON: msg("Won"), LOST: msg("Lost"), VOID: msg("Void") };

type Run = (path: string, body: object, success: string) => Promise<boolean>;

/**
 * Super Admin: bets settle on their own from the feed's final scores. This
 * page is for the exceptions: a wrong or missing result, a match that needs
 * voiding, or a single bet to void.
 * Owners and Managers get the same view limited to their own Players' bets,
 * read-only: results and voids move money across every team, so they stay
 * with Super Admin.
 */
export default function SettlementPage() {
  const { getToken } = useAuth();
  const { t, tn } = useI18n();
  const idempotency = useIdempotencyKey();
  const [canSettle, setCanSettle] = useState(false);
  const [events, setEvents] = useState<SettlementEvent[] | null>(null);
  const [bets, setBets] = useState<AdminBet[] | null>(null);
  const [status, setStatus] = useState<BetStatus | "">("");
  const [player, setPlayer] = useState("");
  const [eventId, setEventId] = useState("");
  const [meLoaded, setMeLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const toast = useToast();

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
    loadEvents().catch((err) => {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Could not load matches"));
    });
  }, [loadEvents, toast, t]);

  useEffect(() => {
    void getToken()
      .then((token) => (token ? apiFetch<MeResponse>("/users/me", token) : null))
      .then((me) => setCanSettle(me?.role === "SUPER_ADMIN"))
      .catch(() => undefined)
      .finally(() => setMeLoaded(true));
  }, [getToken]);

  useEffect(() => {
    const timer = setTimeout(
      () =>
        loadBets().catch((err) => {
          setFailed(true);
          toast.error(err instanceof Error ? err.message : t("Could not load bets"));
        }),
      250,
    );
    return () => clearTimeout(timer);
  }, [loadBets, toast, t]);

  const run: Run = async (path, body, success) => {
    const token = await getToken();
    if (!token) return false;
    const json = JSON.stringify(body);
    try {
      await apiFetch(path, token, { method: "POST", body: json, idempotencyKey: idempotency.keyFor(path, json) });
      idempotency.done();
      await Promise.all([loadEvents(), loadBets()]);
      toast.success(success);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Something went wrong"));
      return false;
    }
  };

  const attention = (events ?? []).filter((e) => e.needsAttention);
  const rest = (events ?? []).filter((e) => !e.needsAttention);

  // Matches stuck with open bets are a warning: it pops up once each time the count changes.
  useEffect(() => {
    if (attention.length === 0) return;
    toast.warning(
      `${tn(attention.length, "{count} match started over 3 hours ago and still has open bets.", "{count} matches started over 3 hours ago and still have open bets.")} ${canSettle ? t("Set the result if the feed hasn't.") : t("Super Admin settles these by hand when the feed doesn't.")}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attention.length, canSettle]);

  // Nothing shows until the account, the matches and the bets have all loaded.
  if (!meLoaded || events === null || bets === null) return failed ? null : <PageLoading label="Loading settlement" />;

  return (
    <div className="stack">
      <div>
        <h1 style={{ margin: 0 }}>{t("Settlement")}</h1>
        <p className="muted report-subtitle">
          {canSettle
            ? t("Bets settle by themselves a minute or so after the feed reports a final score. Use this page to correct a result, void a match, or void one bet. Every change is refunded or charged to the Player straight away and written to the audit log.")
            : t("The matches your Players are betting on, and every bet they've placed. Bets settle by themselves a minute or so after the final score. If a result looks wrong, ask Super Admin to correct it.")}
        </p>
      </div>


      <section className="stack">
        <h2 style={{ margin: 0 }}>{t("Matches with bets")}<HelpTip text="Every match that has bets on it. Bets are paid out by themselves a minute after the final score arrives. Matches that need a hand (no score after 3 hours) are shown first." /></h2>
        {events.length === 0 ? (
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>{canSettle ? t("No bets have been placed yet.") : t("Your Players haven't placed any bets yet.")}</p>
          </div>
        ) : (
          <>
            <div className="settle-events">
              {[...attention, ...rest].map((event) => (
                <SettlementEventCard key={event.id} event={event} run={run} canSettle={canSettle} onShowBets={() => setEventId(event.id)} />
              ))}
            </div>
          </>
        )}
      </section>

      <section className="stack">
        <h2 style={{ margin: 0 }}>{t("Bets")}<HelpTip text="Every single bet. Use the search and the status list to find one. Open = not finished, Won/Lost = finished, Void = cancelled and the money given back." /></h2>
        <div className="settle-filters">
          <input type="search" placeholder={t("Player username")} value={player} onChange={(e) => setPlayer(e.target.value)} aria-label={t("Filter by Player")} />
          <select value={status} onChange={(e) => setStatus(e.target.value as BetStatus | "")} aria-label={t("Filter by status")}>
            <option value="">{t("All statuses")}</option>
            <option value="OPEN">{t("Open")}</option>
            <option value="WON">{t("Won")}</option>
            <option value="LOST">{t("Lost")}</option>
            <option value="VOID">{t("Void")}</option>
          </select>
          {eventId ? (
            <button type="button" className="secondary" onClick={() => setEventId("")}>
              {events?.find((e) => e.id === eventId)?.name ?? t("This match")} ✕
            </button>
          ) : null}
        </div>
        {bets.length === 0 ? (
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>{t("No bets match.")}</p>
          </div>
        ) : (
          <ul className="bet-list">
            {bets.map((bet) => (
              <AdminBetRow key={bet.id} bet={bet} run={run} canSettle={canSettle} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SettlementEventCard({ event, run, canSettle, onShowBets }: { event: SettlementEvent; run: Run; canSettle: boolean; onShowBets: () => void }) {
  const [mode, setMode] = useState<"result" | "void" | null>(null);
  const [home, setHome] = useState(String(event.result?.home ?? event.homeScore ?? 0));
  const [away, setAway] = useState(String(event.result?.away ?? event.awayScore ?? 0));
  const [halfHome, setHalfHome] = useState(event.halfTime ? String(event.halfTime.home) : "");
  const [halfAway, setHalfAway] = useState(event.halfTime ? String(event.halfTime.away) : "");
  const [cornersHome, setCornersHome] = useState(event.stats ? String(event.stats.cornersHome) : "");
  const [cornersAway, setCornersAway] = useState(event.stats ? String(event.stats.cornersAway) : "");
  const [cardsHome, setCardsHome] = useState(event.stats ? String(event.stats.cardsHome) : "");
  const [cardsAway, setCardsAway] = useState(event.stats ? String(event.stats.cardsAway) : "");
  const [reason, setReason] = useState("");
  const { t, tn, date } = useI18n();
  const started = new Date(event.startsAt).getTime() <= Date.now();

  function saveResult(formEvent: FormEvent) {
    formEvent.preventDefault();
    const settled = event.bets.total - event.bets.open;
    const warning = settled > 0 ? ` ${tn(settled, "{count} settled bet will be re-settled, and the Player's balance changed to match.", "{count} settled bets will be re-settled, and Players' balances changed to match.")}` : "";
    const hasHalf = halfHome !== "" && halfAway !== "";
    if (!hasHalf && (halfHome !== "" || halfAway !== "")) {
      window.alert(t("Enter both half-time goals, or leave both empty."));
      return;
    }
    const counts = [cornersHome, cornersAway, cardsHome, cardsAway];
    const hasStats = counts.every((n) => n !== "");
    if (!hasStats && counts.some((n) => n !== "")) {
      window.alert(t("Enter corners and cards for both teams, or leave all four empty."));
      return;
    }
    const result = [
      `${home}–${away}`,
      hasHalf ? t("half time {score}", { score: `${halfHome}–${halfAway}` }) : null,
      hasStats ? t("corners {corners}, cards {cards}", { corners: `${cornersHome}–${cornersAway}`, cards: `${cardsHome}–${cardsAway}` }) : null,
    ]
      .filter(Boolean)
      .join(", ");
    if (!window.confirm(`${t("Set {match} to {result}?", { match: event.name, result })}${warning}`)) return;
    const body = {
      home: Number(home),
      away: Number(away),
      ...(hasHalf ? { halfHome: Number(halfHome), halfAway: Number(halfAway) } : {}),
      ...(hasStats ? { cornersHome: Number(cornersHome), cornersAway: Number(cornersAway), cardsHome: Number(cardsHome), cardsAway: Number(cardsAway) } : {}),
    };
    void run(`/bets/admin/events/${event.id}/result`, body, t("{match} is now {result}. Its bets were settled on that score.", { match: event.name, result })).then((ok) => ok && setMode(null));
  }

  function voidAll(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!window.confirm(tn(event.bets.total, "Void the {count} bet on {match} and refund its stake? This also stops new bets on it.", "Void all {count} bets on {match} and refund every stake? This also stops new bets on it.", { match: event.name }))) return;
    void run(`/bets/admin/events/${event.id}/void`, { reason: reason.trim() }, t("Every bet on {match} was voided and refunded.", { match: event.name })).then((ok) => ok && setMode(null));
  }

  return (
    <article className={`card settle-event${event.needsAttention ? " needs-attention" : ""}`}>
      <header className="odds-event-header">
        <span className="muted odds-league">
          {event.league} · {date(event.startsAt, DATE_TIME)}
        </span>
        <span className="odds-event-badges">
          {event.needsAttention ? <span className="status-pill odds-pill-warn">{canSettle ? t("Needs a result") : t("Waiting for a result")}</span> : null}
          {event.resultSource === "manual" ? <span className="status-pill">{t("Set by hand")}</span> : null}
          {canSettle && event.extraTime && !event.stats ? <span className="status-pill odds-pill-warn">{t("Extra time: enter corners and cards")}</span> : null}
          <span className={`status-pill${event.status === "LIVE" ? " is-active" : ""}`}>{t(STATUS_TEXT[event.status])}</span>
        </span>
      </header>
      <div className="settle-event-name">
        <strong>{event.name}</strong>
        {event.result ? <strong className="odds-score">{event.result.home} – {event.result.away}{event.halfTime ? <span className="muted"> ({t("HT {score}", { score: `${event.halfTime.home}–${event.halfTime.away}` })})</span> : null}</strong> : event.homeScore !== null && event.awayScore !== null && event.status !== "UPCOMING" ? <span className="odds-score muted">{event.homeScore} – {event.awayScore}</span> : null}
      </div>
      {event.stats ? (
        <p className="muted odds-note">
          {t("Corners {corners} · Cards {cards}", { corners: `${event.stats.cornersHome}–${event.stats.cornersAway}`, cards: `${event.stats.cardsHome}–${event.stats.cardsAway}` })}
          {event.statsSource === "manual" ? ` · ${t("set by hand")}` : ""}
        </p>
      ) : null}
      <p className="muted odds-note">
        {tn(event.bets.total, "{count} bet · {amount} staked", "{count} bets · {amount} staked", { amount: formatMoney(event.bets.staked) })}
        {event.bets.open > 0 ? ` · ${t("{count} open ({amount})", { count: event.bets.open, amount: formatMoney(event.bets.openStaked) })}` : ` · ${t("all settled")}`}
      </p>

      {mode === "result" ? (
        <form className="odds-editor" onSubmit={saveResult}>
          <label>
            <span>{t("Score after 90 minutes")}</span>
            <span className="settle-score-inputs">
              <input type="number" inputMode="numeric" min={0} max={99} value={home} onChange={(e) => setHome(e.target.value)} aria-label={t("Home goals")} required />
              <span>–</span>
              <input type="number" inputMode="numeric" min={0} max={99} value={away} onChange={(e) => setAway(e.target.value)} aria-label={t("Away goals")} required />
            </span>
          </label>
          <label>
            <span>{t("Half-time score (for 1st and 2nd half bets)")}</span>
            <span className="settle-score-inputs">
              <input type="number" inputMode="numeric" min={0} max={99} value={halfHome} onChange={(e) => setHalfHome(e.target.value)} aria-label={t("Home goals at half time")} />
              <span>–</span>
              <input type="number" inputMode="numeric" min={0} max={99} value={halfAway} onChange={(e) => setHalfAway(e.target.value)} aria-label={t("Away goals at half time")} />
            </span>
          </label>
          <label>
            <span>{t("Corners after 90 minutes")}</span>
            <span className="settle-score-inputs">
              <input type="number" inputMode="numeric" min={0} max={99} value={cornersHome} onChange={(e) => setCornersHome(e.target.value)} aria-label={t("Home corners")} />
              <span>–</span>
              <input type="number" inputMode="numeric" min={0} max={99} value={cornersAway} onChange={(e) => setCornersAway(e.target.value)} aria-label={t("Away corners")} />
            </span>
          </label>
          <label>
            <span>{t("Cards after 90 minutes (each yellow and red counts as 1)")}</span>
            <span className="settle-score-inputs">
              <input type="number" inputMode="numeric" min={0} max={99} value={cardsHome} onChange={(e) => setCardsHome(e.target.value)} aria-label={t("Home cards")} />
              <span>–</span>
              <input type="number" inputMode="numeric" min={0} max={99} value={cardsAway} onChange={(e) => setCardsAway(e.target.value)} aria-label={t("Away cards")} />
            </span>
          </label>
          <div className="odds-editor-actions">
            <button type="submit">{t("Save result")}</button>
            <button type="button" className="secondary" onClick={() => setMode(null)}>
              {t("Cancel")}
            </button>
          </div>
        </form>
      ) : null}
      {mode === "void" ? (
        <form className="odds-editor" onSubmit={voidAll}>
          <label>
            <span>{t("Why? Players see this.")}</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={200} placeholder={t("e.g. Match abandoned")} required />
          </label>
          <div className="odds-editor-actions">
            <button type="submit" className="danger-button">
              {t("Void all bets")}
            </button>
            <button type="button" className="secondary" onClick={() => setMode(null)}>
              {t("Cancel")}
            </button>
          </div>
        </form>
      ) : null}

      <footer className="odds-event-footer">
        <button type="button" className="text-button" onClick={onShowBets}>
          {t("Show bets")}
        </button>
        {canSettle && mode === null ? (
          <span className="odds-admin-actions">
            <button type="button" className="secondary" onClick={() => setMode("result")} disabled={!started || event.status === "CANCELLED"} title={!started ? t("The match hasn't started") : undefined}>
              {event.result ? t("Correct result") : t("Set result")}
            </button>
            <button type="button" className="secondary" onClick={() => setMode("void")}>
              {t("Void match")}
            </button>
          </span>
        ) : null}
      </footer>
    </article>
  );
}

function AdminBetRow({ bet, run, canSettle }: { bet: AdminBet; run: Run; canSettle: boolean }) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const alreadyVoid = bet.status === "VOID" && Boolean(bet.voidReason);
  const { t, ts, date } = useI18n();

  function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    const change = bet.stake - bet.payout;
    const effect =
      change === 0
        ? ""
        : change > 0
          ? ` ${t("{amount} goes back to {name}.", { amount: formatMoney(change), name: bet.player.username })}`
          : ` ${t("{amount} is taken back from {name}.", { amount: formatMoney(-change), name: bet.player.username })}`;
    if (!window.confirm(`${t("Void this bet and refund the {amount} stake?", { amount: formatMoney(bet.stake) })}${effect}`)) return;
    void run(`/bets/admin/${bet.id}/void`, { reason: reason.trim() }, t("{name}'s bet was voided.", { name: bet.player.username })).then((ok) => ok && setVoiding(false));
  }

  return (
    <li className={`card bet-card is-${bet.status.toLowerCase()}`}>
      <div className="bet-card-top">
        <div className="bet-card-name">
          <strong>{bet.player.username}</strong>
          <span className="muted">{ts(bet.description)}</span>
        </div>
        <span className={`status-pill bet-status-${bet.status.toLowerCase()}`}>{t(BET_STATUS[bet.status])}</span>
      </div>
      {bet.kind === "ACCUMULATOR" ? <BetLegs legs={bet.legs} /> : null}
      <dl className="bet-card-numbers">
        <div>
          <dt className="muted">{t("Stake")}</dt>
          <dd>{formatMoney(bet.stake)}</dd>
        </div>
        <div>
          <dt className="muted">{t("Odds")}</dt>
          <dd>{bet.odds?.toFixed(2) ?? "–"}</dd>
        </div>
        <div>
          <dt className="muted">{bet.status === "OPEN" ? t("To return") : t("Returned")}</dt>
          <dd>{formatMoney(bet.status === "OPEN" ? bet.potentialPayout ?? 0 : bet.payout)}</dd>
        </div>
      </dl>
      <p className="muted bet-card-when">
        {t("Placed {when}", { when: date(bet.placedAt, DATE_TIME) })}
        {bet.voidReason ? ` · ${t("Voided: {reason}", { reason: bet.voidReason })}` : ""}
      </p>
      {voiding ? (
        <form className="odds-editor" onSubmit={submit}>
          <label>
            <span>{t("Why? The Player sees this.")}</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={200} placeholder={t("e.g. Placed at a wrong price")} required autoFocus />
          </label>
          <div className="odds-editor-actions">
            <button type="submit" className="danger-button">
              {t("Void bet")}
            </button>
            <button type="button" className="secondary" onClick={() => setVoiding(false)}>
              {t("Cancel")}
            </button>
          </div>
        </form>
      ) : canSettle && !alreadyVoid ? (
        <button type="button" className="secondary" style={{ justifySelf: "start" }} onClick={() => setVoiding(true)}>
          {t("Void bet")}
        </button>
      ) : null}
    </li>
  );
}
