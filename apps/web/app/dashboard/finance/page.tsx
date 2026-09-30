"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { formatMoney } from "../../../lib/format";
import { useRealtime } from "../../../components/realtime-provider";
import { apiFetch, transactionLabel, type FinancialReport, type MeResponse, type PendingApproval } from "../../../lib/api";
import { PageLoading } from "../../../components/loading-spinner";
import { useToast } from "../../../components/toaster";
import { useI18n } from "../../../components/i18n-provider";
import { msg } from "../../../lib/i18n/core";
import { HelpTip } from "../../../components/help-tip";

const ROLE_NAMES: Record<string, string> = { SUPER_ADMIN: msg("Super Admin"), OWNER: msg("Owner"), MANAGER: msg("Manager"), PLAYER: msg("Player") };

export default function FinancePage() {
  const { getToken } = useAuth();
  const { t, ts } = useI18n();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [report, setReport] = useState<FinancialReport | null>(null);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const toast = useToast();

  const canApprove = me?.role === "SUPER_ADMIN" || me?.role === "OWNER";

  async function load() {
    const token = await getToken();
    if (!token) return;
    const params = new URLSearchParams();
    if (from) params.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) params.set("to", new Date(`${to}T23:59:59.999`).toISOString());
    try {
      const profile = await apiFetch<MeResponse>("/users/me", token);
      setMe(profile);
      setReport(await apiFetch<FinancialReport>(`/users/financial-report?${params}`, token));
      if (profile.role === "SUPER_ADMIN" || profile.role === "OWNER") {
        setPending(await apiFetch<PendingApproval[]>("/users/balance/pending", token));
      }
    } catch (err) {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Unable to load financial report"));
    }
  }

  // Load the initial report once; filters are submitted explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load().catch(() => undefined); }, []);

  // New approval requests arrive as notifications; approvals move balances.
  useRealtime((event) => {
    if (event.type === "balance.changed" || event.type === "notification.created" || event.type === "resync") load().catch(() => undefined);
  });

  async function decide(id: string, approve: boolean) {
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      await apiFetch(`/users/balance/transactions/${id}/approve`, token, { method: "POST", body: JSON.stringify({ approve }) });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Approval update failed"));
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    if (!report) return;
    const rows = [[t("Recipient"), t("Role"), t("Total delegated"), t("Total reclaimed"), t("Net")], ...report.recipients.map((row) => [row.username, t(ROLE_NAMES[row.role] ?? row.role), row.totalDelegated.toFixed(2), row.totalReclaimed.toFixed(2), row.net.toFixed(2)])];
    const url = URL.createObjectURL(new Blob([rows.map((row) => row.join(",")).join("\n")], { type: "text/csv" }));
    const link = document.createElement("a"); link.href = url; link.download = "financial-report.csv"; link.click(); URL.revokeObjectURL(url);
  }

  // Nothing shows until the report (and, for approvers, the waiting list) has loaded.
  if (!report) return failed ? null : <PageLoading label="Loading financial report" />;

  return <div className="stack">
    <div className="page-title-row"><div><h1 style={{ margin: 0 }}>{t("Financial reporting")}</h1><p className="muted report-subtitle">{t("Credit delegated to and reclaimed from your direct reports by date range. Team profit and commissions are on the Commissions page.")}</p></div></div>
    {canApprove ? <section className="card stack">
      <div className="tree-header"><h2 style={{ margin: 0 }}>{t("Waiting for your approval")}<HelpTip text="Big money transfers from your team that need your OK before the money moves. Approve sends it; Reject cancels it and no money moves." /></h2><span className="muted">{t("{count} pending", { count: pending.length })}</span></div>
      {pending.length === 0 ? <p className="muted" style={{ margin: 0 }}>{t("Nothing to approve. Delegations over $10,000 from your team land here.")}</p> : <div className="report-list">
        {pending.map((entry) => <div className="report-list-row approval-row" key={entry.id}>
          <div><strong>{t("{type} of {amount}", { type: t(transactionLabel(entry.type)), amount: formatMoney(entry.amount) })}</strong><span className="muted">{entry.actor?.username ?? t("Unknown")} → {entry.toUser.username} · {ts(entry.reason)}</span><Link href={`/dashboard/finance/transaction/${entry.id}`}>{t("View details")}</Link></div>
          <div className="row approval-actions"><button type="button" className="secondary" onClick={() => decide(entry.id, true)} disabled={busy}>{t("Approve")}</button><button type="button" className="danger-button" onClick={() => decide(entry.id, false)} disabled={busy}>{t("Reject")}</button></div>
        </div>)}
      </div>}
    </section> : null}
    <form className="card filter-bar" onSubmit={(event) => { event.preventDefault(); load().catch(() => undefined); }}>
      <label>{t("From")}<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>{t("To")}<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <div className="filter-bar-actions"><button type="submit">{t("Apply")}</button><button type="button" className="secondary" onClick={exportCsv}>{t("Export CSV")}</button></div>
    </form>
    <section className="card stack">
      <div className="tree-header"><h2 style={{ margin: 0 }}>{t("Money you sent and took back")}<HelpTip text="One line for each person right under you: how much money you sent them, how much you took back, and the difference on the right. Pick dates above and press Apply to change the period." /></h2></div>
      <div className="report-list">{report?.recipients.length ? report.recipients.map((row) => <div className="report-list-row" key={row.userId}><div><strong>{row.username}</strong><span className="muted">{t(ROLE_NAMES[row.role] ?? row.role)} · {t("{amount} delegated", { amount: formatMoney(row.totalDelegated) })} · {t("{amount} reclaimed", { amount: formatMoney(row.totalReclaimed) })}</span></div><strong>{formatMoney(row.net)}</strong></div>) : <p className="muted">{t("No delegations in this period.")}</p>}</div>
    </section>
  </div>;
}
