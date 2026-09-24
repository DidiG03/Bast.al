"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState, type ReactNode, type TouchEvent } from "react";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";

type SidebarProps = {
  canManageUsers: boolean;
  username: string;
  initialCollapsed: boolean;
  canViewFinancial: boolean;
};

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const icons = {
  dashboard: <Icon><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></Icon>,
  users: <Icon><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></Icon>,
  security: <Icon><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4M12 15v2" /></Icon>,
  tickets: <Icon><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V7Z" /><path d="M12 7v2M12 15v2" /></Icon>,
  reports: <Icon><path d="M4 19V5M4 19h17" /><path d="m7 15 4-4 3 2 5-6" /></Icon>,
  audit: <Icon><path d="M6 3h9l3 3v15H6z" /><path d="M9 11h6M9 15h6M9 7h3" /></Icon>,
  collapse: <Icon><path d="m15 18-6-6 6-6" /></Icon>,
  expand: <Icon><path d="m9 18 6-6-6-6" /></Icon>,
  menu: <Icon><path d="M4 6h16M4 12h16M4 18h16" /></Icon>,
  close: <Icon><path d="m6 6 12 12M18 6 6 18" /></Icon>,
};

export function DashboardSidebar({ canManageUsers, canViewReports, canViewFinancial, username, initialCollapsed }: SidebarProps & { canViewReports: boolean }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const touchStartX = useRef<number | null>(null);

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
    if ((opening && distance > 48) || (!opening && mobileOpen && distance < -48)) setMobileOpen(opening);
  }

  const links = [
    { href: "/dashboard", label: "Overview", icon: icons.dashboard },
    ...(canManageUsers ? [{ href: "/dashboard/users", label: "Users", icon: icons.users }] : []),
    { href: "/dashboard/tickets", label: "Tickets", icon: icons.tickets },
    ...(canViewReports ? [{ href: "/dashboard/reports", label: "Reports", icon: icons.reports }] : []),
    ...(canViewReports ? [{ href: "/dashboard/audit", label: "Audit log", icon: icons.audit }] : []),
    ...(canViewFinancial ? [{ href: "/dashboard/finance", label: "Finance", icon: icons.reports }] : []),
    { href: "/dashboard/security", label: "Security", icon: icons.security },
  ];
  const mobileLinks = links.filter((link) => ["/dashboard", "/dashboard/users", "/dashboard/tickets", "/dashboard/security"].includes(link.href));

  return (
    <>
      <div className="sidebar-swipe-zone" aria-hidden="true" onTouchStart={startSwipe} onTouchEnd={(event) => finishSwipe(event, true)} />
      <button className="sidebar-mobile-trigger secondary" type="button" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
        {icons.menu}
      </button>
      {mobileOpen ? <button className="sidebar-backdrop" type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)} onTouchStart={startSwipe} onTouchEnd={(event) => finishSwipe(event, false)} /> : null}
      <aside className={`dashboard-sidebar${collapsed ? " is-collapsed" : ""}${mobileOpen ? " is-mobile-open" : ""}`} onTouchStart={startSwipe} onTouchEnd={(event) => finishSwipe(event, false)}>
        <div className="sidebar-header">
          <Link href="/dashboard" className="sidebar-brand" onClick={() => setMobileOpen(false)}>
            <span className="sidebar-logo">B</span>
            <span className="sidebar-brand-text">Bast.al</span>
          </Link>
          <button className="sidebar-collapse secondary" type="button" onClick={toggleCollapsed} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} title={collapsed ? "Expand navigation" : "Collapse navigation"}>
            {collapsed ? icons.expand : icons.collapse}
          </button>
          <button className="sidebar-mobile-close secondary" type="button" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
            {icons.close}
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          <span className="sidebar-section-label">Workspace</span>
          {links.map((link) => (
            <Link key={link.href} href={link.href} className={`sidebar-link${pathname === link.href ? " is-active" : ""}`} onClick={() => setMobileOpen(false)}>
              {link.icon}
              <span className="sidebar-link-label">{link.label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-account">
            <span className="sidebar-avatar">{username.slice(0, 1).toUpperCase()}</span>
            <span className="sidebar-account-name">{username}</span>
          </div>
          <ThemeToggle />
          <UserMenu />
        </div>
      </aside>
      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        {mobileLinks.map((link) => (
          <Link key={link.href} href={link.href} className={`mobile-bottom-nav-link${pathname === link.href ? " is-active" : ""}`} aria-current={pathname === link.href ? "page" : undefined}>
            {link.icon}
            <span>{link.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
