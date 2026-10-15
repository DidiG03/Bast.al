"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { msg } from "../lib/i18n/core";
import { useI18n } from "./i18n-provider";

/** Each page's name, as its tab calls it. The first part of the trail goes back to the Overview. */
const PAGES: Array<{ prefix: string; label: string }> = [
  { prefix: "/dashboard/people", label: msg("People") },
  { prefix: "/dashboard/players", label: msg("People") },
  { prefix: "/dashboard/reports", label: msg("Reports") },
  { prefix: "/dashboard/finance", label: msg("Money") },
  { prefix: "/dashboard/commissions", label: msg("Earnings") },
  { prefix: "/dashboard/odds", label: msg("Prices") },
  { prefix: "/dashboard/risk", label: msg("Money at risk") },
  { prefix: "/dashboard/settlement", label: msg("Bets") },
  { prefix: "/dashboard/settings", label: msg("Settings") },
  { prefix: "/dashboard/casino", label: msg("Casino") },
  { prefix: "/dashboard/security", label: msg("My account") },
];

/** "Overview / Money" in the top bar, so it's always clear where you are and how to get back. On the Overview itself, just "Overview". */
export function DashboardTrail({ role }: { role: string }) {
  const pathname = usePathname();
  const { t } = useI18n();
  const page = PAGES.find((candidate) => pathname === candidate.prefix || pathname.startsWith(`${candidate.prefix}/`));
  // Super Admin's tabs: the settlement page is "Results" and People is everyone; for the others they're "Bets" and their team.
  const label =
    page?.prefix === "/dashboard/settlement" && role === "SUPER_ADMIN"
      ? "Results"
      : page?.prefix === "/dashboard/people"
        ? role === "OWNER"
          ? "Team"
          : role === "MANAGER"
            ? "Players"
            : "People"
        : page?.label;

  return (
    <nav className="topbar-trail" aria-label={t("Breadcrumb")}>
      {label ? (
        <>
          <Link href="/dashboard">{t("Overview")}</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{t(label)}</span>
        </>
      ) : (
        <span aria-current="page">{t("Overview")}</span>
      )}
    </nav>
  );
}
