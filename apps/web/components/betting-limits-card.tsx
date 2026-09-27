"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useEffect, useState } from "react";
import { apiFetch, type BettingLimits, type Limits } from "../lib/api";
import { formatMoney } from "../lib/format";

function show(limit: number | null): string {
  return limit === null ? "No limit" : formatMoney(limit);
}

function asInput(limit: number | null): string {
  return limit === null ? "" : String(limit);
}

/** Parses an optional amount: blank means no limit. */
function parse(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 1000000) return "invalid";
  return Math.round(value * 100) / 100;
}

/**
 * The Player's max stake and daily loss limit. The Owner sets the ceiling;
 * the Player's Manager can tighten it but not go above it.
 */
export function BettingLimitsCard({ playerId }: { playerId: string }) {
  const { getToken } = useAuth();
  const [data, setData] = useState<BettingLimits | null>(null);
  const [maxStake, setMaxStake] = useState("");
  const [dailyLoss, setDailyLoss] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function apply(next: BettingLimits) {
    setData(next);
    const mine: Limits = next.editable === "manager" ? next.manager : next.owner;
    setMaxStake(asInput(mine.maxStake));
    setDailyLoss(asInput(mine.dailyLossLimit));
  }

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) return;
      apply(await apiFetch<BettingLimits>(`/players/${playerId}/limits`, token));
    })().catch((err) => setError(err instanceof Error ? err.message : "Could not load betting limits"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(null);
    setError(null);
    const stake = parse(maxStake);
    const loss = parse(dailyLoss);
    if (stake === "invalid" || loss === "invalid") {
      setError("Enter an amount between $0 and $1,000,000, or leave it blank for no limit");
      return;
    }
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    try {
      apply(await apiFetch<BettingLimits>(`/players/${playerId}/limits`, token, { method: "POST", body: JSON.stringify({ maxStake: stake, dailyLossLimit: loss }) }));
      setSaved("Betting limits saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save betting limits");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return error ? <p className="error-text">{error}</p> : null;

  const { effective, owner, editable } = data;
  const lossLeft = effective.dailyLossLimit === null ? null : Math.max(0, effective.dailyLossLimit - data.lossToday);
  const isManager = editable === "manager";

  return (
    <section className="card stack">
      <div className="tree-header">
        <h2 style={{ margin: 0 }}>Betting limits</h2>
        <span className="muted">Lost today {formatMoney(data.lossToday)}</span>
      </div>
      <div className="limits-summary">
        <div>
          <span className="muted">Max stake per bet</span>
          <strong>{show(effective.maxStake)}</strong>
        </div>
        <div>
          <span className="muted">Daily loss limit</span>
          <strong>{show(effective.dailyLossLimit)}</strong>
          {lossLeft !== null ? <span className="muted">{formatMoney(lossLeft)} left today</span> : null}
        </div>
      </div>
      {editable ? (
        <form className="stack" onSubmit={submit}>
          <p className="muted" style={{ margin: 0 }}>
            {isManager
              ? owner.maxStake === null && owner.dailyLossLimit === null
                ? "Your Owner hasn't set limits for this Player. You can add your own."
                : `You can lower the limits your Owner set (${show(owner.maxStake)} per bet, ${show(owner.dailyLossLimit)} a day) but not raise them. Leave a field blank to use your Owner's limit.`
              : data.hasManager
                ? "These are the most this Player can bet. Their Manager can lower them but not raise them. Leave a field blank for no limit."
                : "These are the most this Player can bet. Leave a field blank for no limit."}
          </p>
          {!isManager && (data.manager.maxStake !== null || data.manager.dailyLossLimit !== null) ? (
            <p className="muted" style={{ margin: 0 }}>
              Their Manager lowered it further:{data.manager.maxStake !== null ? ` ${formatMoney(data.manager.maxStake)} per bet` : ""}
              {data.manager.maxStake !== null && data.manager.dailyLossLimit !== null ? "," : ""}
              {data.manager.dailyLossLimit !== null ? ` ${formatMoney(data.manager.dailyLossLimit)} a day` : ""}.
            </p>
          ) : null}
          <div className="limits-fields">
            <label className="field">
              <span>Max stake per bet</span>
              <div className="commission-input">
                <span aria-hidden="true">$</span>
                <input type="number" min="0.01" max={isManager && owner.maxStake !== null ? owner.maxStake : 1000000} step="0.01" inputMode="decimal" placeholder={isManager && owner.maxStake !== null ? `Owner's ${formatMoney(owner.maxStake)}` : "No limit"} value={maxStake} onChange={(e) => setMaxStake(e.target.value)} />
              </div>
            </label>
            <label className="field">
              <span>Daily loss limit</span>
              <div className="commission-input">
                <span aria-hidden="true">$</span>
                <input type="number" min="0.01" max={isManager && owner.dailyLossLimit !== null ? owner.dailyLossLimit : 1000000} step="0.01" inputMode="decimal" placeholder={isManager && owner.dailyLossLimit !== null ? `Owner's ${formatMoney(owner.dailyLossLimit)}` : "No limit"} value={dailyLoss} onChange={(e) => setDailyLoss(e.target.value)} />
              </div>
            </label>
          </div>
          <div>
            <button type="submit" className="secondary" disabled={busy}>{busy ? "Saving…" : "Save limits"}</button>
          </div>
          {saved ? <p className="success-text" role="status">{saved}</p> : null}
          {error ? <p className="error-text" role="alert">{error}</p> : null}
        </form>
      ) : null}
    </section>
  );
}
