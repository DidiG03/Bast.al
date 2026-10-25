"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { formatMoney } from "../lib/format";
import { NamedIcon } from "./icons";
import { useRealtime } from "./realtime-provider";

// A casino game on the page shows its own credits, which wait for the animation (the win arrives as the
// coin lands, the reels stop, the ball drops). While one is open, the chip shows those, not the live
// balance, so the top bar never gives the result away before the game does.
let gameBalance: number | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const setGameBalance = (value: number | null) => {
  gameBalance = value;
  listeners.forEach((listener) => listener());
};

// A balance an action on the page already knows (a bet just placed answers with it): shown at once, without
// waiting for the live stream, which may be reconnecting or held up on the way.
const balanceListeners = new Set<(balance: number) => void>();

/** Shows a balance the page just learned in every chip, e.g. from the answer to a bet. */
export function showBalance(balance: number) {
  balanceListeners.forEach((listener) => listener(balance));
}

/** A casino game hands the chip the credits it shows; null while it hasn't loaded. */
export function useChipBalance(balance: number | null) {
  useEffect(() => setGameBalance(balance), [balance]);
  useEffect(() => () => setGameBalance(null), []);
}

/**
 * The account's balance in the top bar (Players, Owners and Managers). It follows the live balance itself, so
 * a casino spin or a settled bet shows here at once without re-rendering the
 * whole dashboard on the server.
 */
export function BalanceChip({ balance, title, href = "/dashboard/money" }: { balance: number; title: string; href?: string }) {
  const [shown, setShown] = useState(balance);
  const inGame = useSyncExternalStore(subscribe, () => gameBalance, () => null);
  // A fresh server render brings the balance too.
  useEffect(() => setShown(balance), [balance]);
  useRealtime((event) => {
    if (event.type === "balance.changed") setShown(event.balance);
  });
  useEffect(() => {
    balanceListeners.add(setShown);
    return () => void balanceListeners.delete(setShown);
  }, []);
  return (
    <Link href={href} className="player-balance-chip" title={title}>
      <span className="player-balance-chip-icon" aria-hidden="true">
        <NamedIcon name="wallet" />
      </span>
      {formatMoney(inGame ?? shown)}
    </Link>
  );
}
