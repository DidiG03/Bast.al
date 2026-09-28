import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardSidebar } from "../../components/dashboard-sidebar";
import { DashboardTrail } from "../../components/dashboard-trail";
import { NotificationCenter } from "../../components/notification-center";
import { RealtimeProvider, RealtimeRefresh } from "../../components/realtime-provider";
import { ThemeToggle } from "../../components/theme-toggle";
import { UserMenu } from "../../components/user-menu";
import { apiFetch, type MeResponse } from "../../lib/api";
import { formatMoney } from "../../lib/format";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { getToken, userId } = await auth();
  if (!userId) redirect("/sign-in");

  const token = await getToken();
  if (!token) redirect("/sign-in");

  let me: MeResponse;
  try {
    me = await apiFetch<MeResponse>("/users/me", token);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const apiDown =
      /fetch failed|ECONNREFUSED|Failed to fetch|network/i.test(message) ||
      message.includes("Request failed");

    return (
      <main className="stack">
        <div className="nav">
          <span className="brand">Bast.al</span>
          <UserMenu />
        </div>
        <div className="card stack">
          <h1 style={{ margin: 0 }}>
            {apiDown ? "API unavailable" : "Account not provisioned"}
          </h1>
          <p className="muted">
            {apiDown
              ? "Could not reach the Nest API on port 4000. Restart npm run dev and refresh."
              : "Your Clerk session is valid, but there is no local user row yet. Accounts are created from inside the app: Players by their Manager or Owner, Managers by their Owner, and Owners by Super Admin. Ask whoever runs your team to create yours."}
          </p>
        </div>
      </main>
    );
  }

  if (!me.mfaSatisfied) {
    redirect("/security/2fa");
  }

  const isPlayer = me.role === "PLAYER";
  const initialCollapsed = cookies().get("bastal-sidebar")?.value === "collapsed";

  return (
    <RealtimeProvider>
      <RealtimeRefresh />
      <div className={`dashboard-shell${isPlayer ? " role-player" : " role-admin"}`}>
        <DashboardSidebar role={me.role} username={me.username} initialCollapsed={initialCollapsed} />
        <main className="dashboard-content">
          <header className="dashboard-topbar">
            <Link href="/dashboard" className="topbar-brand">
              <span className="sidebar-logo" aria-hidden="true">B</span>
              <span>Bast.al</span>
            </Link>
            {isPlayer ? null : <DashboardTrail />}
            {isPlayer ? (
              <Link href="/dashboard" className="player-balance-chip" title="Your balance, delegated by your Manager or Owner">
                <span className="player-balance-chip-icon" aria-hidden="true">$</span>
                {formatMoney(Number(me.balance))}
              </Link>
            ) : null}
            <div className="topbar-actions">
              {isPlayer ? null : <ThemeToggle />}
              <NotificationCenter />
            </div>
          </header>
          {children}
        </main>
      </div>
    </RealtimeProvider>
  );
}
