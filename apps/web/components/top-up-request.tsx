"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useState } from "react";
import { apiFetch } from "../lib/api";
import { formatMoney } from "../lib/format";
import { useI18n } from "./i18n-provider";
import { LoadingSpinner } from "./loading-spinner";
import { useToast } from "./toaster";

/** Sends the Player's Manager (or Owner) a notification asking for more money, for an amount if they name one. */
export function useTopUpRequest() {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const request = useCallback(
    async (amount?: number) => {
      const token = await getToken();
      if (!token) return false;
      setBusy(true);
      try {
        await apiFetch("/users/me/top-up-request", token, { method: "POST", body: JSON.stringify(amount && amount > 0 ? { amount } : {}) });
        toast.success(
          amount && amount > 0
            ? t("We asked your Manager or Owner for {amount}. You'll get a notification when the money arrives.", { amount: formatMoney(amount) })
            : t("We asked your Manager or Owner for a top-up. You'll get a notification when the money arrives."),
        );
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("Couldn't send your request"));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [getToken, toast, t],
  );

  return { request, busy };
}

/** "Ask for a top-up", then how much (optional) and Send. */
export function TopUpRequestButton({ className = "secondary" }: { className?: string }) {
  const { t } = useI18n();
  const { request, busy } = useTopUpRequest();
  const [asking, setAsking] = useState(false);
  const [amount, setAmount] = useState("");
  if (!asking) {
    return (
      <button type="button" className={className} onClick={() => setAsking(true)}>
        {t("Ask for a top-up")}
      </button>
    );
  }
  const value = Number(amount);
  return (
    <form
      className="top-up-ask"
      onSubmit={(event) => {
        event.preventDefault();
        void request(amount !== "" && value > 0 ? Math.round(value * 100) / 100 : undefined).then((sent) => {
          if (sent) {
            setAsking(false);
            setAmount("");
          }
        });
      }}
    >
      <label>
        {t("How much? (optional)")}
        <input type="number" min="1" max="1000000" step="1" inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus />
      </label>
      <button type="submit" className={className} disabled={busy}>
        {busy ? <LoadingSpinner label="Sending" size="small" /> : t("Send request")}
      </button>
      <button type="button" className="text-button" onClick={() => setAsking(false)} disabled={busy}>
        {t("Cancel")}
      </button>
    </form>
  );
}
