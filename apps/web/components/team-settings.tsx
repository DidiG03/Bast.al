"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useEffect, useState } from "react";
import { apiFetch, type TeamSettings } from "../lib/api";
import { formatMoney } from "../lib/format";
import { LoadingSpinner } from "./loading-spinner";
import { useI18n } from "./i18n-provider";

function parse(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1000000) return "invalid";
  return Math.round(value * 100) / 100;
}

/** Owner-wide settings: the low-balance alert and the default approval limit for their Managers. */
export function TeamSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const [settings, setSettings] = useState<TeamSettings | null>(null);
  const [threshold, setThreshold] = useState("");
  const [approval, setApproval] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) return;
      const current = await apiFetch<TeamSettings>("/users/me/team-settings", token);
      setSettings(current);
      setThreshold(current.lowBalanceThreshold === null ? "" : String(current.lowBalanceThreshold));
      setApproval(current.managerApprovalLimit === null ? "" : String(current.managerApprovalLimit));
    })().catch((err) => setError(err instanceof Error ? err.message : t("Could not load team settings")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const lowBalanceThreshold = parse(threshold);
    const managerApprovalLimit = parse(approval);
    if (lowBalanceThreshold === "invalid" || managerApprovalLimit === "invalid") {
      setError(t("Enter an amount between $0 and $1,000,000, or leave it blank"));
      return;
    }
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      await apiFetch<TeamSettings>("/users/me/team-settings", token, { method: "POST", body: JSON.stringify({ lowBalanceThreshold, managerApprovalLimit }) });
      onSaved(t("Team settings saved."));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save team settings"));
    } finally {
      setBusy(false);
    }
  }

  const standard = settings?.defaultApprovalLimit ?? 10000;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal card" role="dialog" aria-modal="true" aria-labelledby="team-settings-title">
        <div className="modal-header">
          <h2 id="team-settings-title">{t("Team settings")}</h2>
          <button type="button" className="modal-close secondary" onClick={onClose} disabled={busy} aria-label={t("Close")}>×</button>
        </div>
        {!settings && !error ? (
          <div className="loading-state"><LoadingSpinner label="Loading team settings" /></div>
        ) : (
          <form className="stack" onSubmit={submit}>
            <label className="stack" style={{ gap: "0.35rem" }}>
              <strong>{t("Low-balance alert")}</strong>
              <span className="muted">{t("You and their Manager or Owner get a notification when a Manager or Player drops below this. Leave blank to turn it off.")}</span>
              <div className="commission-input">
                <span aria-hidden="true">$</span>
                <input type="number" min="0" max="1000000" step="0.01" inputMode="decimal" placeholder={t("Off")} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
              </div>
            </label>
            <label className="stack" style={{ gap: "0.35rem" }}>
              <strong>{t("Managers' approval limit")}</strong>
              <span className="muted">
                {t("Your Managers can send up to this much to a Player without your approval. A limit you set on one Manager in their Balance window still wins. Leave blank for the standard {amount}.", { amount: formatMoney(standard) })}
              </span>
              <div className="commission-input">
                <span aria-hidden="true">$</span>
                <input type="number" min="0" max="1000000" step="0.01" inputMode="decimal" placeholder={String(standard)} value={approval} onChange={(e) => setApproval(e.target.value)} />
              </div>
            </label>
            {error ? <p className="error-text" role="alert">{error}</p> : null}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
              <button type="submit" disabled={busy || !settings}>{busy ? <LoadingSpinner label="Saving" size="small" /> : t("Save settings")}</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
