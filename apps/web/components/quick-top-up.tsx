"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useState } from "react";
import { apiFetch, type UserRow } from "../lib/api";
import { formatMoney } from "../lib/format";
import { LoadingSpinner } from "./loading-spinner";

const PRESETS = [10, 20, 50, 100, 200, 500];

type Props = {
  player: UserRow;
  /** The sender's own balance: presets above it are disabled. */
  available: number;
  /** Above this, the transfer waits for approval instead of going through. */
  approvalLimit: number;
  onClose: () => void;
  onDone: (message: string) => void;
};

/** One tap to send a Player a preset amount of credit. */
export function QuickTopUp({ player, available, approvalLimit, onClose, onDone }: Props) {
  const { getToken } = useAuth();
  const [custom, setCustom] = useState("");
  const [sending, setSending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headroom = Math.max(0, Number(player.balanceLimit) - Number(player.balance));

  async function send(amount: number) {
    setError(null);
    setSending(amount);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      const result = await apiFetch<{ requiresApproval?: boolean }>(`/users/${player.id}/delegate`, token, {
        method: "POST",
        body: JSON.stringify({ amount, reason: "Quick top-up" }),
      });
      onDone(
        result.requiresApproval
          ? `${formatMoney(amount)} to ${player.username} is waiting for approval.`
          : `Sent ${formatMoney(amount)} to ${player.username}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Top-up failed");
    } finally {
      setSending(null);
    }
  }

  function sendCustom(event: FormEvent) {
    event.preventDefault();
    const amount = Number(custom);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter an amount above $0");
      return;
    }
    send(Math.round(amount * 100) / 100).catch(() => undefined);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal card top-up-sheet" role="dialog" aria-modal="true" aria-labelledby="top-up-title">
        <div className="modal-header">
          <h2 id="top-up-title">Top up {player.username}</h2>
          <button type="button" className="modal-close secondary" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Their balance: <strong>{formatMoney(player.balance)}</strong> · Yours: <strong>{formatMoney(available)}</strong>
        </p>
        <div className="top-up-presets">
          {PRESETS.map((amount) => (
            <button
              type="button"
              key={amount}
              className="secondary"
              onClick={() => send(amount)}
              disabled={sending !== null || amount > available || amount > headroom}
            >
              {sending === amount ? <LoadingSpinner label="Sending" size="small" /> : formatMoney(amount).replace(".00", "")}
            </button>
          ))}
        </div>
        <form className="top-up-custom" onSubmit={sendCustom}>
          <label>
            Other amount
            <input type="number" min="0.01" max="1000000" step="0.01" inputMode="decimal" placeholder="0.00" value={custom} onChange={(event) => setCustom(event.target.value)} />
          </label>
          <button type="submit" disabled={sending !== null || !custom}>Send</button>
        </form>
        <p className="muted top-up-note">
          Sends straight away. Anything over {formatMoney(approvalLimit)} waits for approval.
          {headroom < PRESETS[0] ? " This player is at their balance limit." : ""}
        </p>
        {error ? <p className="error-text" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
