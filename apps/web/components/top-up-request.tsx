"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useState } from "react";
import { apiFetch } from "../lib/api";
import { useI18n } from "./i18n-provider";
import { LoadingSpinner } from "./loading-spinner";
import { useToast } from "./toaster";

/** Sends the Player's Manager (or Owner) a notification asking for more money. */
export function useTopUpRequest() {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const request = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    try {
      await apiFetch("/users/me/top-up-request", token, { method: "POST" });
      toast.success(t("We asked your Manager or Owner for a top-up. You'll get a notification when the money arrives."));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Couldn't send your request"));
    } finally {
      setBusy(false);
    }
  }, [getToken, toast, t]);

  return { request, busy };
}

export function TopUpRequestButton({ className = "secondary" }: { className?: string }) {
  const { t } = useI18n();
  const { request, busy } = useTopUpRequest();
  return (
    <button type="button" className={className} onClick={() => void request()} disabled={busy}>
      {busy ? <LoadingSpinner label="Sending" size="small" /> : t("Ask for a top-up")}
    </button>
  );
}
