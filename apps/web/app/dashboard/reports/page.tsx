import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { apiFetch, type MeResponse, type UserReport } from "../../../lib/api";
import { formatMoney } from "../../../lib/format";
import { ReportsTabs } from "./reports-tabs";
import { AuditLog } from "./audit-log";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default async function ReportsPage() {
  const { getToken, userId } = await auth();
  if (!userId) redirect("/sign-in");
  const token = await getToken();
  if (!token) redirect("/sign-in");

  const me = await apiFetch<MeResponse>("/users/me", token);
  if (me.role !== "SUPER_ADMIN" && me.role !== "OWNER") redirect("/dashboard");
  const report = await apiFetch<UserReport>("/users/report", token);
  const isOwner = me.role === "OWNER";
  const accountNoun = report.accountRole === "OWNER" ? "owner" : "manager";

  const cards = [
    ["Total users", report.totals.users],
    ...(isOwner ? [] : [["Owners", report.totals.owners] as const]),
    ["Managers", report.totals.managers],
    ["Players", report.totals.players],
    ["Active", report.totals.active],
    ["Suspended", report.totals.suspended],
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
          <span className="muted">{isOwner ? "Balance held by your team" : "Total balance in circulation"}</span>
          <strong>{formatMoney(report.totals.totalBalance)}</strong>
        </div>
      </div>

      <div className="reports-columns">
        <section className="card stack">
          <div className="tree-header">
            <h2>{isOwner ? "Manager accounts" : "Owner accounts"}</h2>
            <span className="muted">{report.accounts.length} {accountNoun}s</span>
          </div>
          {report.accounts.length === 0 ? (
            <p className="muted">No {accountNoun} accounts yet.</p>
          ) : (
            <div className="report-list">
              {report.accounts.map((owner) => (
                <div className="report-list-row" key={owner.id}>
                  <div>
                    <strong>{owner.username}</strong>
                    <span className="muted">
                      {owner.directReports} direct reports · {owner.status} · {owner.commissionRate}% commission
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
            <h2>Recent activity</h2>
            <span className="muted">Latest 25</span>
          </div>
          {report.recentAudit.length === 0 ? (
            <p className="muted">No activity recorded yet.</p>
          ) : (
            <div className="report-list">
              {report.recentAudit.map((entry) => (
                <div
                  className="report-list-row report-activity-row"
                  key={entry.id}
                >
                  <div>
                    <strong>{entry.action.replaceAll(".", " ")}</strong>
                    <span className="muted">
                      {entry.actor?.username ?? "System"}
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
          <h1 style={{ margin: 0 }}>Reports</h1>
          <p className="muted report-subtitle">
            {isOwner
              ? "An overview of your team and its audit log."
              : "A complete overview of accounts and administrative audit logs."}
          </p>
        </div>
        <span className="muted report-updated">
          Updated {dateLabel(report.generatedAt)}
        </span>
      </div>

      <ReportsTabs overview={overviewContent} auditLog={<AuditLog />} />
    </div>
  );
}
