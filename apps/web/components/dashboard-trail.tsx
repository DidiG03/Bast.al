"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PAGES: Array<{ prefix: string; section: string; label: string }> = [
  { prefix: "/dashboard/users", section: "Workspace", label: "Users" },
  { prefix: "/dashboard/players", section: "Workspace", label: "Player activity" },
  { prefix: "/dashboard/reports", section: "Workspace", label: "Reports" },
  { prefix: "/dashboard/finance", section: "Money", label: "Finance" },
  { prefix: "/dashboard/commissions", section: "Money", label: "Commissions" },
  { prefix: "/dashboard/odds", section: "Betting", label: "Odds" },
  { prefix: "/dashboard/risk", section: "Betting", label: "Risk" },
  { prefix: "/dashboard/settlement", section: "Betting", label: "Settlement" },
  { prefix: "/dashboard/security", section: "Account", label: "Security" },
];

/** "Money / Commissions" in the top bar, so it's always clear where you are. */
export function DashboardTrail() {
  const pathname = usePathname();
  const page = PAGES.find((candidate) => pathname === candidate.prefix || pathname.startsWith(`${candidate.prefix}/`));

  return (
    <nav className="topbar-trail" aria-label="Breadcrumb">
      <Link href="/dashboard">{page ? page.section : "Workspace"}</Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page">{page ? page.label : "Overview"}</span>
    </nav>
  );
}
