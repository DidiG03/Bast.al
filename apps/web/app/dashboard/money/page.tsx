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
type Direction = "all" | "in" | "out";
type Range = "all" | "today" | "week" | "month30" | "thisMonth" | "custom";
type Summary = { count: number; in: number; out: number; net: number };
/** How long the search waits after the last key before it asks. */
const SEARCH_WAIT_MS = 350;

/** "2026-10-31": a day on Albanian time, the calendar the history and its days follow; `back` days earlier. */
function tiraneDay(back = 0): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Tirane", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [year, month, day] = parts.split("-").map(Number);
  const at = new Date(Date.UTC(year, month - 1, day - back));
  return at.toISOString().slice(0, 10);
}

/** The From and To days of a quick range. */
function rangeDays(range: Range): { from: string; to: string } {
  if (range === "today") return { from: tiraneDay(), to: tiraneDay() };
  if (range === "week") return { from: tiraneDay(6), to: tiraneDay() };
  if (range === "month30") return { from: tiraneDay(29), to: tiraneDay() };
  if (range === "thisMonth") return { from: `${tiraneDay().slice(0, 8)}01`, to: tiraneDay() };
  return { from: "", to: "" };
}
/** A day's casino line: `{game}_{playerId}_{day}`. Scratch's buy and result lines are already one card each. */
const CASINO_DAY = /^(casino|book|blackjack|roulette|mines|penalty|plinko|dice|keno|coinflip|scratch)_.+_\d{4}-\d{2}-\d{2}$/;

type CasinoRound = { id: string; at: string; stake: number; win: number; label: string };

