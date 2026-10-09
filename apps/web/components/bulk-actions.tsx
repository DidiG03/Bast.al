"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useState } from "react";
import { apiFetch, type BulkAction, type BulkResult, type UserRow } from "../lib/api";
import { formatMoney } from "../lib/format";
import { useIdempotencyKey } from "../lib/use-idempotency-key";
import { LoadingSpinner } from "./loading-spinner";
import { useI18n, type I18n } from "./i18n-provider";
import { useToast } from "./toaster";
import { HelpTip } from "./help-tip";



type Props = {
  action: BulkAction;
  users: UserRow[];
  /** Where Players can be moved (for "reassign"). */
  destinations: UserRow[];
  onClose: () => void;
  /** Called once the server answered, with a one-line summary. */
  onDone: (summary: string, failedIds: string[]) => void;
};

function summarize(
  { t, ts }: I18n,
  action: BulkAction,
  users: UserRow[],
  result: BulkResult,
  amount: number,
): { summary: string; failures: Array<{ username: string; error: string }> } {
  const byId = new Map(users.map((user) => [user.id, user.username]));
  const done = result.results.filter((r) => r.ok && !r.pending).length;
  const pending = result.results.filter((r) => r.pending).length;
  const failures = result.results.filter((r) => !r.ok).map((r) => ({ username: byId.get(r.id) ?? r.id, error: r.error ? ts(r.error) : t("Failed") }));
  const counts = { done, total: users.length };
  const parts = [
    action === "suspend"
      ? t("Suspended {done} of {total}.", counts)
      : action === "unsuspend"
        ? t("Reactivated {done} of {total}.", counts)
        : action === "reassign"
          ? t("Moved {done} of {total}.", counts)
          : t("Sent {amount} to {done} of {total}.", { ...counts, amount: formatMoney(amount) }),
  ];
  if (pending) parts.push(t("{count} waiting for approval.", { count: pending }));
  if (failures.length) parts.push(t("{count} failed.", { count: failures.length }));
  return { summary: parts.join(" "), failures };
}

/** Confirms one action for every selected account, then shows what happened to each. */
export function BulkActionModal({ action, users, destinations, onClose, onDone }: Props) {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t, tn } = i18n;
  const moneyKey = useIdempotencyKey();
  const [amount, setAmount] = useState("");
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const names = users.map((user) => user.username);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = Math.round(Number(amount) * 100) / 100;
    if (action === "delegate" && !(value > 0 && value <= 1000000)) {
      toast.error(t("Enter an amount between 0 ALL and 1,000,000 ALL"));
      return;
    }
    if (action === "reassign" && !parentId) {
      toast.error(t("Choose where to move them"));
      return;
    }
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const body = JSON.stringify({ action, ids: users.map((user) => user.id), amount: action === "delegate" ? value : undefined, parentId: action === "reassign" ? parentId : undefined });
      const result = await apiFetch<BulkResult>("/users/bulk", token, { method: "POST", body, idempotencyKey: moneyKey.keyFor("/users/bulk", body) });
      moneyKey.done();
      const outcome = summarize(i18n, action, users, result, value);
      const failedIds = result.results.filter((r) => !r.ok).map((r) => r.id);
      if (outcome.failures.length > 0) {
        // Each account that failed, with why; they stay selected to try again.
        const shown = outcome.failures.slice(0, 5).map((failure) => `${failure.username}: ${failure.error}`);
        if (outcome.failures.length > 5) shown.push(t("and {count} more", { count: outcome.failures.length - 5 }));
        toast.warning(`${shown.join(" · ")}. ${t("The ones that failed are still selected.")}`, { title: outcome.summary, duration: 12000 });
      }
      onDone(outcome.summary, failedIds);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("That didn't work"));
    } finally {
      setBusy(false);
    }
  }

  const title =
    action === "suspend"
      ? tn(users.length, "Suspend {count} account", "Suspend {count} accounts")
      : action === "unsuspend"
        ? tn(users.length, "Reactivate {count} account", "Reactivate {count} accounts")
        : action === "delegate"
          ? tn(users.length, "Top up {count} account", "Top up {count} accounts")
          : tn(users.length, "Move {count} account", "Move {count} accounts");

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal card" role="dialog" aria-modal="true" aria-labelledby="bulk-title">
        <div className="modal-header">
          <h2 id="bulk-title">{`${title}?`}<HelpTip text="Does the same thing to every account you ticked, all at once. If some fail, a message tells you which and why, and those stay ticked so you can try again." /></h2>
          <button type="button" className="modal-close secondary" onClick={onClose} disabled={busy} aria-label={t("Close")}>×</button>
        </div>
        {(
          <form className="stack" onSubmit={submit}>
            <p className="bulk-names">{names.slice(0, 8).join(", ")}{names.length > 8 ? ` ${t("and {count} more", { count: names.length - 8 })}` : ""}</p>
            {action === "suspend" ? <p className="muted" style={{ margin: 0 }}>{t("They can't sign in until reactivated, and anyone under them is locked out too.")}</p> : null}
            {action === "delegate" ? (
              <label className="stack" style={{ gap: "0.35rem" }}>
                <span>{t("Amount for each")}</span>
                <div className="commission-input">
                  <span aria-hidden="true">ALL</span>
                  <input type="number" min="0.01" max="1000000" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus required />
                </div>
                {Number(amount) > 0 ? <span className="muted">{t("{amount} in total", { amount: formatMoney(Number(amount) * users.length) })}</span> : null}
              </label>
            ) : null}
            {action === "reassign" ? (
              <label className="stack" style={{ gap: "0.35rem" }}>
                <span>{t("Move to")}</span>
                <select value={parentId} onChange={(e) => setParentId(e.target.value)} required>
                  <option value="">{t("Choose a Manager or Owner")}</option>
                  {destinations.map((user) => <option key={user.id} value={user.id}>{user.username} ({user.role === "OWNER" ? t("Owner") : t("Manager")})</option>)}
                </select>
                <span className="muted">{t("Each Player's balance goes back to whoever gave it to them. Players with open bets or a balance below zero stay where they are.")}</span>
              </label>
            ) : null}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
              <button type="submit" disabled={busy}>{busy ? <LoadingSpinner label="Working" size="small" /> : title}</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
