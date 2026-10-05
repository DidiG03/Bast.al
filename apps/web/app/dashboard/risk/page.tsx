"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { useToast } from "../../../components/toaster";
import { useRealtime } from "../../../components/realtime-provider";
import { apiFetch, type MeResponse, type RiskEvent, type RiskSelection, type RiskView, type UserRow } from "../../../lib/api";
import { formatMoney, formatSignedMoney } from "../../../lib/format";
import { useI18n, type I18n } from "../../../components/i18n-provider";
import { HelpTip } from "../../../components/help-tip";
import { usePolling } from "../../../lib/use-polling";

function when(event: RiskEvent, { t, date }: I18n): string {
  if (event.status === "LIVE") return event.homeScore !== null && event.awayScore !== null ? t("Live {score}", { score: `${event.homeScore}–${event.awayScore}` }) : t("Live");
  if (event.status === "COMPLETED") return t("Finished, settling");
  if (event.status === "POSTPONED") return t("Postponed");
  return date(event.startsAt, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function RiskPage() {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [owners, setOwners] = useState<UserRow[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [view, setView] = useState<RiskView | null>(null);
  const [failed, setFailed] = useState(false);
  const everLoaded = useRef(false);
  const toast = useToast();

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
    })().catch((err) => {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Could not load your account"));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    setView(await apiFetch<RiskView>(`/risk${query}`, token));
  }, [getToken, query]);

  const ready = me !== null && (!isAdmin || ownerId !== "");

  useEffect(() => {
    if (!ready) return;
    setView(null);
    load().catch((err) => {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Could not load the risk view"));
    });
  }, [ready, load, toast, t]);

  // Scores and new bets change the picture; refresh every 30 seconds while the page is on screen.
  usePolling(() => void load().catch(() => undefined), 30_000, ready);

  useRealtime((event) => {
    if (ready && event.type === "resync") void load().catch(() => undefined);
  });

  async function saveCap(cap: number | null): Promise<boolean> {
    const token = await getToken();
    if (!token) return false;
    try {
      setView(await apiFetch<RiskView>(`/risk/cap${query}`, token, { method: "PUT", body: JSON.stringify({ maxOutcomePayout: cap }) }));
      toast.success(cap === null ? t("The payout cap is off.") : t("New bets are refused once one outcome would pay out more than {amount}.", { amount: formatMoney(cap) }));
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not save the cap"));
      return false;
    }
  }

  const noOwners = isAdmin && owners.length === 0;
  // The first time, show nothing but the spinner until the team's numbers are in.
  if (!me || (!view && !noOwners && !failed && !everLoaded.current)) return failed ? null : <PageLoading label="Loading risk" />;
  if (view) everLoaded.current = true;

  return (
    <div className="stack">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Risk")}</h1>
          <p className="muted report-subtitle">{t("What the team pays out on each result of the matches with open bets. Worst first.")}</p>
        </div>
        {isAdmin && owners.length > 0 ? (
          <label className="odds-team-picker">
            <span className="muted">{t("Team")}</span>
            <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {t("{name}'s team", { name: owner.username })}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>


      {noOwners ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>{t("There are no Owners yet, so there is no team to show.")}</p>
        </div>
      ) : !view ? (
        failed ? null : (
          <div className="loading-state">
            <LoadingSpinner label="Loading risk" />
          </div>
        )
      ) : (
        <>
          <section className="card stack">
            <dl className="bet-card-numbers risk-totals">
              <div>
                <dt className="muted">{t("Open bets")}</dt><HelpTip text="Bets on matches that are not finished yet." />
                <dd>{view.totals.openBets}</dd>
              </div>
              <div>
                <dt className="muted">{t("Staked")}</dt><HelpTip text="All the money Players put on those open bets." />
                <dd>{formatMoney(view.totals.staked)}</dd>
              </div>
              <div>
                <dt className="muted">{t("Biggest payout")}</dt><HelpTip text="The most you would have to pay if the worst result for you happens in one match." />
                <dd>
                  <strong>{formatMoney(view.totals.worstCase)}</strong>
                </dd>
              </div>
            </dl>
            {view.canEdit ? <CapEditor cap={view.cap} onSave={saveCap} /> : null}
          </section>

          {view.events.length === 0 ? (
            <div className="card">
              <p className="muted" style={{ margin: 0 }}>{t("No open bets on any match right now.")}</p>
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
  const { t } = useI18n();

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
          <strong>{cap === null ? t("Payout cap: off") : t("Payout cap: {amount}", { amount: formatMoney(cap) })}</strong><HelpTip text="A safety limit. When one result of a match would make you pay more than this, new bets on that result are refused. Leave it off for no limit." />
          <p className="muted" style={{ margin: 0 }}>
            {cap === null
              ? t("Set a cap to stop taking bets once one outcome would pay out more than you want to cover.")
              : t("A new bet is refused if it would take what one outcome pays out above this.")}
          </p>
        </div>
        <button type="button" className="secondary" onClick={() => setEditing(true)}>
          {cap === null ? t("Set a cap") : t("Change")}
        </button>
      </div>
    );
  }

  return (
    <form className="risk-cap" onSubmit={submit}>
      <label className="bet-stake risk-cap-input">
        <span className="muted">{t("Most one outcome can pay out, $")}</span>
        <input type="number" inputMode="decimal" min={1} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
      </label>
      <div className="odds-editor-actions">
        <button type="submit" disabled={saving}>
          {t("Save")}
        </button>
        {cap !== null ? (
          <button type="button" className="secondary" onClick={turnOff} disabled={saving}>
            {t("Turn off")}
          </button>
        ) : null}
        <button type="button" className="text-button" onClick={() => setEditing(false)} disabled={saving}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}

function RiskEventCard({ event, cap }: { event: RiskEvent; cap: number | null }) {
  const i18n = useI18n();
  const { t, tn, ts } = i18n;
  const counts = [event.bets.singles ? tn(event.bets.singles, "{count} single", "{count} singles") : "", event.bets.accumulators ? t("{count} in accumulators", { count: event.bets.accumulators }) : ""].filter(Boolean).join(" · ");
  const overCap = event.markets.some((market) => market.selections.some((s) => s.overCap));
  return (
    <article className="card stack risk-event">
      <header className="odds-event-header">
        <span className="muted odds-league">{event.league}</span>
        <span className={`status-pill${event.status === "LIVE" ? " is-active" : ""}`}>{when(event, i18n)}</span>
      </header>
      <div className="risk-event-title">
        <strong>{event.name}</strong>
        <span className="muted">{counts}</span>
      </div>
      <p className={`risk-worst${overCap ? " is-over" : ""}`}>
        {t("Worst case:")} <strong>{formatMoney(event.worst.payout)}</strong> {t("if {pick} ({market})", { pick: ts(event.worst.selection), market: ts(event.worst.market) })}
      </p>
      {event.markets.map((market) => (
        <div key={market.id} className="risk-market">
          <span className="odds-market-name">{ts(market.name)}</span>
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
  const { t, tn, ts } = useI18n();
  const detail = [
    selection.singles.bets ? tn(selection.singles.bets, "{count} single, {amount} staked", "{count} singles, {amount} staked", { amount: formatMoney(selection.singles.staked) }) : "",
    selection.accumulators.bets ? tn(selection.accumulators.bets, "{count} accumulator {amount}", "{count} accumulators {amount}", { amount: formatMoney(selection.accumulators.payout) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const share = selection.share ?? 0;
  return (
    <li className={`risk-row${selection.overCap ? " is-over" : ""}`}>
      <div className="risk-row-top">
        <span className="risk-row-name">{ts(selection.name)}</span>
        <span className="risk-row-payout">
          <strong>{formatMoney(selection.payout)}</strong>
          <span className="muted"> {t("pays out")}</span>
        </span>
      </div>
      {cap !== null ? (
        <div className="risk-bar" role="img" aria-label={t("{percent}% of the cap", { percent: Math.round(share * 100) })}>
          <span style={{ width: `${Math.max(share * 100, selection.payout > 0 ? 2 : 0)}%` }} />
        </div>
      ) : null}
      <div className="risk-row-bottom muted">
        <span>{detail || t("No bets")}</span>
        {selection.singles.bets || selection.singlesResult !== 0 ? (
          <span className={selection.singlesResult < 0 ? "risk-loss" : "risk-win"}>{t("Singles {amount}", { amount: formatSignedMoney(selection.singlesResult) })}</span>
        ) : null}
      </div>
    </li>
  );
}
