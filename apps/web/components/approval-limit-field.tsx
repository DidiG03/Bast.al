"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useState } from "react";
import { apiFetch, DEFAULT_APPROVAL_LIMIT } from "../lib/api";
import { formatMoney } from "../lib/format";
import { useI18n } from "./i18n-provider";

type Props = {
  userId: string;
  /** The Manager's personal limit, or null when they use the platform default. */
  currentLimit: number | null;
  /** The Owner's default for all their Managers, if they set one. */
  teamLimit?: number | null;
  onSaved?: (limit: number | null) => void;
};

/** Owner (or Super Admin) sets how much a Manager can delegate without asking first. */
export function ApprovalLimitControl({ userId, currentLimit, teamLimit = null, onSaved }: Props) {
  const fallback = teamLimit ?? DEFAULT_APPROVAL_LIMIT;
  const { getToken } = useAuth();
  const { t } = useI18n();
  const [limit, setLimit] = useState(String(currentLimit ?? fallback));
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(value: number | null) {
    setSaved(null);
    setError(null);
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    try {
      await apiFetch(`/users/${userId}/approval-limit`, token, { method: "POST", body: JSON.stringify({ limit: value }) });
      setLimit(String(value ?? fallback));
      setSaved(value === null ? (teamLimit === null ? t("Back to the standard limit.") : t("Back to your team limit.")) : t("Approval limit saved."));
      onSaved?.(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save the approval limit"));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = Number(limit);
    if (!Number.isFinite(value) || value < 0 || value > 1000000) {
      setError(t("Enter an amount between $0 and $1,000,000"));
      return;
    }
    save(value).catch(() => undefined);
  }

  return (
    <form className="commission-field" onSubmit={submit}>
      <div>
        <h2>{t("Approval limit")}</h2>
        <p className="muted">
          {t("This Manager can send up to this much to a Player without your approval. Anything larger waits for you.")}{" "}
          {teamLimit === null ? t("The standard limit is {amount}.", { amount: formatMoney(DEFAULT_APPROVAL_LIMIT) }) : t("Your team limit is {amount}.", { amount: formatMoney(teamLimit) })}
        </p>
      </div>
      <div className="commission-input-row">
        <label htmlFor={`approval-limit-${userId}`}>{t("Limit")}</label>
        <div className="commission-input">
          <span aria-hidden="true">$</span>
          <input
            id={`approval-limit-${userId}`}
            type="number"
            min="0"
            max="1000000"
            step="0.01"
            inputMode="decimal"
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            required
          />
        </div>
        <button type="submit" className="secondary" disabled={busy}>{busy ? t("Saving…") : t("Save limit")}</button>
      </div>
      {currentLimit !== null ? (
        <button type="button" className="text-button approval-reset" onClick={() => save(null)} disabled={busy}>{teamLimit === null ? t("Use the standard limit") : t("Use your team limit")}</button>
      ) : null}
      {saved ? <p className="success-text" role="status">{saved}</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </form>
  );
}
