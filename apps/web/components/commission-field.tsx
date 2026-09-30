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
  currentRate: number;
  label?: string;
  description?: string;
  onSaved?: (rate: number) => void;
};

export function CommissionRateControl({ userId, currentRate, label, description, onSaved }: Props) {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const [rate, setRate] = useState(String(currentRate));
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    const value = Number(rate);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      toast.error(t("Commission must be between 0% and 100%"));
      return;
    }
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    try {
      await apiFetch(`/users/${userId}/commission-rate`, token, { method: "POST", body: JSON.stringify({ rate: value }) });
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
        <h2>{label ?? t("Commission rate")}<HelpTip text="The percent of the weekly profit this person gets or pays. Example: at 10%, a $1,000 profit means $100." /></h2>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      <div className="commission-input-row">
        <label htmlFor={`commission-rate-${userId}`}>{t("Rate")}</label>
        <div className="commission-input">
          <input
            id={`commission-rate-${userId}`}
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            required
          />
          <span aria-hidden="true">%</span>
        </div>
        <button type="submit" className="secondary" disabled={busy}>{busy ? <LoadingSpinner label="Saving" size="small" /> : t("Save rate")}</button>
      </div>
    </form>
  );
}
