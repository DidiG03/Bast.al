"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { apiFetch } from "../lib/api";
import { formatMoney } from "../lib/format";
import { useI18n } from "./i18n-provider";
import { LoadingSpinner } from "./loading-spinner";
import { useToast } from "./toaster";
import { useDismiss } from "./use-dismiss";

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

/** "Ask for a top-up" opens a modal: optional amount, then Send or Cancel. */
export function TopUpRequestButton({ className = "secondary" }: { className?: string }) {
  const { t } = useI18n();
  const { request, busy } = useTopUpRequest();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  function close() {
    if (busy) return;
    setOpen(false);
    setAmount("");
  }

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {t("Ask for a top-up")}
      </button>
      {open ? <TopUpRequestModal amount={amount} setAmount={setAmount} inputRef={input} busy={busy} onClose={close} onSend={() => {
        const value = Number(amount);
        void request(amount !== "" && value > 0 ? Math.round(value * 100) / 100 : undefined).then((sent) => {
          if (sent) {
            setOpen(false);
            setAmount("");
          }
        });
      }} /> : null}
    </>
  );
}

function TopUpRequestModal({
  amount,
  setAmount,
  inputRef,
  busy,
  onClose,
  onSend,
}: {
  amount: string;
  setAmount: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  busy: boolean;
  onClose: () => void;
  onSend: () => void;
}) {
  const { t } = useI18n();
  useDismiss(() => {
    if (!busy) onClose();
  });

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal card top-up-modal" role="dialog" aria-modal="true" aria-labelledby="top-up-title">
        <div className="modal-header">
          <h2 id="top-up-title">{t("Ask for a top-up")}</h2>
          <button type="button" className="modal-close secondary" onClick={onClose} disabled={busy} aria-label={t("Close")}>
            ×
          </button>
        </div>
        <form
          className="top-up-ask"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <label>
            {t("How much? (optional)")}
            <input
              ref={inputRef}
              type="number"
              min="1"
              max="1000000"
              step="1"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>
              {t("Cancel")}
            </button>
            <button type="submit" disabled={busy}>
              {busy ? <LoadingSpinner label="Sending" size="small" /> : t("Send")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