const DAY: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long", year: "numeric" };
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** A Player's money, move by move: top-ups from their Manager or Owner, bets placed, and what came back. */
export default function MoneyPage() {
  const { getToken } = useAuth();
  const router = useRouter();
  const { t, tn, ts, date } = useI18n();
  const toast = useToast();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [entries, setEntries] = useState<BalanceEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [direction, setDirection] = useState<Direction>("all");
  const [range, setRange] = useState<Range>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  /** The search as asked: it follows the box a moment after the last key. */
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filtering, setFiltering] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), SEARCH_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [search]);
  const filtered = filter !== "all" || direction !== "all" || Boolean(from) || Boolean(to) || Boolean(query);
  /** The filters as the API takes them, on the history and on its summary. */
  const params = useCallback(() => {
    const out = new URLSearchParams();
    if (filter !== "all") out.set("kind", filter);
    if (direction !== "all") out.set("direction", direction);
    if (from) out.set("from", from);
    if (to) out.set("to", to);
    if (query) out.set("q", query);
    return out;
  }, [filter, direction, from, to, query]);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const profile = await apiFetch<MeResponse>("/users/me", token);
    if (profile.role !== "PLAYER") {
      router.replace("/dashboard");
      return;
    }
    const query = params();
    const [page, totals] = await Promise.all([
      apiFetch<BalanceEntry[]>(`/users/${profile.id}/balance/ledger?limit=${PAGE}${query.size > 0 ? `&${query}` : ""}`, token),
      query.size > 0 ? apiFetch<Summary>(`/users/${profile.id}/balance/ledger/summary?${query}`, token) : Promise.resolve(null),
    ]);
    setMe(profile);
    setEntries(page);
    setSummary(totals);
    setHasMore(page.length === PAGE);
  }, [getToken, router, params]);

  useEffect(() => {
    setFiltering(true);
    load()
      .catch((err) => toast.error(err instanceof Error ? err.message : t("Couldn't load your money history")))
      .finally(() => setFiltering(false));
  }, [load, toast, t]);

  function chooseRange(next: Range) {
    setRange(next);
    if (next === "custom") return;
    const days = rangeDays(next);
    setFrom(days.from);
    setTo(days.to);
  }

  function clearFilters() {
    setFilter("all");
    setDirection("all");
    setRange("all");
    setFrom("");
    setTo("");
    setSearch("");
    setQuery("");
  }

  useRealtime((event) => {
    if (event.type === "balance.changed" || event.type === "resync") void load().catch(() => undefined);
  });

  async function loadMore() {
    const last = entries?.[entries.length - 1];
    const token = await getToken();
    if (!last || !me || !token) return;
    setLoadingMore(true);
    try {
      const query = params();
      query.set("before", last.createdAt);
      const page = await apiFetch<BalanceEntry[]>(`/users/${me.id}/balance/ledger?limit=${PAGE}&${query}`, token);
      setEntries((list) => [...(list ?? []), ...page]);
      setHasMore(page.length === PAGE);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Couldn't load more"));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!me || !entries) return <PageLoading label="Loading your money" />;

  // The API filters (so "Show more" stays inside the filter); every line it sends is shown.
  const shown = entries;
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
        {me.parent ? <TopUpRequestButton className="money-topup" /> : null}
      </section>

      <section className="card stack">
        <div className="tree-header">
          <span>
            {t("History")}
            <HelpTip text="Green is money that came in: top-ups from your Manager or Owner, and wins. Stakes on your bets are in plain text. Red is money lost or taken back: a day's casino loss, or money your Manager or Owner took back. The newest is at the top." />
          </span>
        </div>
        <div className="bet-chips" role="group" aria-label={t("Show")}>
          {(
            [
              ["all", t("All")],
              ["topups", t("Top-ups")],
              ["bets", t("Bets")],
              ["casino", t("Casino")],
            ] as Array<[Filter, string]>
          ).map(([key, label]) => (
            <button key={key} type="button" className={`bet-chip${filter === key ? " is-active" : ""}`} onClick={() => setFilter(key)} aria-pressed={filter === key}>
              {label}
            </button>
          ))}
        </div>

        {/* Search and days: words from a line (a match, a game, a reference, who sent it) or an amount, over any days. */}
        <div className="money-filters">
          <label className="money-search">
            <span className="sr-only">{t("Search your history")}</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("Search: a match, a game, a reference or an amount")}
              maxLength={100}
            />
          </label>
          <div className="bet-chips money-ranges" role="group" aria-label={t("Days")}>
            {(
              [
                ["all", t("All time")],
                ["today", t("Today")],
                ["week", t("Last 7 days")],
                ["month30", t("Last 30 days")],
                ["thisMonth", t("This month")],
              ] as Array<[Range, string]>
            ).map(([key, label]) => (
              <button key={key} type="button" className={`bet-chip${range === key ? " is-active" : ""}`} onClick={() => chooseRange(key)} aria-pressed={range === key}>
                {label}
              </button>
            ))}
          </div>
          <div className="money-dates">
            <select className="money-direction" value={direction} onChange={(event) => setDirection(event.target.value as Direction)} aria-label={t("Money in or out")}>
              <option value="all">{t("In and out")}</option>
              <option value="in">{t("Money in")}</option>
              <option value="out">{t("Money out")}</option>
            </select>
            <label>
              <span className="muted">{t("From")}</span>
              <input
                type="date"
                value={from}
                max={to || tiraneDay()}
                onChange={(event) => {
                  setRange("custom");
                  setFrom(event.target.value);
                }}
              />
            </label>
            <label>
              <span className="muted">{t("To")}</span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                max={tiraneDay()}
                onChange={(event) => {
                  setRange("custom");
                  setTo(event.target.value);
                }}
              />
            </label>
          </div>
        </div>

        {filtered ? (
          <div className="money-summary" role="status">
            {summary ? (
              <span>
                {tn(summary.count, "{count} line", "{count} lines")}
                {" · "}
                {t("In")} <strong className="money-amount is-in">+{formatMoney(summary.in)}</strong>
                {" · "}
                {t("Out")} <strong className="money-amount is-out">−{formatMoney(summary.out)}</strong>
                {" · "}
                {t("Net")} <strong className={`money-amount${summary.net >= 0 ? " is-in" : " is-out"}`}>{summary.net >= 0 ? "+" : "−"}{formatMoney(Math.abs(summary.net))}</strong>
              </span>
            ) : (
              <span className="muted">{t("Counting…")}</span>
            )}
            <button type="button" className="text-button" onClick={clearFilters}>
              {t("Clear filters")}
            </button>
          </div>
        ) : null}
        {filtering ? <LoadingSpinner label="Searching" size="small" /> : null}

        {days.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {filtered ? t("Nothing matches these filters.") : t("Nothing yet. When your Manager or Owner gives you money, it shows here.")}
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
                  const tone = entry.amount >= 0 ? " is-in" : entry.type === "BET_STAKE" ? " is-stake" : " is-out";
                  return (
                    <li key={entry.id} className={`money-row${pending || rejected ? " is-waiting" : ""}`}>
                      <time className="money-time" dateTime={entry.createdAt}>
                        {date(entry.createdAt, TIME)}
                      </time>
                      <span className={`money-icon${tone}`} aria-hidden="true">
                        {icon}
                      </span>
                      <span className="money-row-text">
                        <strong>{title}</strong>
                        <span className="muted">{ts(ledgerText(entry.reason))}{entry.betId ? ` · ${t("Ref {id}", { id: entry.betId.slice(-8) })}` : ""}</span>
                        {pending || rejected ? <span className="muted">{pending ? t("Waiting for approval") : t("Rejected, no money moved")}</span> : null}
                      </span>
                      <strong className={`money-amount${pending || rejected ? " is-no-effect" : tone}`}>
                        {pending || rejected ? (
                          <s>
                            {entry.amount >= 0 ? "+" : "−"}
                            {formatMoney(Math.abs(entry.amount))}
                          </s>
                        ) : (
                          <>
                            {entry.amount >= 0 ? "+" : "−"}
                            {formatMoney(Math.abs(entry.amount))}
                          </>
                        )}
                      </strong>
                      {entry.type === "CASINO" && CASINO_DAY.test(entry.id) ? <CasinoRounds userId={me.id} lineId={entry.id} lineAmount={entry.amount} /> : null}
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

/** The stake and the result of every round inside one casino day's line. */
function CasinoRounds({ userId, lineId, lineAmount }: { userId: string; lineId: string; lineAmount: number }) {
  const { getToken } = useAuth();
  const { t, ts, date } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [rounds, setRounds] = useState<CasinoRound[] | null>(null);
  const [more, setMore] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || rounds) return;
    try {
      const token = await getToken();
      if (!token) return;
      const page = await apiFetch<{ rounds: CasinoRound[]; more: boolean }>(`/users/${userId}/balance/ledger/rounds?line=${encodeURIComponent(lineId)}`, token);
      setRounds(page.rounds);
      setMore(page.more);
    } catch (err) {
      toast.error(err instanceof Error ? ts(err.message) : t("Couldn't load these rounds"));
      setOpen(false);
    }
  }

  const net = (rounds ?? []).reduce((sum, round) => sum + round.win - round.stake, 0);
  const inPlay = rounds !== null && Math.round((lineAmount - net) * 100) !== 0;

  return (
    <>
      <button type="button" className="money-rounds-toggle" aria-expanded={open} onClick={() => void toggle()}>
        {open ? t("Hide the rounds") : t("Each round")}
      </button>
      {open && rounds ? (
        <ul className="money-rounds">
          {more ? <li className="muted">{t("Showing the latest {count} rounds.", { count: rounds.length })}</li> : null}
          {inPlay ? <li className="muted">{t("A round still in play is included in the total.")}</li> : null}
          {rounds.map((round) => (
            <li key={round.id} className="money-round">
              <span>
                <time dateTime={round.at}>{date(round.at, TIME)}</time> {t(round.label)}
              </span>
              <span className="money-amount is-stake">
                <small>{t("Stake")}</small> −{formatMoney(round.stake)}
              </span>
              <span className={`money-amount${round.win > 0 ? " is-in" : ""}`}>
                <small>{t("Result")}</small> +{formatMoney(round.win)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** A ledger line in today's words: voids recorded before they were called that said "Bet refunded: …". */
function ledgerText(reason: string): string {
  const old = /^Bet refunded: (.*)$/.exec(reason);
  return old ? `Bet voided: ${old[1]}. Stake returned` : reason;
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
      // A void (refunded or winnings taken back) and a void undone have their own names; older voids said "refunded".
      if (/^Bet (voided|refunded):/.test(entry.reason)) return { icon: "⊘", title: t("Bet voided") };
      if (/^Bet reinstated:/.test(entry.reason)) return { icon: "↺", title: entry.amount < 0 ? t("Bet reinstated, stake taken back") : t("Bet reinstated") };
      return entry.amount >= 0 ? { icon: "🏆", title: t("Money from a bet") } : { icon: "↺", title: t("Bet corrected") };
    case "CASINO":
      return { icon: "🎰", title: t(entry.reason.split(":")[0] || "Casino") };
    default:
      return { icon: "✎", title: t("Correction") };
  }
}
