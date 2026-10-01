"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { HelpTip } from "../../../components/help-tip";
import { useI18n } from "../../../components/i18n-provider";
import { LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { useRealtime } from "../../../components/realtime-provider";
import { useToast } from "../../../components/toaster";
import { TopUpRequestButton } from "../../../components/top-up-request";
import { apiFetch, type BalanceEntry, type MeResponse } from "../../../lib/api";
import { formatMoney } from "../../../lib/format";

const PAGE = 30;
type Filter = "all" | "topups" | "bets" | "casino";

const DAY: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" };
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** A Player's money, move by move: top-ups from their Manager or Owner, bets placed, and what came back. */
export default function MoneyPage() {
  const { getToken } = useAuth();
  const router = useRouter();
  const { t, ts, date } = useI18n();
  const toast = useToast();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [entries, setEntries] = useState<BalanceEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const profile = await apiFetch<MeResponse>("/users/me", token);
    if (profile.role !== "PLAYER") {
      router.replace("/dashboard");
      return;
    }
    const page = await apiFetch<BalanceEntry[]>(`/users/${profile.id}/balance/ledger?limit=${PAGE}`, token);
    setMe(profile);
    setEntries(page);
    setHasMore(page.length === PAGE);
  }, [getToken, router]);

  useEffect(() => {
    load().catch((err) => toast.error(err instanceof Error ? err.message : t("Couldn't load your money history")));
  }, [load, toast, t]);

  useRealtime((event) => {
    if (event.type === "balance.changed" || event.type === "resync") void load().catch(() => undefined);
  });

  async function loadMore() {
    const last = entries?.[entries.length - 1];
    const token = await getToken();
    if (!last || !me || !token) return;
    setLoadingMore(true);
    try {
      const page = await apiFetch<BalanceEntry[]>(`/users/${me.id}/balance/ledger?limit=${PAGE}&before=${encodeURIComponent(last.createdAt)}`, token);
      setEntries((list) => [...(list ?? []), ...page]);
      setHasMore(page.length === PAGE);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Couldn't load more"));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!me || !entries) return <PageLoading label="Loading your money" />;

  const isBet = (entry: BalanceEntry) => entry.type === "BET_STAKE" || entry.type === "BET_SETTLEMENT";
  const shown = entries.filter((entry) =>
    filter === "all" ? true : filter === "bets" ? isBet(entry) : filter === "casino" ? entry.type === "CASINO" : !isBet(entry) && entry.type !== "CASINO",
  );
  const days: Array<[string, BalanceEntry[]]> = [];
  for (const entry of shown) {
    const label = date(entry.createdAt, DAY);
    const last = days[days.length - 1];
    if (last && last[0] === label) last[1].push(entry);
    else days.push([label, [entry]]);
  }

  return (
    <div className="stack money-page">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("My money")}</h1>
          <p className="muted report-subtitle">{t("Every time money came into your balance or went out of it.")}</p>
        </div>
      </div>

      <section className="player-hero money-hero">
        <span className="player-hero-label">
          {t("Your balance")}
          <HelpTip text="The money you can bet with. Your Manager or Owner adds it. When you win, your winnings come back here." />
        </span>
        <strong className="player-hero-balance">{formatMoney(Number(me.balance))}</strong>
        {me.parent ? <TopUpRequestButton className="secondary money-topup" /> : null}
      </section>

      <section className="card stack">
        <div className="tree-header">
          <span>
            {t("History")}
            <HelpTip text="Green is money that came in: top-ups from your Manager or Owner, and wins. Red is money that went out: your bets, and money your Manager or Owner took back. The newest is at the top." />
          </span>
        </div>
        <div className="bet-chips" role="group" aria-label={t("Show")}>
          {(
            [
              ["all", t("All")],
              ["topups", t("Top-ups")],
              ["bets", t("Bets")],
              ...(entries.some((entry) => entry.type === "CASINO") ? [["casino", t("Casino")] as [Filter, string]] : []),
            ] as Array<[Filter, string]>
          ).map(([key, label]) => (
            <button key={key} type="button" className={`bet-chip${filter === key ? " is-active" : ""}`} onClick={() => setFilter(key)} aria-pressed={filter === key}>
              {label}
            </button>
          ))}
        </div>

        {days.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {entries.length === 0 ? t("Nothing yet. When your Manager or Owner gives you money, it shows here.") : t("Nothing of this kind yet.")}
          </p>
        ) : (
          days.map(([label, list]) => (
            <div key={label} className="money-day">
              <h3 className="money-day-label">{label}</h3>
              <ul className="money-list">
                {list.map((entry) => {
                  const { icon, title } = describe(entry, t);
                  const pending = entry.status === "PENDING";
                  const rejected = entry.status === "REJECTED";
                  return (
                    <li key={entry.id} className={`money-row${pending || rejected ? " is-waiting" : ""}`}>
                      <span className={`money-icon${entry.amount >= 0 ? " is-in" : " is-out"}`} aria-hidden="true">
                        {icon}
                      </span>
                      <span className="money-row-text">
                        <strong>{title}</strong>
                        <span className="muted">{ts(entry.reason)}</span>
                        <span className="muted">
                          {date(entry.createdAt, TIME)}
                          {pending ? ` · ${t("Waiting for approval")}` : rejected ? ` · ${t("Rejected, no money moved")}` : ""}
                        </span>
                      </span>
                      <strong className={`money-amount${entry.amount >= 0 ? " is-in" : " is-out"}`}>
                        {entry.amount >= 0 ? "+" : "−"}
                        {formatMoney(Math.abs(entry.amount))}
                      </strong>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}

        {hasMore ? (
          <button type="button" className="secondary" onClick={loadMore} disabled={loadingMore} style={{ justifySelf: "center" }}>
            {loadingMore ? <LoadingSpinner label="Loading more" size="small" /> : t("Show more")}
          </button>
        ) : null}
      </section>
    </div>
  );
}

function describe(entry: BalanceEntry, t: (text: string, vars?: Record<string, string | number>) => string): { icon: string; title: string } {
  const who = entry.counterparty ?? "";
  switch (entry.type) {
    case "DELEGATION":
      return entry.amount >= 0 ? { icon: "💵", title: t("Top-up from {name}", { name: who }) } : { icon: "💵", title: t("Sent to {name}", { name: who }) };
    case "RECLAIM":
      return entry.amount >= 0 ? { icon: "↩", title: t("Returned by {name}", { name: who }) } : { icon: "↩", title: t("Taken back by {name}", { name: who }) };
    case "BET_STAKE":
      return entry.amount >= 0 ? { icon: "↺", title: t("Bet money returned") } : { icon: "🎟", title: t("Bet placed") };
    case "BET_SETTLEMENT":
      return entry.amount >= 0 ? { icon: "🏆", title: t("Money from a bet") } : { icon: "↺", title: t("Bet corrected") };
    case "CASINO":
      return { icon: "🎰", title: t("Casino") };
    default:
      return { icon: "✎", title: t("Correction") };
  }
}
