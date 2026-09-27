"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { apiFetch, type TransactionDetails } from "../../../../../lib/api";

export default function TransactionDetailsPage({ params }: { params: { id: string } }) {
  const { getToken } = useAuth();
  const [entry, setEntry] = useState<TransactionDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getToken().then((token) => token
      ? apiFetch<TransactionDetails>(`/users/balance/transactions/${params.id}`, token).then(setEntry)
      : Promise.reject(new Error("Not signed in")))
      .catch((err: Error) => setError(err.message));
  }, [getToken, params.id]);

  if (error) return <p className="error-text">{error}</p>;
  if (!entry) return <p className="muted">Loading transaction…</p>;

  return (
    <div className="stack">
      <div className="page-title-row"><div><h1 style={{ margin: 0 }}>Transaction receipt</h1><p className="muted">Full audit-ready transaction details.</p></div><Link href="/dashboard/finance">Back to Finance</Link></div>
      <section className="card stack receipt-card">
        <div className="receipt-title"><strong>{entry.type === "DELEGATION" ? "Delegation" : "Adjustment"}</strong><span className={`status-pill ${entry.status === "APPROVED" ? "is-active" : ""}`}>{entry.status ?? "APPROVED"}</span></div>
        <div className="receipt-amount">${Math.abs(entry.amount).toFixed(2)}</div>
        <dl className="receipt-details">
          <div><dt>Transaction ID</dt><dd>{entry.id}</dd></div>
          <div><dt>From</dt><dd>{entry.fromUser?.username ?? "Platform"}</dd></div>
          <div><dt>To</dt><dd>{entry.toUser.username}</dd></div>
          <div><dt>Reason</dt><dd>{entry.reason}</dd></div>
          <div><dt>Created</dt><dd>{new Date(entry.createdAt).toLocaleString()}</dd></div>
          <div><dt>Recorded by</dt><dd>{entry.actor?.username ?? "System"}</dd></div>
          <div><dt>Approved by</dt><dd>{entry.approvedBy?.username ?? (entry.status === "PENDING" ? "Awaiting approval" : "—")}</dd></div>
        </dl>
        <button type="button" onClick={() => window.print()}>Print receipt</button>
      </section>
    </div>
  );
}
