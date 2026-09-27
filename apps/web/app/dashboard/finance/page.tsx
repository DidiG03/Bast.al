"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { apiFetch, transactionLabel, type FinancialReport, type MeResponse, type PendingApproval } from "../../../lib/api";

export default function FinancePage() {
  const { getToken } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [report, setReport] = useState<FinancialReport | null>(null);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to load financial report"); }
  }

  // Load the initial report once; filters are submitted explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load().catch(() => undefined); }, []);

  async function decide(id: string, approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      await apiFetch(`/users/balance/transactions/${id}/approve`, token, { method: "POST", body: JSON.stringify({ approve }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval update failed");
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    if (!report) return;
    const rows = [["Recipient", "Role", "Total delegated", "Total reclaimed", "Net"], ...report.recipients.map((row) => [row.username, row.role, row.totalDelegated.toFixed(2), row.totalReclaimed.toFixed(2), row.net.toFixed(2)])];
    const url = URL.createObjectURL(new Blob([rows.map((row) => row.join(",")).join("\n")], { type: "text/csv" }));
    const link = document.createElement("a"); link.href = url; link.download = "financial-report.csv"; link.click(); URL.revokeObjectURL(url);
  }

  return <div className="stack">
    <div className="page-title-row"><div><h1 style={{ margin: 0 }}>Financial reporting</h1><p className="muted">Credit delegated to and reclaimed from your direct reports by date range. Net-revenue and commission reporting arrive once betting is live.</p></div></div>
    {canApprove ? <section className="card stack">
      <div className="tree-header"><h2 style={{ margin: 0 }}>Waiting for your approval</h2><span className="muted">{pending.length} pending</span></div>
      {pending.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing to approve. Delegations over $10,000 from your team land here.</p> : <div className="report-list">
        {pending.map((entry) => <div className="report-list-row" key={entry.id}>
          <div><strong>{transactionLabel(entry.type)} of ${entry.amount.toFixed(2)}</strong><span className="muted">{entry.actor?.username ?? "Unknown"} → {entry.toUser.username} · {entry.reason}</span><Link href={`/dashboard/finance/transaction/${entry.id}`}>View details</Link></div>
          <div className="row"><button type="button" className="secondary" onClick={() => decide(entry.id, true)} disabled={busy}>Approve</button><button type="button" className="danger-button" onClick={() => decide(entry.id, false)} disabled={busy}>Reject</button></div>
        </div>)}
      </div>}
    </section> : null}
    <form className="card row" onSubmit={(event) => { event.preventDefault(); load().catch(() => undefined); }}>
      <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <button type="submit">Apply</button><button type="button" className="secondary" onClick={exportCsv}>Export CSV</button>
    </form>
    {error ? <p className="error-text">{error}</p> : null}
    <section className="card report-list">{report?.recipients.length ? report.recipients.map((row) => <div className="report-list-row" key={row.userId}><div><strong>{row.username}</strong><span className="muted">{row.role} · ${row.totalDelegated.toFixed(2)} delegated · ${row.totalReclaimed.toFixed(2)} reclaimed</span></div><strong>${row.net.toFixed(2)}</strong></div>) : <p className="muted">No delegations in this period.</p>}</section>
  </div>;
}
