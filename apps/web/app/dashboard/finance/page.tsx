"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { apiFetch, type FinancialReport } from "../../../lib/api";

export default function FinancePage() {
  const { getToken } = useAuth();
  const [report, setReport] = useState<FinancialReport | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const token = await getToken();
    if (!token) return;
    const params = new URLSearchParams();
    if (from) params.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) params.set("to", new Date(`${to}T23:59:59.999`).toISOString());
    try { setReport(await apiFetch<FinancialReport>(`/users/financial-report?${params}`, token)); } catch (err) { setError(err instanceof Error ? err.message : "Unable to load financial report"); }
  }

  // Load the initial report once; filters are submitted explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load().catch(() => undefined); }, []);

  function exportCsv() {
    if (!report) return;
    const rows = [["Manager", "Credits", "Debits", "Net"], ...report.managers.map((row) => [row.username, row.credits.toFixed(2), row.debits.toFixed(2), row.net.toFixed(2)])];
    const url = URL.createObjectURL(new Blob([rows.map((row) => row.join(",")).join("\n")], { type: "text/csv" }));
    const link = document.createElement("a"); link.href = url; link.download = "financial-report.csv"; link.click(); URL.revokeObjectURL(url);
  }

  return <div className="stack">
    <div className="page-title-row"><div><h1 style={{ margin: 0 }}>Financial reporting</h1><p className="muted">Owner and Manager transaction totals by date range.</p></div></div>
    <form className="card row" onSubmit={(event) => { event.preventDefault(); load().catch(() => undefined); }}>
      <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <button type="submit">Apply</button><button type="button" className="secondary" onClick={exportCsv}>Export CSV</button>
    </form>
    {error ? <p className="error-text">{error}</p> : null}
    <section className="card report-list">{report?.managers.length ? report.managers.map((row) => <div className="report-list-row" key={row.managerId}><div><strong>{row.username}</strong><span className="muted">Credits ${row.credits.toFixed(2)} · Debits ${row.debits.toFixed(2)}</span></div><strong>${row.net.toFixed(2)}</strong></div>) : <p className="muted">No approved transactions in this period.</p>}</section>
  </div>;
}
