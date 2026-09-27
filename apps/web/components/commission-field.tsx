"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useState } from "react";
import { apiFetch } from "../lib/api";

type Props = {
  userId: string;
  currentRate: number;
  label?: string;
  description?: string;
  onSaved?: (rate: number) => void;
};

export function CommissionRateControl({ userId, currentRate, label = "Commission rate", description, onSaved }: Props) {
  const { getToken } = useAuth();
  const [rate, setRate] = useState(String(currentRate));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    setError(null);
    const value = Number(rate);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      setError("Commission must be between 0% and 100%");
      return;
    }
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    try {
      await apiFetch(`/users/${userId}/commission-rate`, token, { method: "POST", body: JSON.stringify({ rate: value }) });
      setSaved(true);
      onSaved?.(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save commission rate");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="commission-field" onSubmit={save}>
      <div>
        <h2>{label}</h2>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      <div className="commission-input-row">
        <label htmlFor={`commission-rate-${userId}`}>Rate</label>
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
        <button type="submit" className="secondary" disabled={busy}>{busy ? "Saving…" : "Save rate"}</button>
      </div>
      {saved ? <p className="success-text" role="status">Commission rate saved.</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </form>
  );
}
