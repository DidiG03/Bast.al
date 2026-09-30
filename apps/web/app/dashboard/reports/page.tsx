import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { type MeResponse, type UserReport } from "../../../lib/api";
import { serverApiFetch } from "../../../lib/api-server";
import { formatMoney } from "../../../lib/format";
import { ReportsTabs } from "./reports-tabs";
import { AuditLog } from "./audit-log";
import { msg } from "../../../lib/i18n/core";
import { getT } from "../../../lib/i18n/server";
import { HelpTip } from "../../../components/help-tip";

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

  const me = await serverApiFetch<MeResponse>("/users/me", token);
  if (me.role === "PLAYER") redirect("/dashboard");
  const report = await serverApiFetch<UserReport>("/users/report", token);
  const isOwner = me.role === "OWNER";
  const isManager = me.role === "MANAGER";
  const accountCount =
    report.accountRole === "OWNER"
      ? tn(report.accounts.length, "{count} owner", "{count} owners")
      : report.accountRole === "MANAGER"
        ? tn(report.accounts.length, "{count} manager", "{count} managers")
        : tn(report.accounts.length, "{count} player", "{count} players");
  const noAccounts = report.accountRole === "OWNER" ? t("No Owner accounts yet.") : report.accountRole === "MANAGER" ? t("No Manager accounts yet.") : t("No Player accounts yet.");

  const cards: Array<{ label: string; value: number; help: string }> = [
    { label: t("Total users"), value: report.totals.users, help: "Every account you can see, of every kind, counted together." },
    ...(isOwner || isManager ? [] : [{ label: t("Owners"), value: report.totals.owners, help: "Owners run a team. Each Owner has Managers and Players under them." }]),
    ...(isManager ? [] : [{ label: t("Managers"), value: report.totals.managers, help: "Managers look after Players: they give them money and see how they bet." }]),
    { label: t("Players"), value: report.totals.players, help: "Players are the people who place bets." },
    { label: t("Active"), value: report.totals.active, help: "Accounts that can sign in and use the site right now." },
    { label: t("Suspended"), value: report.totals.suspended, help: "Blocked accounts. They can't sign in until someone above them reactivates them on the Users page." },
  ];

  const overviewContent = (
    <div className="stack">
      <div className="report-grid">
        {cards.map(({ label, value, help }) => (
          <div className="card report-stat" key={label}>
            <span className="muted">
              {label}
              <HelpTip text={help} />
            </span>
            <strong>{value}</strong>
          </div>
        ))}
        <div className="card report-stat">
          <span className="muted">
            {isManager ? t("Balance held by your players") : isOwner ? t("Balance held by your team") : t("Total balance in circulation")}
            <HelpTip text="All the money in these accounts' balances added together. It is money given out to them, not profit." />
          </span>
          <strong>{formatMoney(report.totals.totalBalance)}</strong>
        </div>
      </div>

      <div className="reports-columns">
        <section className="card stack">
          <div className="tree-header">
            <h2>
              {isManager ? t("Player accounts") : isOwner ? t("Manager accounts") : t("Owner accounts")}
              <HelpTip text="The accounts right under you, with their balance on the right. Tap a Player's name to see their bets and money." />
            </h2>
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
            <h2>
              {t("Recent activity")}
              <HelpTip text="The last 25 things done by you and the people under you: logins, money moves and changes. The Audit log tab has everything, with filters." />
            </h2>
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
