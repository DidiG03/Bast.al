"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useEffect, useState } from "react";
import { apiFetch, type BettingLimits, type Limits } from "../lib/api";
import { formatMoney } from "../lib/format";
import { useI18n, type I18n } from "./i18n-provider";
import { LoadingSpinner } from "./loading-spinner";
import { useToast } from "./toaster";
import { HelpTip } from "./help-tip";

function show(t: I18n["t"], limit: number | null): string {
  return limit === null ? t("No limit") : formatMoney(limit);
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
  const { t } = useI18n();
  const [data, setData] = useState<BettingLimits | null>(null);
  const [maxStake, setMaxStake] = useState("");
  const [dailyLoss, setDailyLoss] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const toast = useToast();

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
    })().catch((err) => {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Could not load betting limits"));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const stake = parse(maxStake);
    const loss = parse(dailyLoss);
    if (stake === "invalid" || loss === "invalid") {
      toast.error(t("Enter an amount between 0 ALL and 1,000,000 ALL, or leave it blank for no limit"));
      return;
    }
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    try {
      apply(await apiFetch<BettingLimits>(`/players/${playerId}/limits`, token, { method: "POST", body: JSON.stringify({ maxStake: stake, dailyLossLimit: loss }) }));
      toast.success(t("Betting limits saved."));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not save betting limits"));
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    if (failed) return null;
    return (
      <section className="card loading-state">
        <LoadingSpinner label="Loading betting limits" />
      </section>
    );
  }

  const { effective, owner, editable } = data;
  const lossLeft = effective.dailyLossLimit === null ? null : Math.max(0, effective.dailyLossLimit - data.lossToday);
  const isManager = editable === "manager";

  return (
    <section className="card stack">
      <div className="tree-header">
        <h2 style={{ margin: 0 }}>{t("Betting limits")}<HelpTip text="Stops a Player from betting too much. “Max stake” is the most they can bet at once. “Daily loss limit” is the most they can lose in one day; after that they can't bet until tomorrow." /></h2>
        <span className="muted">{t("Lost today {amount}", { amount: formatMoney(data.lossToday) })}</span>
      </div>
      <div className="limits-summary">
        <div>
          <span className="muted">{t("Max stake per bet")}</span>
          <strong>{show(t, effective.maxStake)}</strong>
        </div>
        <div>
          <span className="muted">{t("Daily loss limit")}</span>
          <strong>{show(t, effective.dailyLossLimit)}</strong>
          {lossLeft !== null ? <span className="muted">{t("{amount} left today", { amount: formatMoney(lossLeft) })}</span> : null}
        </div>
      </div>
      {editable ? (
        <form className="stack" onSubmit={submit}>
          <p className="muted" style={{ margin: 0 }}>
            {isManager
              ? owner.maxStake === null && owner.dailyLossLimit === null
                ? t("Your Owner hasn't set limits for this Player. You can add your own.")
                : t("You can lower the limits your Owner set ({stake} per bet, {loss} a day) but not raise them. Leave a field blank to use your Owner's limit.", { stake: show(t, owner.maxStake), loss: show(t, owner.dailyLossLimit) })
              : data.hasManager
                ? t("These are the most this Player can bet. Their Manager can lower them but not raise them. Leave a field blank for no limit.")
                : t("These are the most this Player can bet. Leave a field blank for no limit.")}
          </p>
          {!isManager && (data.manager.maxStake !== null || data.manager.dailyLossLimit !== null) ? (
            <p className="muted" style={{ margin: 0 }}>
              {t("Their Manager lowered it further: {limits}.", {
                limits: [
                  data.manager.maxStake !== null ? t("{amount} per bet", { amount: formatMoney(data.manager.maxStake) }) : null,
                  data.manager.dailyLossLimit !== null ? t("{amount} a day", { amount: formatMoney(data.manager.dailyLossLimit) }) : null,
                ]
                  .filter(Boolean)
                  .join(", "),
              })}
            </p>
          ) : null}
          <div className="limits-fields">
            <label className="field">
              <span>{t("Max stake per bet")}</span>
              <div className="commission-input">
                <span aria-hidden="true">ALL</span>
                <input type="number" min="0.01" max={isManager && owner.maxStake !== null ? owner.maxStake : 1000000} step="0.01" inputMode="decimal" placeholder={isManager && owner.maxStake !== null ? t("Owner's {amount}", { amount: formatMoney(owner.maxStake) }) : t("No limit")} value={maxStake} onChange={(e) => setMaxStake(e.target.value)} />
              </div>
            </label>
            <label className="field">
              <span>{t("Daily loss limit")}</span>
              <div className="commission-input">
                <span aria-hidden="true">ALL</span>
                <input type="number" min="0.01" max={isManager && owner.dailyLossLimit !== null ? owner.dailyLossLimit : 1000000} step="0.01" inputMode="decimal" placeholder={isManager && owner.dailyLossLimit !== null ? t("Owner's {amount}", { amount: formatMoney(owner.dailyLossLimit) }) : t("No limit")} value={dailyLoss} onChange={(e) => setDailyLoss(e.target.value)} />
              </div>
            </label>
          </div>
          <div>
            <button type="submit" className="secondary" disabled={busy}>{busy ? <LoadingSpinner label="Saving" size="small" /> : t("Save limits")}</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
