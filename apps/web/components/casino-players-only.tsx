"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { apiFetch, type MeResponse } from "../lib/api";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { useToast } from "./toaster";

/** A casino game's page: Players play it; staff are sent to the Casino's figures instead. */
export function PlayersOnly({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const [player, setPlayer] = useState(false);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const me = await apiFetch<MeResponse>("/users/me", token);
      if (me.role === "PLAYER") setPlayer(true);
      else router.replace("/dashboard/casino");
    })().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return player ? <>{children}</> : <PageLoading label="Loading the Casino" />;
}
