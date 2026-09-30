"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type TouchEvent } from "react";
import type { UserRole } from "../lib/api";
import { NamedIcon, type IconName } from "./icons";
import { UserMenu } from "./user-menu";
import { msg } from "../lib/i18n/core";
import { useI18n } from "./i18n-provider";

type SidebarProps = {
  role: UserRole;
  username: string;
  initialCollapsed: boolean;
};

type NavLink = { href: string; label: string; icon: IconName };
type NavGroup = { label: string; links: NavLink[] };

const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: msg("Super Admin"),
  OWNER: msg("Owner"),
  MANAGER: msg("Manager"),
  PLAYER: msg("Player"),
};

/** What each role can open, grouped the way people think about the work. */
function navGroups(role: UserRole): NavGroup[] {
  if (role === "PLAYER") {
    return [
      { label: msg("Play"), links: [{ href: "/dashboard", label: msg("Overview"), icon: "dashboard" }, { href: "/dashboard/bet", label: msg("Bet"), icon: "bet" }] },
      { label: msg("Account"), links: [{ href: "/dashboard/money", label: msg("My money"), icon: "wallet" }, { href: "/dashboard/security", label: msg("Security"), icon: "security" }] },
    ];
  }
  const betting: NavLink[] = [{ href: "/dashboard/odds", label: msg("Odds"), icon: "odds" }];
  if (role === "OWNER" || role === "SUPER_ADMIN") betting.push({ href: "/dashboard/risk", label: msg("Risk"), icon: "risk" });
  // Owners and Managers see it read-only, limited to their own Players' bets.
  betting.push({ href: "/dashboard/settlement", label: msg("Settlement"), icon: "settlement" });
  return [
    {
      label: msg("Workspace"),
      links: [
        { href: "/dashboard", label: msg("Overview"), icon: "dashboard" },
        { href: "/dashboard/users", label: msg("Users"), icon: "users" },
        { href: "/dashboard/reports", label: msg("Reports"), icon: "reports" },
      ],
    },
    {
      label: msg("Money"),
      links: [
        { href: "/dashboard/finance", label: msg("Finance"), icon: "finance" },
        { href: "/dashboard/commissions", label: msg("Commissions"), icon: "commissions" },
      ],
    },
    { label: msg("Betting"), links: betting },
    { label: msg("Account"), links: [{ href: "/dashboard/security", label: msg("Security"), icon: "security" }] },
  ];
}

export function DashboardSidebar({ role, username, initialCollapsed }: SidebarProps) {
  const pathname = usePathname();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const touchStartX = useRef<number | null>(null);

  // While the drawer is open on a phone, keep the page behind it still and let Escape close it.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setMobileOpen(false);
    document.body.classList.add("is-scroll-locked");
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("is-scroll-locked");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileOpen]);

  // Close the drawer after navigating, including browser back/forward.
  useEffect(() => setMobileOpen(false), [pathname]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `bastal-sidebar=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
  }

  function startSwipe(event: TouchEvent) {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }

  function finishSwipe(event: TouchEvent, opening: boolean) {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start === null) return;
    const distance = (event.changedTouches[0]?.clientX ?? start) - start;
    if (
      (opening && distance > 48) ||
      (!opening && mobileOpen && distance < -48)
    )
      setMobileOpen(opening);
  }

  const groups = navGroups(role);
  const links = groups.flatMap((group) => group.links);
  // The bottom bar fits five tabs; Security, Reports, Settlement, then Odds move to the drawer when a role has more.
  let mobileLinks = links;
  for (const href of ["/dashboard/security", "/dashboard/reports", "/dashboard/settlement", "/dashboard/odds"]) {
    if (mobileLinks.length > 5) mobileLinks = mobileLinks.filter((link) => link.href !== href);
  }
  const isActive = (href: string) =>
    href === "/dashboard"
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <div
        className="sidebar-swipe-zone"
        aria-hidden="true"
        onTouchStart={startSwipe}
        onTouchEnd={(event) => finishSwipe(event, true)}
      />
      <button
        className="sidebar-mobile-trigger secondary"
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label={t("Open navigation")}
        aria-expanded={mobileOpen}
      >
        <NamedIcon name="menu" />
      </button>
      {mobileOpen ? (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label={t("Close navigation")}
          onClick={() => setMobileOpen(false)}
          onTouchStart={startSwipe}
          onTouchEnd={(event) => finishSwipe(event, false)}
        />
      ) : null}
      <aside
        className={`dashboard-sidebar${collapsed ? " is-collapsed" : ""}${mobileOpen ? " is-mobile-open" : ""}`}
        onTouchStart={startSwipe}
        onTouchEnd={(event) => finishSwipe(event, false)}
      >
        <div className="sidebar-header">
          <Link
            href="/dashboard"
            className="sidebar-brand"
            onClick={() => setMobileOpen(false)}
          >
            <span className="sidebar-logo">B</span>
            <span className="sidebar-brand-text">Bast.al</span>
          </Link>
          <button
            className="sidebar-collapse secondary"
            type="button"
            onClick={toggleCollapsed}
            aria-label={t(collapsed ? "Expand navigation" : "Collapse navigation")}
            title={t(collapsed ? "Expand navigation" : "Collapse navigation")}
          >
            <NamedIcon name="panel" />
          </button>
          <button
            className="sidebar-mobile-close secondary"
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label={t("Close navigation")}
          >
            <NamedIcon name="close" />
          </button>
        </div>
        <nav className="sidebar-nav" aria-label={t("Main navigation")}>
          {groups.map((group) => (
            <div key={group.label} className="sidebar-group">
              <span className="sidebar-section-label">{t(group.label)}</span>
              {group.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`sidebar-link${isActive(link.href) ? " is-active" : ""}`}
                  aria-current={isActive(link.href) ? "page" : undefined}
                  title={collapsed ? t(link.label) : undefined}
                  onClick={() => setMobileOpen(false)}
                >
                  <NamedIcon name={link.icon} />
                  <span className="sidebar-link-label">{t(link.label)}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-account">
            <span className="sidebar-avatar" aria-hidden="true">
              {username.slice(0, 2).toUpperCase()}
            </span>
            <span className="sidebar-account-text">
              <span className="sidebar-account-name">{username}</span>
              <span className="sidebar-account-role">{t(ROLE_LABELS[role])}</span>
            </span>
          </div>
          <UserMenu />
        </div>
      </aside>
      <nav className="mobile-bottom-nav" aria-label={t("Mobile navigation")}>
        {mobileLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`mobile-bottom-nav-link${isActive(link.href) ? " is-active" : ""}`}
            aria-current={isActive(link.href) ? "page" : undefined}
          >
            <NamedIcon name={link.icon} />
            <span>{t(link.label)}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
