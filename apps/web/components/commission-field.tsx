"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type CommissionResponse = { percentage: number; updatedAt: string };

export function CommissionField() {
  const { getToken } = useAuth();
  const [percentage, setPercentage] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getToken().then((token) => token ? apiFetch<CommissionResponse>("/users/commission", token).then((result) => setPercentage(String(result.percentage))).catch(() => setError("Could not load commission")) : undefined);
  }, [getToken]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    setError(null);
    const value = Number(percentage);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      setError("Commission must be between 0% and 100%");
      return;
    }
    const token = await getToken();
    if (!token) return;
    try {
      await apiFetch("/users/commission", token, { method: "POST", body: JSON.stringify({ percentage: value }) });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save commission");
    }
  }

  return (
    <form className="card commission-field" onSubmit={save}>
      <div>
        <h2>Commission</h2>
        <p className="muted">Default platform commission percentage.</p>
      </div>
      <div className="commission-input-row">
        <label htmlFor="commission-percentage">Commission percentage</label>
        <div className="commission-input">
          <input id="commission-percentage" type="number" min="0" max="100" step="0.01" value={percentage} onChange={(event) => setPercentage(event.target.value)} required />
          <span aria-hidden="true">%</span>
        </div>
        <button type="submit">Save commission</button>
      </div>
      {saved ? <p className="success-text" role="status">Commission saved.</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </form>
  );
}
