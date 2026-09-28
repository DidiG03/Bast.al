"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type TouchEvent } from "react";
import type { UserRole } from "../lib/api";
import { NamedIcon, type IconName } from "./icons";
import { UserMenu } from "./user-menu";

type SidebarProps = {
  role: UserRole;
  username: string;
  initialCollapsed: boolean;
};

type NavLink = { href: string; label: string; icon: IconName };
type NavGroup = { label: string; links: NavLink[] };

const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: "Super Admin",
  OWNER: "Owner",
  MANAGER: "Manager",
  PLAYER: "Player",
};

/** What each role can open, grouped the way people think about the work. */
function navGroups(role: UserRole): NavGroup[] {
  if (role === "PLAYER") {
    return [
      { label: "Play", links: [{ href: "/dashboard", label: "Overview", icon: "dashboard" }, { href: "/dashboard/bet", label: "Bet", icon: "bet" }] },
      { label: "Account", links: [{ href: "/dashboard/security", label: "Security", icon: "security" }] },
    ];
  }
  const betting: NavLink[] = [{ href: "/dashboard/odds", label: "Odds", icon: "odds" }];
  if (role === "OWNER" || role === "SUPER_ADMIN") betting.push({ href: "/dashboard/risk", label: "Risk", icon: "risk" });
  if (role === "SUPER_ADMIN") betting.push({ href: "/dashboard/settlement", label: "Settlement", icon: "settlement" });
  return [
    {
      label: "Workspace",
      links: [
        { href: "/dashboard", label: "Overview", icon: "dashboard" },
        { href: "/dashboard/users", label: "Users", icon: "users" },
        { href: "/dashboard/reports", label: "Reports", icon: "reports" },
      ],
    },
    {
      label: "Money",
      links: [
        { href: "/dashboard/finance", label: "Finance", icon: "finance" },
        { href: "/dashboard/commissions", label: "Commissions", icon: "commissions" },
      ],
    },
    { label: "Betting", links: betting },
    { label: "Account", links: [{ href: "/dashboard/security", label: "Security", icon: "security" }] },
  ];
}

export function DashboardSidebar({ role, username, initialCollapsed }: SidebarProps) {
  const pathname = usePathname();
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
        aria-label="Open navigation"
        aria-expanded={mobileOpen}
      >
        <NamedIcon name="menu" />
      </button>
      {mobileOpen ? (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="Close navigation"
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
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
          >
            <NamedIcon name="panel" />
          </button>
          <button
            className="sidebar-mobile-close secondary"
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <NamedIcon name="close" />
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {groups.map((group) => (
            <div key={group.label} className="sidebar-group">
              <span className="sidebar-section-label">{group.label}</span>
              {group.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`sidebar-link${isActive(link.href) ? " is-active" : ""}`}
                  aria-current={isActive(link.href) ? "page" : undefined}
                  title={collapsed ? link.label : undefined}
                  onClick={() => setMobileOpen(false)}
                >
                  <NamedIcon name={link.icon} />
                  <span className="sidebar-link-label">{link.label}</span>
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
              <span className="sidebar-account-role">{ROLE_LABELS[role]}</span>
            </span>
          </div>
          <UserMenu />
        </div>
      </aside>
      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        {mobileLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`mobile-bottom-nav-link${isActive(link.href) ? " is-active" : ""}`}
            aria-current={isActive(link.href) ? "page" : undefined}
          >
            <NamedIcon name={link.icon} />
            <span>{link.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
