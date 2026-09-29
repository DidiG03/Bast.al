"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { msg } from "../lib/i18n/core";
import { useI18n } from "./i18n-provider";

const PAGES: Array<{ prefix: string; section: string; label: string }> = [
  { prefix: "/dashboard/users", section: msg("Workspace"), label: msg("Users") },
  { prefix: "/dashboard/players", section: msg("Workspace"), label: msg("Player activity") },
  { prefix: "/dashboard/reports", section: msg("Workspace"), label: msg("Reports") },
  { prefix: "/dashboard/finance", section: msg("Money"), label: msg("Finance") },
  { prefix: "/dashboard/commissions", section: msg("Money"), label: msg("Commissions") },
  { prefix: "/dashboard/odds", section: msg("Betting"), label: msg("Odds") },
  { prefix: "/dashboard/risk", section: msg("Betting"), label: msg("Risk") },
  { prefix: "/dashboard/settlement", section: msg("Betting"), label: msg("Settlement") },
  { prefix: "/dashboard/security", section: msg("Account"), label: msg("Security") },
];

/** "Money / Commissions" in the top bar, so it's always clear where you are. */
export function DashboardTrail() {
  const pathname = usePathname();
  const { t } = useI18n();
  const page = PAGES.find((candidate) => pathname === candidate.prefix || pathname.startsWith(`${candidate.prefix}/`));

  return (
    <nav className="topbar-trail" aria-label={t("Breadcrumb")}>
      <Link href="/dashboard">{t(page ? page.section : "Workspace")}</Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page">{t(page ? page.label : "Overview")}</span>
    </nav>
  );
}
