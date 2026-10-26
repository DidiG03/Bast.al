"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "./i18n-provider";

/** On a casino game, the way back to the lobby. The lobby itself has no need of it. */
export function CasinoNavBack() {
  const pathname = usePathname();
  const { t } = useI18n();
  if (!pathname.startsWith("/dashboard/casino/")) return null;
  return (
    <Link href="/dashboard/casino" className="topbar-casino">
      ‹ {t("Casino")}
    </Link>
  );
}
