"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useState } from "react";
import { apiFetch, type BulkAction, type BulkResult, type UserRow } from "../lib/api";
import { formatMoney } from "../lib/format";
import { LoadingSpinner } from "./loading-spinner";

const TITLES: Record<BulkAction, string> = {
  suspend: "Suspend",
  unsuspend: "Reactivate",
  delegate: "Top up",
  reassign: "Move",
};

type Props = {
  action: BulkAction;
  users: UserRow[];
  /** Where Players can be moved (for "reassign"). */
  destinations: UserRow[];
  onClose: () => void;
  /** Called once the server answered, with a one-line summary. */
  onDone: (summary: string, failedIds: string[]) => void;
};

function summarize(action: BulkAction, users: UserRow[], result: BulkResult, amount: number): { summary: string; failures: Array<{ username: string; error: string }> } {
  const byId = new Map(users.map((user) => [user.id, user.username]));
  const done = result.results.filter((r) => r.ok && !r.pending).length;
  const pending = result.results.filter((r) => r.pending).length;
  const failures = result.results.filter((r) => !r.ok).map((r) => ({ username: byId.get(r.id) ?? r.id, error: r.error ?? "Failed" }));
  const verb = action === "suspend" ? "Suspended" : action === "unsuspend" ? "Reactivated" : action === "reassign" ? "Moved" : `Sent ${formatMoney(amount)} to`;
  const parts = [`${verb} ${done} of ${users.length}.`];
  if (pending) parts.push(`${pending} waiting for approval.`);
  if (failures.length) parts.push(`${failures.length} failed.`);
  return { summary: parts.join(" "), failures };
}

/** Confirms one action for every selected account, then shows what happened to each. */
export function BulkActionModal({ action, users, destinations, onClose, onDone }: Props) {
  const { getToken } = useAuth();
  const [amount, setAmount] = useState("");
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<Array<{ username: string; error: string }> | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const names = users.map((user) => user.username);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const value = Math.round(Number(amount) * 100) / 100;
    if (action === "delegate" && !(value > 0 && value <= 1000000)) {
      setError("Enter an amount between $0 and $1,000,000");
      return;
    }
    if (action === "reassign" && !parentId) {
      setError("Choose where to move them");
      return;
    }
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      const result = await apiFetch<BulkResult>("/users/bulk", token, {
        method: "POST",
        body: JSON.stringify({ action, ids: users.map((user) => user.id), amount: action === "delegate" ? value : undefined, parentId: action === "reassign" ? parentId : undefined }),
      });
      const outcome = summarize(action, users, result, value);
      const failedIds = result.results.filter((r) => !r.ok).map((r) => r.id);
      if (outcome.failures.length === 0) {
        onDone(outcome.summary, failedIds);
        return;
      }
      // Keep the window open so the reasons can be read.
      setSummary(outcome.summary);
      setFailures(outcome.failures);
      onDone(outcome.summary, failedIds);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  const title = `${TITLES[action]} ${users.length} ${users.length === 1 ? "account" : "accounts"}`;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal card" role="dialog" aria-modal="true" aria-labelledby="bulk-title">
        <div className="modal-header">
          <h2 id="bulk-title">{failures ? "Some didn't go through" : `${title}?`}</h2>
          <button type="button" className="modal-close secondary" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
        {failures ? (
          <div className="stack">
            <p style={{ margin: 0 }}>{summary}</p>
            <ul className="bulk-failures">
              {failures.map((failure) => (
                <li key={failure.username}><strong>{failure.username}</strong><span className="muted">{failure.error}</span></li>
              ))}
            </ul>
            <p className="muted" style={{ margin: 0 }}>The ones that failed are still selected.</p>
            <div className="modal-actions"><button type="button" onClick={onClose}>Done</button></div>
          </div>
        ) : (
          <form className="stack" onSubmit={submit}>
            <p className="bulk-names">{names.slice(0, 8).join(", ")}{names.length > 8 ? ` and ${names.length - 8} more` : ""}</p>
            {action === "suspend" ? <p className="muted" style={{ margin: 0 }}>They can&rsquo;t sign in until reactivated, and anyone under them is locked out too.</p> : null}
            {action === "delegate" ? (
              <label className="stack" style={{ gap: "0.35rem" }}>
                <span>Amount for each</span>
                <div className="commission-input">
                  <span aria-hidden="true">$</span>
                  <input type="number" min="0.01" max="1000000" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus required />
                </div>
                {Number(amount) > 0 ? <span className="muted">{formatMoney(Number(amount) * users.length)} in total</span> : null}
              </label>
            ) : null}
            {action === "reassign" ? (
              <label className="stack" style={{ gap: "0.35rem" }}>
                <span>Move to</span>
                <select value={parentId} onChange={(e) => setParentId(e.target.value)} required>
                  <option value="">Choose a Manager or Owner</option>
                  {destinations.map((user) => <option key={user.id} value={user.id}>{user.username} ({user.role === "OWNER" ? "Owner" : "Manager"})</option>)}
                </select>
              </label>
            ) : null}
            {error ? <p className="error-text" role="alert">{error}</p> : null}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" disabled={busy}>{busy ? <LoadingSpinner label="Working" size="small" /> : title}</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
