"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "./i18n-provider";

/**
 * An Owner's Bets tab has two views: the bets themselves, and the money the
 * team could have to pay out on them. This switches between them.
 */
export function BetsTabs() {
  const pathname = usePathname();
  const { t } = useI18n();
  const tabs: Array<[string, string]> = [
    ["/dashboard/settlement", t("Bets")],
    ["/dashboard/risk", t("Money at risk")],
  ];
  return (
    <nav className="segmented" aria-label={t("Bets")}>
      {tabs.map(([href, label]) => (
        <Link key={href} href={href} className={pathname === href ? "is-active" : ""} aria-current={pathname === href ? "page" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
