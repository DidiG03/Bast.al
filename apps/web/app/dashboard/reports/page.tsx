import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { apiFetch, type MeResponse, type UserReport } from "../../../lib/api";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default async function ReportsPage() {
  const { getToken, userId } = await auth();
  if (!userId) redirect("/sign-in");
  const token = await getToken();
  if (!token) redirect("/sign-in");

  const me = await apiFetch<MeResponse>("/users/me", token);
  if (me.role !== "SUPER_ADMIN") redirect("/dashboard");
  const report = await apiFetch<UserReport>("/users/report", token);

  const cards = [
    ["Total users", report.totals.users],
    ["Owners", report.totals.owners],
    ["Managers", report.totals.managers],
    ["Players", report.totals.players],
    ["Active", report.totals.active],
    ["Suspended", report.totals.suspended],
  ] as const;

  return (
    <div className="stack reports-page">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>Reports</h1>
          <p className="muted report-subtitle">A complete overview of owners, managers, players, and account activity.</p>
        </div>
        <span className="muted report-updated">Updated {dateLabel(report.generatedAt)}</span>
      </div>

      <div className="report-grid">
        {cards.map(([label, value]) => <div className="card report-stat" key={label}><span className="muted">{label}</span><strong>{value}</strong></div>)}
        <div className="card report-stat"><span className="muted">Manager balances</span><strong>${report.totals.managerBalances.toFixed(2)}</strong></div>
      </div>

      <div className="reports-columns">
        <section className="card stack">
          <div className="tree-header"><h2>Manager accounts</h2><span className="muted">{report.managers.length} managers</span></div>
          {report.managers.length === 0 ? <p className="muted">No manager accounts yet.</p> : (
            <div className="report-list">
              {report.managers.map((manager) => (
                <div className="report-list-row" key={manager.id}>
                  <div><strong>{manager.username}</strong><span className="muted">{manager.players} players · {manager.status}</span></div>
                  <strong>${manager.balance.toFixed(2)}</strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card stack">
          <div className="tree-header"><h2>Recent activity</h2><span className="muted">Latest 25</span></div>
          {report.recentAudit.length === 0 ? <p className="muted">No activity recorded yet.</p> : (
            <div className="report-list">
              {report.recentAudit.map((entry) => (
                <div className="report-list-row report-activity-row" key={entry.id}>
                  <div><strong>{entry.action.replaceAll(".", " ")}</strong><span className="muted">{entry.actor?.username ?? "System"}{entry.target ? ` → ${entry.target.username}` : ""}</span></div>
                  <time className="muted" dateTime={entry.createdAt}>{dateLabel(entry.createdAt)}</time>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
