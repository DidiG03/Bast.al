"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatMoney } from "../lib/format";
import { NamedIcon } from "./icons";
import { useRealtime } from "./realtime-provider";

/**
 * The Player's balance in the top bar. It follows the live balance itself, so
 * a casino spin or a settled bet shows here at once without re-rendering the
 * whole dashboard on the server.
 */
export function BalanceChip({ balance, title }: { balance: number; title: string }) {
  const [shown, setShown] = useState(balance);
  // A fresh server render brings the balance too.
  useEffect(() => setShown(balance), [balance]);
  useRealtime((event) => {
    if (event.type === "balance.changed") setShown(event.balance);
  });
  return (
    <Link href="/dashboard/money" className="player-balance-chip" title={title}>
      <span className="player-balance-chip-icon" aria-hidden="true">
        <NamedIcon name="wallet" />
      </span>
      {formatMoney(shown)}
    </Link>
  );
}
