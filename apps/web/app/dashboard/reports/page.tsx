import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { apiFetch, type MeResponse, type UserReport } from "../../../lib/api";
import { formatMoney } from "../../../lib/format";
import { ReportsTabs } from "./reports-tabs";
import { AuditLog } from "./audit-log";
import { msg } from "../../../lib/i18n/core";
import { getT } from "../../../lib/i18n/server";

function dateLabel(value: string) {
  return getT().date(value, { dateStyle: "medium", timeStyle: "short" });
}

const STATUS_NAMES: Record<string, string> = { ACTIVE: msg("Active"), SUSPENDED: msg("Suspended") };

export default async function ReportsPage() {
  const { t, tn, ts } = getT();
  const { getToken, userId } = await auth();
  if (!userId) redirect("/sign-in");
  const token = await getToken();
  if (!token) redirect("/sign-in");

  const me = await apiFetch<MeResponse>("/users/me", token);
  if (me.role === "PLAYER") redirect("/dashboard");
  const report = await apiFetch<UserReport>("/users/report", token);
  const isOwner = me.role === "OWNER";
  const isManager = me.role === "MANAGER";
  const accountCount =
    report.accountRole === "OWNER"
      ? tn(report.accounts.length, "{count} owner", "{count} owners")
      : report.accountRole === "MANAGER"
        ? tn(report.accounts.length, "{count} manager", "{count} managers")
        : tn(report.accounts.length, "{count} player", "{count} players");
  const noAccounts = report.accountRole === "OWNER" ? t("No Owner accounts yet.") : report.accountRole === "MANAGER" ? t("No Manager accounts yet.") : t("No Player accounts yet.");

  const cards = [
    [t("Total users"), report.totals.users],
    ...(isOwner || isManager ? [] : [[t("Owners"), report.totals.owners] as const]),
    ...(isManager ? [] : [[t("Managers"), report.totals.managers] as const]),
    [t("Players"), report.totals.players],
    [t("Active"), report.totals.active],
    [t("Suspended"), report.totals.suspended],
  ] as const;

  const overviewContent = (
    <div className="stack">
      <div className="report-grid">
        {cards.map(([label, value]) => (
          <div className="card report-stat" key={label}>
            <span className="muted">{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
        <div className="card report-stat">
          <span className="muted">{isManager ? t("Balance held by your players") : isOwner ? t("Balance held by your team") : t("Total balance in circulation")}</span>
          <strong>{formatMoney(report.totals.totalBalance)}</strong>
        </div>
      </div>

      <div className="reports-columns">
        <section className="card stack">
          <div className="tree-header">
            <h2>{isManager ? t("Player accounts") : isOwner ? t("Manager accounts") : t("Owner accounts")}</h2>
            <span className="muted">{accountCount}</span>
          </div>
          {report.accounts.length === 0 ? (
            <p className="muted">{noAccounts}</p>
          ) : (
            <div className="report-list">
              {report.accounts.map((owner) => (
                <div className="report-list-row" key={owner.id}>
                  <div>
                    {isManager ? <Link href={`/dashboard/players/${owner.id}`}><strong>{owner.username}</strong></Link> : <strong>{owner.username}</strong>}
                    <span className="muted">
                      {isManager
                        ? `${t(STATUS_NAMES[owner.status] ?? owner.status)} · ${t("View activity")}`
                        : `${tn(owner.directReports, "{count} direct report", "{count} direct reports")} · ${t(STATUS_NAMES[owner.status] ?? owner.status)} · ${t("{rate}% commission", { rate: owner.commissionRate })}`}
                    </span>
                  </div>
                  <strong>{formatMoney(owner.balance)}</strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card stack">
          <div className="tree-header">
            <h2>{t("Recent activity")}</h2>
            <span className="muted">{t("Latest {count}", { count: 25 })}</span>
          </div>
          {report.recentAudit.length === 0 ? (
            <p className="muted">{t("No activity recorded yet.")}</p>
          ) : (
            <div className="report-list">
              {report.recentAudit.map((entry) => (
                <div
                  className="report-list-row report-activity-row"
                  key={entry.id}
                >
                  <div>
                    <strong>{ts(entry.action.replaceAll(".", " "))}</strong>
                    <span className="muted">
                      {entry.actor?.username ?? t("System")}
                      {entry.target ? ` → ${entry.target.username}` : ""}
                    </span>
                  </div>
                  <time className="muted" dateTime={entry.createdAt}>
                    {dateLabel(entry.createdAt)}
                  </time>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );

  return (
    <div className="stack reports-page">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Reports")}</h1>
          <p className="muted report-subtitle">
            {isManager
              ? t("An overview of your players and their audit log.")
              : isOwner
              ? t("An overview of your team and its audit log.")
              : t("A complete overview of accounts and administrative audit logs.")}
          </p>
        </div>
        <span className="muted report-updated">
          {t("Updated {when}", { when: dateLabel(report.generatedAt) })}
        </span>
      </div>

      <ReportsTabs overview={overviewContent} auditLog={<AuditLog />} />
    </div>
  );
}
