"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useState } from "react";
import { apiFetch, DEFAULT_APPROVAL_LIMIT } from "../lib/api";
import { formatMoney } from "../lib/format";

type Props = {
  userId: string;
  /** The Manager's personal limit, or null when they use the platform default. */
  currentLimit: number | null;
  onSaved?: (limit: number | null) => void;
};

/** Owner (or Super Admin) sets how much a Manager can delegate without asking first. */
export function ApprovalLimitControl({ userId, currentLimit, onSaved }: Props) {
  const { getToken } = useAuth();
  const [limit, setLimit] = useState(String(currentLimit ?? DEFAULT_APPROVAL_LIMIT));
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
      setLimit(String(value ?? DEFAULT_APPROVAL_LIMIT));
      setSaved(value === null ? "Back to the standard limit." : "Approval limit saved.");
      onSaved?.(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the approval limit");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = Number(limit);
    if (!Number.isFinite(value) || value < 0 || value > 1000000) {
      setError("Enter an amount between $0 and $1,000,000");
      return;
    }
    save(value).catch(() => undefined);
  }

  return (
    <form className="commission-field" onSubmit={submit}>
      <div>
        <h2>Approval limit</h2>
        <p className="muted">
          This Manager can send up to this much to a Player without your approval. Anything larger waits for you. The standard limit is {formatMoney(DEFAULT_APPROVAL_LIMIT)}.
        </p>
      </div>
      <div className="commission-input-row">
        <label htmlFor={`approval-limit-${userId}`}>Limit</label>
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
        <button type="submit" className="secondary" disabled={busy}>{busy ? "Saving…" : "Save limit"}</button>
      </div>
      {currentLimit !== null ? (
        <button type="button" className="text-button approval-reset" onClick={() => save(null)} disabled={busy}>Use the standard limit</button>
      ) : null}
      {saved ? <p className="success-text" role="status">{saved}</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </form>
  );
}
