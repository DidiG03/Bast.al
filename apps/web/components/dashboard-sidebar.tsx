"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type TouchEvent } from "react";
import type { UserRole } from "../lib/api";
import { NamedIcon, type IconName } from "./icons";
import { UserMenu } from "./user-menu";
import { msg } from "../lib/i18n/core";
import { useI18n } from "./i18n-provider";
import { BrandMark } from "./brand-mark";

type SidebarProps = {
  role: UserRole;
  username: string;
  initialCollapsed: boolean;
  /** Player only: show the Casino tab (it's open to them). */
  casinoOpen?: boolean;
};

type NavLink = { href: string; label: string; icon: IconName };
type NavGroup = { label: string; links: NavLink[] };

const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: msg("Super Admin"),
  OWNER: msg("Owner"),
  MANAGER: msg("Manager"),
  PLAYER: msg("Player"),
};

/**
 * What each role can open, named for the job it does. Staff get the same
 * five or six tabs in the same order, so moving between roles (or helping
 * someone with another role) never means learning a new layout:
 * Overview, the people under you, Money, Bets, Earnings, and Settings.
 */
function navGroups(role: UserRole, casinoOpen: boolean): NavGroup[] {
  if (role === "PLAYER") {
    const play: NavLink[] = [{ href: "/dashboard", label: msg("Overview"), icon: "dashboard" }, { href: "/dashboard/bet", label: msg("Bet"), icon: "bet" }];
    if (casinoOpen) play.push({ href: "/dashboard/casino", label: msg("Casino"), icon: "casino" });
    return [
      { label: msg("Play"), links: play },
      { label: msg("Account"), links: [{ href: "/dashboard/money", label: msg("My money"), icon: "wallet" }, { href: "/dashboard/security", label: msg("My account"), icon: "security" }] },
    ];
  }
  if (role === "MANAGER") {
    return [
      {
        label: msg("Every day"),
        links: [
          { href: "/dashboard", label: msg("Overview"), icon: "dashboard" },
          { href: "/dashboard/people", label: msg("Players"), icon: "users" },
          { href: "/dashboard/finance", label: msg("Money"), icon: "finance" },
          { href: "/dashboard/settlement", label: msg("Bets"), icon: "settlement" },
          { href: "/dashboard/commissions", label: msg("Earnings"), icon: "commissions" },
        ],
      },
    ];
  }
  if (role === "OWNER") {
    return [
      {
        label: msg("Every day"),
        links: [
          { href: "/dashboard", label: msg("Overview"), icon: "dashboard" },
          { href: "/dashboard/people", label: msg("Team"), icon: "users" },
          { href: "/dashboard/finance", label: msg("Money"), icon: "finance" },
          { href: "/dashboard/settlement", label: msg("Bets"), icon: "settlement" },
          { href: "/dashboard/commissions", label: msg("Earnings"), icon: "commissions" },
        ],
      },
      { label: msg("Setup"), links: [{ href: "/dashboard/settings", label: msg("Settings"), icon: "sliders" }] },
    ];
  }
  // Super Admin: the same everyday tabs as an Owner, then the betting desk, then setup.
  return [
    {
      label: msg("Every day"),
      links: [
        { href: "/dashboard", label: msg("Overview"), icon: "dashboard" },
        { href: "/dashboard/people", label: msg("People"), icon: "users" },
        { href: "/dashboard/finance", label: msg("Money"), icon: "finance" },
        { href: "/dashboard/settlement", label: msg("Results"), icon: "settlement" },
        { href: "/dashboard/commissions", label: msg("Earnings"), icon: "commissions" },
      ],
    },
    {
      label: msg("Betting"),
      links: [
        { href: "/dashboard/odds", label: msg("Prices"), icon: "odds" },
        { href: "/dashboard/risk", label: msg("Money at risk"), icon: "risk" },
        { href: "/dashboard/casino", label: msg("Casino"), icon: "casino" },
      ],
    },
    {
      label: msg("Setup"),
      links: [
        { href: "/dashboard/reports", label: msg("Reports"), icon: "reports" },
        { href: "/dashboard/settings", label: msg("Settings"), icon: "sliders" },
      ],
    },
  ];
}

/**
 * Pages reached from a tab rather than having one: they light up that tab.
 * Money at risk sits on the Bets tab, and a Player's or Manager's own page,
 * prices and the Casino switch under the tab they're opened from.
 */
const TAB_OF: Array<[string, string]> = [
  ["/dashboard/risk", "/dashboard/settlement"],
  ["/dashboard/players", "/dashboard/people"],
  ["/dashboard/users", "/dashboard/people"],
  ["/dashboard/odds", "/dashboard/settings"],
  ["/dashboard/casino", "/dashboard/settings"],
  ["/dashboard/security", "/dashboard/settings"],
];

export function DashboardSidebar({ role, username, initialCollapsed, casinoOpen = false }: SidebarProps) {
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

  const groups = navGroups(role, casinoOpen);
  const links = groups.flatMap((group) => group.links);
  // The bottom bar fits five tabs; the rest stay in the drawer (Settings, Security, Reports, then the betting pages, Results last).
  let mobileLinks = links;
  for (const href of ["/dashboard/settings", "/dashboard/security", "/dashboard/reports", "/dashboard/risk", "/dashboard/odds", "/dashboard/casino", "/dashboard/settlement"]) {
    if (mobileLinks.length > 5) mobileLinks = mobileLinks.filter((link) => link.href !== href);
  }
  const hrefs = new Set(links.map((link) => link.href));
  const under = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  // A page without a tab of its own lights up the tab it belongs to.
  const current = links.some((link) => link.href !== "/dashboard" && under(link.href)) ? pathname : TAB_OF.find(([page, tab]) => under(page) && hrefs.has(tab))?.[1] ?? pathname;
  const isActive = (href: string) => (href === "/dashboard" ? current === href : current === href || current.startsWith(`${href}/`));

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
            <BrandMark />
            <span className="sidebar-brand-text">Shtatat.al</span>
          </Link>
          <button
            className="sidebar-collapse secondary"
            type="button"
            onClick={toggleCollapsed}
            aria-label={t(collapsed ? "Expand navigation" : "Collapse navigation")}
            title={t(collapsed ? "Expand navigation" : "Collapse navigation")}
          >
            <NamedIcon name={collapsed ? "expand" : "collapse"} />
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
          {/* Your name opens your own account: password, devices, language. */}
          <Link href="/dashboard/security" className="sidebar-account" title={t("My account")} onClick={() => setMobileOpen(false)}>
            <span className="sidebar-avatar" aria-hidden="true">
              {username.slice(0, 2).toUpperCase()}
            </span>
            <span className="sidebar-account-text">
              <span className="sidebar-account-name">{username}</span>
              <span className="sidebar-account-role">{t(ROLE_LABELS[role])} · {t("My account")}</span>
            </span>
          </Link>
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
