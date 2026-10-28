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
import { useDismiss } from "./use-dismiss";

const PRESETS = [10, 20, 50, 100, 200, 500];
/** Super Admin tops up Owners, who hand it on to their whole team: bigger steps. */
const OWNER_PRESETS = [1000, 5000, 10000, 20000, 50000, 100000];

type Props = {
  player: UserRow;
  /** The sender's own balance: presets above it are disabled. */
  available: number;
  /** Above this, the transfer waits for approval instead of going through. */
  approvalLimit: number;
  onClose: () => void;
  onDone: (message: string) => void;
  /** Super Admin's credit is new money: it comes out of no balance and needs no approval. */
  newMoney?: boolean;
  /** What the Player asked for in a top-up request: the amount box starts with it. */
  amount?: number;
  /** Who's sending: says whom to ask for credit when their own balance is too low. */
  senderRole?: "OWNER" | "MANAGER" | "SUPER_ADMIN";
};

/** One tap to give someone a preset amount of credit, or the amount they asked for. */
export function QuickTopUp({ player, available, approvalLimit, onClose, onDone, newMoney = false, amount: asked, senderRole }: Props) {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const moneyKey = useIdempotencyKey();
  const [custom, setCustom] = useState(asked && asked > 0 ? String(asked) : "");
  useDismiss(onClose);
  const [sending, setSending] = useState<number | null>(null);
  const toast = useToast();
  const headroom = Math.max(0, Number(player.balanceLimit) - Number(player.balance));
  const presets = newMoney ? OWNER_PRESETS : PRESETS;
  const spendable = newMoney ? Number.POSITIVE_INFINITY : available;
  const typed = Number(custom);
  const typedAmount = custom !== "" && Number.isFinite(typed) && typed > 0 ? typed : null;
  // Not enough of their own balance for the smallest amount, or for the one typed: say so and whom to ask.
  const short = !newMoney && (available < Math.min(presets[0], typedAmount ?? presets[0]) || (typedAmount !== null && typedAmount > available));
  const askFrom = senderRole === "MANAGER" ? t("Ask your Owner for credit first.") : t("Ask Super Admin for credit first.");

  // A Player already at their limit can't take more; say so as the sheet opens.
  useEffect(() => {
    if (headroom < presets[0]) toast.warning(newMoney ? t("{name} is at their balance limit.", { name: player.username }) : t("This Player is at their balance limit."));
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
          <h2 id="top-up-title">
            {t("Give credit to {name}", { name: player.username })}
            {newMoney ? (
              <HelpTip text="Send credit to this Owner. Tap an amount, or type your own and press Send. It is new money: it comes out of no balance, and the Owner hands it on to their team." />
            ) : (
              <HelpTip text="Send credit to this person. Tap an amount, or type your own and press Send. It comes out of your own balance." />
            )}
          </h2>
          <button type="button" className="modal-close secondary" onClick={onClose} aria-label={t("Close")}>×</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t("Their balance:")} <strong>{formatMoney(player.balance)}</strong>
          {newMoney ? null : <> · {t("Yours:")} <strong>{formatMoney(available)}</strong></>}
        </p>
        {asked && asked > 0 ? <p className="field-hint" style={{ margin: 0 }}>{t("{name} asked for {amount}.", { name: player.username, amount: formatMoney(asked) })}</p> : null}
        {short ? (
          <p className="bm-note top-up-short" role="alert">
            {typedAmount !== null && available >= presets[0]
              ? t("You have {amount}, not enough for {wanted}.", { amount: formatMoney(available), wanted: formatMoney(typedAmount) })
              : t("You have {amount}.", { amount: formatMoney(available) })}{" "}
            {askFrom}
          </p>
        ) : null}
        <div className="top-up-presets">
          {presets.map((amount) => (
            <button
              type="button"
              key={amount}
              className="secondary"
              onClick={() => send(amount)}
              disabled={sending !== null || amount > spendable || amount > headroom}
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
          <button type="submit" disabled={sending !== null || typedAmount === null || typedAmount > spendable || typedAmount > headroom}>{t("Send")}</button>
        </form>
        {/* Only says it sends straight away when it can. */}
        {newMoney ? (
          <p className="muted top-up-note">{t("Sends straight away. It doesn't come out of any balance.")}</p>
        ) : short ? null : typedAmount !== null && typedAmount > approvalLimit ? (
          <p className="muted top-up-note">{t("{amount} is over {limit}: it waits for approval before it's sent.", { amount: formatMoney(typedAmount), limit: formatMoney(approvalLimit) })}</p>
        ) : (
          <p className="muted top-up-note">{t("Sends straight away. Anything over {amount} waits for approval.", { amount: formatMoney(approvalLimit) })}</p>
        )}
      </section>
    </div>
  );
}
