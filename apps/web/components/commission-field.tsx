"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useState } from "react";
import { apiFetch } from "../lib/api";
import { useI18n } from "./i18n-provider";
import { LoadingSpinner } from "./loading-spinner";
import { useToast } from "./toaster";
import { HelpTip } from "./help-tip";

type Props = {
  userId: string;
  /** The commission on matches. */
  currentRate: number;
  /** The Casino's own commission, or null when it's the same as on matches. */
  currentCasinoRate?: number | null;
  label?: string;
  description?: string;
  onSaved?: (rate: number) => void;
};

/**
 * The commission on matches and, separately, on the Casino (e.g. 10% on matches, 15% on the Casino). The Casino box left
 * blank means the same rate as on matches. New rates apply to bets and rounds from now on.
 */
export function CommissionRateControl({ userId, currentRate, currentCasinoRate = null, label, description, onSaved }: Props) {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const [rate, setRate] = useState(String(currentRate));
  const [casinoRate, setCasinoRate] = useState(currentCasinoRate === null || currentCasinoRate === undefined ? "" : String(currentCasinoRate));
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    const value = Number(rate);
    const casino = casinoRate.trim() === "" ? null : Number(casinoRate);
    if (!Number.isFinite(value) || value < 0 || value > 100 || (casino !== null && (!Number.isFinite(casino) || casino < 0 || casino > 100))) {
      toast.error(t("Commission must be between 0% and 100%"));
      return;
    }
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    try {
      await apiFetch(`/users/${userId}/commission-rate`, token, { method: "POST", body: JSON.stringify({ rate: value, casinoRate: casino }) });
      toast.success(t("Commission rate saved."));
      onSaved?.(value);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not save commission rate"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="commission-field" onSubmit={save}>
      <div>
        <h2>{label ?? t("Commission rate")}<HelpTip text="The percent of the weekly profit this person gets or pays. Example: at 10%, a 1,000 ALL profit means 100 ALL." /></h2>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      <div className="commission-input-row">
        <label htmlFor={`commission-rate-${userId}`}>{t("Matches")}</label>
        <div className="commission-input">
          <input id={`commission-rate-${userId}`} type="number" min="0" max="100" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)} required />
          <span aria-hidden="true">%</span>
        </div>
      </div>
      <div className="commission-input-row">
        <label htmlFor={`commission-casino-${userId}`}>{t("Casino")}</label>
        <div className="commission-input">
          <input
            id={`commission-casino-${userId}`}
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={casinoRate}
            onChange={(event) => setCasinoRate(event.target.value)}
            placeholder={rate}
            aria-describedby={`commission-casino-hint-${userId}`}
          />
          <span aria-hidden="true">%</span>
        </div>
        <button type="submit" className="secondary" disabled={busy}>{busy ? <LoadingSpinner label="Saving" size="small" /> : t("Save rate")}</button>
      </div>
      <p id={`commission-casino-hint-${userId}`} className="muted field-hint" style={{ margin: 0 }}>
        {t("Leave Casino blank to use the same rate as on matches. New rates apply to bets and rounds from now on.")}
      </p>
    </form>
  );
}
