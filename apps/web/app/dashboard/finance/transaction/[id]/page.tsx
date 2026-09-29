"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { formatMoney } from "../../../../../lib/format";
import { apiFetch, transactionLabel, type TransactionDetails } from "../../../../../lib/api";
import { useI18n } from "../../../../../components/i18n-provider";
import { msg } from "../../../../../lib/i18n/core";

const STATUS: Record<string, string> = { APPROVED: msg("Approved"), PENDING: msg("Pending"), REJECTED: msg("Rejected") };

export default function TransactionDetailsPage({ params }: { params: { id: string } }) {
  const { getToken } = useAuth();
  const { t, ts, date } = useI18n();
  const [entry, setEntry] = useState<TransactionDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getToken().then((token) => token
      ? apiFetch<TransactionDetails>(`/users/balance/transactions/${params.id}`, token).then(setEntry)
      : Promise.reject(new Error(t("You're not signed in"))))
      .catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken, params.id]);

  if (error) return <p className="error-text">{error}</p>;
  if (!entry) return <p className="muted">{t("Loading transaction…")}</p>;

  return (
    <div className="stack">
      <div className="page-title-row"><div><h1 style={{ margin: 0 }}>{t("Transaction receipt")}</h1><p className="muted report-subtitle">{t("Full audit-ready transaction details.")}</p></div><Link href="/dashboard/finance" className="back-link">{t("Back to Finance")}</Link></div>
      <section className="card stack receipt-card">
        <div className="receipt-title"><strong>{t(transactionLabel(entry.type))}</strong><span className={`status-pill ${entry.status === "APPROVED" ? "is-active" : ""}`}>{t(STATUS[entry.status ?? "APPROVED"] ?? entry.status ?? "APPROVED")}</span></div>
        <div className="receipt-amount">{formatMoney(Math.abs(entry.amount))}</div>
        <dl className="receipt-details">
          <div><dt>{t("Transaction ID")}</dt><dd>{entry.id}</dd></div>
          <div><dt>{t("From")}</dt><dd>{entry.fromUser?.username ?? t("Platform")}</dd></div>
          <div><dt>{t("To")}</dt><dd>{entry.toUser.username}</dd></div>
          <div><dt>{t("Reason")}</dt><dd>{ts(entry.reason)}</dd></div>
          <div><dt>{t("Created")}</dt><dd>{date(entry.createdAt, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
          <div><dt>{t("Recorded by")}</dt><dd>{entry.actor?.username ?? t("System")}</dd></div>
          <div><dt>{t("Approved by")}</dt><dd>{entry.approvedBy?.username ?? (entry.status === "PENDING" ? t("Awaiting approval") : "—")}</dd></div>
        </dl>
        <button type="button" className="receipt-print" onClick={() => window.print()}>{t("Print receipt")}</button>
      </section>
    </div>
  );
}
