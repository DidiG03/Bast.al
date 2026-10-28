"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useI18n } from "./i18n-provider";
import { msg } from "../lib/i18n/core";

const SITE = "Shtatat.al";

/** Each page's name in the browser tab, the sidebar's words; the longest matching start of the address wins. */
const TITLES: Array<[string, string]> = [
  ["/dashboard/bet", msg("Bet")],
  ["/dashboard/casino/slot", "Sizzling Hot"],
  ["/dashboard/casino/book", "Book of Ra"],
  ["/dashboard/casino/roulette", msg("Roulette")],
  ["/dashboard/casino/blackjack", msg("Blackjack")],
  ["/dashboard/casino/penalty", msg("Penalty")],
  ["/dashboard/casino/mines", msg("Mines")],
  ["/dashboard/casino/plinko", "Plinko"],
  ["/dashboard/casino/dice", msg("Dice")],
  ["/dashboard/casino/keno", msg("Keno")],
  ["/dashboard/casino/coin-flip", msg("Coin Flip")],
  ["/dashboard/casino/scratch", msg("Scratch Cards")],
  ["/dashboard/casino", msg("Casino")],
  ["/dashboard/money", msg("My money")],
  ["/dashboard/security", msg("My account")],
  ["/dashboard/people", msg("People")],
  ["/dashboard/players", msg("People")],
  ["/dashboard/users", msg("People")],
  ["/dashboard/finance", msg("Money")],
  ["/dashboard/settlement", msg("Bets")],
  ["/dashboard/commissions", msg("Earnings")],
  ["/dashboard/odds", msg("Prices")],
  ["/dashboard/risk", msg("Money at risk")],
  ["/dashboard/reports", msg("Reports")],
  ["/dashboard/settings/danger", msg("Danger zone")],
  ["/dashboard/settings", msg("Settings")],
  ["/dashboard", msg("Overview")],
  ["/sign-in", msg("Sign in")],
];

/** Sets the tab's title, "Bet · Shtatat.al", as the address changes. */
export function PageTitle() {
  const pathname = usePathname();
  const { t } = useI18n();
  useEffect(() => {
    const match = TITLES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    document.title = match ? `${t(match[1])} · ${SITE}` : SITE;
  }, [pathname, t]);
  return null;
}
