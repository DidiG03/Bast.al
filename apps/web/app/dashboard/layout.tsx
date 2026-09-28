import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardSidebar } from "../../components/dashboard-sidebar";
import { NotificationCenter } from "../../components/notification-center";
import { RealtimeProvider, RealtimeRefresh } from "../../components/realtime-provider";
import { UserMenu } from "../../components/user-menu";
import { apiFetch, type MeResponse } from "../../lib/api";

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

  const canManageUsers = me.role === "SUPER_ADMIN" || me.role === "OWNER" || me.role === "MANAGER";
  const canViewReports = me.role === "SUPER_ADMIN" || me.role === "OWNER" || me.role === "MANAGER";
  const canViewFinancial = me.role === "SUPER_ADMIN" || me.role === "OWNER" || me.role === "MANAGER";
  const initialCollapsed = cookies().get("bastal-sidebar")?.value === "collapsed";

  return (
    <RealtimeProvider>
      <RealtimeRefresh />
      <div className="dashboard-shell">
        <DashboardSidebar canManageUsers={canManageUsers} canViewReports={canViewReports} canViewFinancial={canViewFinancial} isPlayer={me.role === "PLAYER"} isSuperAdmin={me.role === "SUPER_ADMIN"} username={me.username} initialCollapsed={initialCollapsed} />
        <main className="dashboard-content">
          <header className="dashboard-topbar">
            <Link href="/dashboard" className="topbar-brand">
              <span className="sidebar-logo" aria-hidden="true">B</span>
              <span>Bast.al</span>
            </Link>
            <NotificationCenter />
          </header>
          {children}
        </main>
      </div>
    </RealtimeProvider>
  );
}
