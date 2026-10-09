"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useState, useEffect } from "react";
import { apiFetch, type UserRow } from "../lib/api";
import { formatMoney } from "../lib/format";
import { useIdempotencyKey } from "../lib/use-idempotency-key";
import { LoadingSpinner } from "./loading-spinner";
import { useToast } from "./toaster";
import { useI18n } from "./i18n-provider";
import { HelpTip } from "./help-tip";

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
  const { t } = useI18n();
  const moneyKey = useIdempotencyKey();
  const [custom, setCustom] = useState("");
  const [sending, setSending] = useState<number | null>(null);
  const toast = useToast();
  const headroom = Math.max(0, Number(player.balanceLimit) - Number(player.balance));

  // A Player already at their limit can't take more; say so as the sheet opens.
  useEffect(() => {
    if (headroom < PRESETS[0]) toast.warning(t("This Player is at their balance limit."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(amount: number) {
    setSending(amount);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const path = `/users/${player.id}/delegate`;
      // Stored in English like every ledger reason, and shown in the reader's language.
      const body = JSON.stringify({ amount, reason: "Quick top-up" });
      const result = await apiFetch<{ requiresApproval?: boolean }>(path, token, { method: "POST", body, idempotencyKey: moneyKey.keyFor(path, body) });
      moneyKey.done();
      onDone(
        result.requiresApproval
          ? t("{amount} to {name} is waiting for approval.", { amount: formatMoney(amount), name: player.username })
          : t("Sent {amount} to {name}.", { amount: formatMoney(amount), name: player.username }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Top-up failed"));
    } finally {
      setSending(null);
    }
  }

  function sendCustom(event: FormEvent) {
    event.preventDefault();
    const amount = Number(custom);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t("Enter an amount above 0 ALL"));
      return;
    }
    send(Math.round(amount * 100) / 100).catch(() => undefined);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal card top-up-sheet" role="dialog" aria-modal="true" aria-labelledby="top-up-title">
        <div className="modal-header">
          <h2 id="top-up-title">{t("Top up {name}", { name: player.username })}<HelpTip text="Send money to this Player fast. Tap an amount, or type your own and press Send. It comes out of your balance straight away." /></h2>
          <button type="button" className="modal-close secondary" onClick={onClose} aria-label={t("Close")}>×</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t("Their balance:")} <strong>{formatMoney(player.balance)}</strong> · {t("Yours:")} <strong>{formatMoney(available)}</strong>
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
            {t("Other amount")}
            <input type="number" min="0.01" max="1000000" step="0.01" inputMode="decimal" placeholder="0.00" value={custom} onChange={(event) => setCustom(event.target.value)} />
          </label>
          <button type="submit" disabled={sending !== null || !custom}>{t("Send")}</button>
        </form>
        <p className="muted top-up-note">
          {t("Sends straight away. Anything over {amount} waits for approval.", { amount: formatMoney(approvalLimit) })}
        </p>
      </section>
    </div>
  );
}
