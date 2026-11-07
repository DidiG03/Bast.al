"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import { useI18n } from "./i18n-provider";
import { useToast } from "./toaster";
import { apiFetch } from "../lib/api";
import { serverNow } from "../lib/clock";
import { formatMoney } from "../lib/format";

/** The lobby's games, as GET /casino/session names them. */
export type CasinoSessionGame = "slot" | "book" | "blackjack" | "roulette" | "mines" | "penalty" | "plinko" | "dice" | "keno" | "coinflip" | "scratch" | "crash" | "baccarat" | "hilo" | "wheel" | "tower" | "candy";

type Session = { rounds: number; gambles: number; staked: number; won: number; net: number };

/** How long the summary stays up: long enough to read it on the way to the next page. */
const SUMMARY_MS = 12_000;

/**
 * The session summary: when the Player leaves a game (back to the lobby, to
 * another page, to another game), a note sums up what they played there since
 * they opened it: rounds, what the paid rounds took, what came back, the
 * difference and how long. The API counts it from the rounds themselves
 * (GET /casino/session), so it's right whatever the page saw. Nothing shows
 * when no round was played.
 */
export function useCasinoSession(game: CasinoSessionGame, name: string) {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const toast = useToast();
  // Read when the game closes, after its last render: the newest of each.
  const latest = useRef({ getToken, i18n, toast, name });
  latest.current = { getToken, i18n, toast, name };

  useEffect(() => {
    const since = new Date(serverNow()).toISOString();
    const opened = Date.now();
    return () => {
      const { getToken, i18n, toast, name } = latest.current;
      void (async () => {
        const token = await getToken();
        if (!token) return;
        const session = await apiFetch<Session>(`/casino/session?game=${game}&since=${encodeURIComponent(since)}`, token);
        if (session.rounds + session.gambles === 0) return;
        const { t, tn } = i18n;
        const minutes = Math.max(1, Math.round((Date.now() - opened) / 60_000));
        const parts = [
          tn(session.rounds, "{count} round", "{count} rounds"),
          t("staked {amount}", { amount: formatMoney(session.staked) }),
          t("won {amount}", { amount: formatMoney(session.won) }),
          `${session.net >= 0 ? "+" : "−"}${formatMoney(Math.abs(session.net))}`,
          tn(minutes, "{count} minute", "{count} minutes"),
        ];
        const show = session.net > 0 ? toast.success : toast.info;
        show(parts.join(" · "), { title: t("Your {game} session", { game: name }), duration: SUMMARY_MS });
      })().catch(() => undefined);
    };
  }, [game]);
}
