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
import { LanguageToggle } from "../../components/language-toggle";
import { getT } from "../../lib/i18n/server";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { t } = getT();
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
            {t(apiDown ? "The server isn't responding" : "Your account isn't set up yet")}
          </h1>
          <p className="muted">
            {apiDown
              ? t("Bast.al can't reach its server right now. Wait a moment and refresh the page.")
              : t("You're signed in, but there's no Bast.al account for you yet. Accounts are created from inside the app: Players by their Manager or Owner, Managers by their Owner, and Owners by Super Admin. Ask whoever runs your team to create yours.")}
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
              <Link href="/dashboard/money" className="player-balance-chip" title={t("Your balance, given to you by your Manager or Owner")}>
                <span className="player-balance-chip-icon" aria-hidden="true">$</span>
                {formatMoney(Number(me.balance))}
              </Link>
            ) : null}
            <div className="topbar-actions">
              <LanguageToggle />
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
