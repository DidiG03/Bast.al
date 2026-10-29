"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatMoney } from "../../../lib/format";
import { useRealtime } from "../../../components/realtime-provider";
import { apiFetch, transactionLabel, type BalanceEntry, type FinancialReport, type MeResponse, type PendingApproval, type PeriodResults, type UserRow } from "../../../lib/api";
import { LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { useToast } from "../../../components/toaster";
import { useI18n } from "../../../components/i18n-provider";
import { msg } from "../../../lib/i18n/core";
import { HelpTip } from "../../../components/help-tip";
import { NamedIcon } from "../../../components/icons";
import { endOfDateInput, fromDateInput, noticeWhen, startOfDay, startOfMonth, startOfWeek } from "../../../lib/time";

const ROLE_NAMES: Record<string, string> = { SUPER_ADMIN: msg("Super Admin"), OWNER: msg("Owner"), MANAGER: msg("Manager"), PLAYER: msg("Player") };

type Period = "today" | "week" | "month" | "all" | "custom";
type Kind = "transfers" | "given" | "taken" | "corrections" | "bets" | "casino" | "all";
type Status = "" | "APPROVED" | "PENDING" | "REJECTED";
type By = "" | "me" | "others";
type View = "moves" | "people";

const PERIODS: Array<[Period, string]> = [
  ["today", msg("Today")],
  ["week", msg("This week")],
  ["month", msg("This month")],
  ["all", msg("All time")],
  ["custom", msg("Custom")],
];

const KINDS: Array<[Kind, string]> = [
  ["transfers", msg("All transfers")],
  ["given", msg("Credit given")],
  ["taken", msg("Taken back")],
  ["corrections", msg("Corrections")],
  ["bets", msg("Bets")],
  ["casino", msg("Casino")],
  ["all", msg("Everything")],
];

/** The plain name of each kind of money move, as the list shows it. */
const MOVE_NAMES: Record<BalanceEntry["type"], string> = {
  DELEGATION: msg("Credit given"),
  RECLAIM: msg("Taken back"),
  ADJUSTMENT: msg("Correction"),
  BET_STAKE: msg("Bet placed"),
  BET_SETTLEMENT: msg("Bet settled"),
  CASINO: msg("Casino"),
};

const STATUS_NAMES: Record<string, string> = { APPROVED: msg("Done"), PENDING: msg("Waiting for approval"), REJECTED: msg("Rejected") };

type Person = { id: string; username: string; role: UserRow["role"] };

type Movement = {
  id: string;
  type: BalanceEntry["type"];
  status: "APPROVED" | "PENDING" | "REJECTED";
  amount: number;
  reason: string;
  createdAt: string;
  approvedAt: string | null;
  betId: string | null;
  fromUser: Person | null;
  toUser: Person;
  actor: Person | null;
  approvedBy: { id: string; username: string } | null;
};

type MoneyView = {
  page: number;
  limit: number;
  total: number;
  pages: number;
  summary: {
    given: number;
    givenCount: number;
    takenBack: number;
    takenBackCount: number;
    net: number;
    received: number;
    takenFromYou: number;
    corrections: number;
    pendingCount: number;
    pendingAmount: number;
    rejectedCount: number;
    /** Credit passed on further down the team: already counted in `given`. */
    withinTeam: number;
    withinTeamCount: number;
    /** Settled sports and casino results in the period, counted as on Overview. */
    results: PeriodResults;
    yourBalance: number | null;
    teamBalance: number;
    teamAccounts: number;
    /** With one person picked: credit to them and from them, kept apart. */
    person: { given: number; givenCount: number; takenBack: number; takenBackCount: number; gaveTheirTeam: number; tookBackFromTheirTeam: number } | null;
  };
  items: Movement[];
  /** Players' top-up requests still waiting: no credit has reached them since they asked. */
  requests?: Array<{ id: string; playerId: string; username: string; balance: number; amount: number | null; createdAt: string }>;
};

type Filters = { period: Period; from: string; to: string; person: string; kind: Kind; status: Status; by: By; search: string };

const DEFAULTS: Filters = { period: "week", from: "", to: "", person: "", kind: "transfers", status: "", by: "", search: "" };
const PAGE_SIZE = 50;

/** [from, to] of a period on Albanian time; {} for all time; null for custom dates not picked yet. */
function periodRange(filters: Filters): { from?: string; to?: string } | null {
  const now = new Date();
  if (filters.period === "all") return {};
  if (filters.period === "today") return { from: startOfDay(now).toISOString() };
  if (filters.period === "week") return { from: startOfWeek(now).toISOString() };
  if (filters.period === "month") return { from: startOfMonth(now).toISOString() };
  const from = filters.from ? fromDateInput(filters.from) : null;
  const to = filters.to ? endOfDateInput(filters.to) : null;
  if (!from && !to) return null;
  return { ...(from ? { from: from.toISOString() } : {}), ...(to ? { to: to.toISOString() } : {}) };
}

function moneyQuery(filters: Filters, page: number, limit = PAGE_SIZE): URLSearchParams {
  const params = new URLSearchParams({ kind: filters.kind, page: String(page), limit: String(limit) });
  const range = periodRange(filters) ?? {};
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  if (filters.person) params.set("person", filters.person);
  if (filters.status) params.set("status", filters.status);
  if (filters.by) params.set("by", filters.by);
  if (filters.search.trim()) params.set("search", filters.search.trim());
  return params;
}

/** The filters as they are in the address, so a link (or a refresh) opens the same view. */
function readFilters(): { filters: Filters; view: View } {
  const params = new URLSearchParams(window.location.search);
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = params.get(key) as T | null;
    return value !== null && allowed.includes(value) ? value : fallback;
  };
  return {
    filters: {
      period: pick("period", PERIODS.map(([value]) => value), DEFAULTS.period),
      from: params.get("from") ?? "",
      to: params.get("to") ?? "",
      person: params.get("person") ?? "",
      kind: pick("kind", KINDS.map(([value]) => value), DEFAULTS.kind),
      status: pick<Status>("status", ["", "APPROVED", "PENDING", "REJECTED"], ""),
      by: pick<By>("by", ["", "me", "others"], ""),
      search: params.get("q") ?? "",
    },
    view: pick<View>("view", ["moves", "people"], "moves"),
  };
}

function writeFilters(filters: Filters, view: View) {
  const params = new URLSearchParams();
  if (filters.period !== DEFAULTS.period) params.set("period", filters.period);
  if (filters.period === "custom" && filters.from) params.set("from", filters.from);
  if (filters.period === "custom" && filters.to) params.set("to", filters.to);
  if (filters.person) params.set("person", filters.person);
  if (filters.kind !== DEFAULTS.kind) params.set("kind", filters.kind);
  if (filters.status) params.set("status", filters.status);
  if (filters.by) params.set("by", filters.by);
  if (filters.search.trim()) params.set("q", filters.search.trim());
  if (view !== "moves") params.set("view", view);
  const query = params.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
}

/**
 * The Money page: what waits for approval, the period's totals, and every
 * money move in your part of the team, filtered by period, person, kind,
 * status, who made it and name.
 */
export default function FinancePage() {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t, ts, tn, date } = i18n;
  const toast = useToast();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [people, setPeople] = useState<UserRow[]>([]);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [view, setView] = useState<View>("moves");
  const [page, setPage] = useState(1);
  const [money, setMoney] = useState<MoneyView | null>(null);
  const [report, setReport] = useState<FinancialReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [failed, setFailed] = useState(false);
  // Only the newest request's answer is shown, whatever order the answers arrive in.
  const request = useRef(0);

  const canApprove = me?.role === "SUPER_ADMIN" || me?.role === "OWNER";
  const isAdmin = me?.role === "SUPER_ADMIN";
  const range = periodRange(filters);

  async function loadBase() {
    const token = await getToken();
    if (!token) return;
    const profile = await apiFetch<MeResponse>("/users/me", token);
    setMe(profile);
    const [list, waiting] = await Promise.all([
      apiFetch<UserRow[]>("/users", token).catch(() => [] as UserRow[]),
      profile.role === "SUPER_ADMIN" || profile.role === "OWNER" ? apiFetch<PendingApproval[]>("/users/balance/pending", token) : Promise.resolve([] as PendingApproval[]),
    ]);
    setPeople(list.filter((person) => person.id !== profile.id && person.role !== "SUPER_ADMIN"));
    setPending(waiting);
  }

  async function loadMoney(current: Filters, currentPage: number, currentView: View) {
    const span = periodRange(current);
    // Custom dates not picked yet: nothing to ask for.
    if (!span) return;
    const id = ++request.current;
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const params = new URLSearchParams();
      if (span.from) params.set("from", span.from);
      if (span.to) params.set("to", span.to);
      const [next, byPerson] = await Promise.all([
        apiFetch<MoneyView>(`/users/money?${moneyQuery(current, currentPage)}`, token),
        currentView === "people" ? apiFetch<FinancialReport>(`/users/financial-report?${params}`, token) : Promise.resolve(null),
      ]);
      if (id !== request.current) return;
      setMoney(next);
      if (byPerson) setReport(byPerson);
    } catch (err) {
      if (id !== request.current) return;
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Unable to load financial report"));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }

  // The first load: who you are, your team, what waits for you, and the filters in the address.
  useEffect(() => {
    const initial = readFilters();
    setFilters(initial.filters);
    setView(initial.view);
    setReady(true);
    loadBase().catch((err: Error) => {
      setFailed(true);
      toast.error(err.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any change of filter, page or view reloads the list; typing a name waits a moment first.
  useEffect(() => {
    if (!ready) return;
    writeFilters(filters, view);
    const timer = window.setTimeout(() => void loadMoney(filters, page, view), filters.search ? 300 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, filters, page, view]);

  // New approval requests arrive as notifications; approvals and transfers move balances.
  useRealtime((event) => {
    if (event.type === "balance.changed" || event.type === "notification.created" || event.type === "resync") {
      loadBase().catch(() => undefined);
      void loadMoney(filters, page, view);
    }
  });

  function change(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  }

  async function decide(id: string, approve: boolean) {
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      await apiFetch(`/users/balance/transactions/${id}/approve`, token, { method: "POST", body: JSON.stringify({ approve }) });
      await Promise.all([loadBase(), loadMoney(filters, page, view)]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Approval update failed"));
    } finally {
      setBusy(false);
    }
  }

  /** Every move matching the filters (not just this page), as a spreadsheet file. */
  async function exportCsv() {
    setExporting(true);
    try {
      const token = await getToken();
      if (!token) return;
      const rows: Movement[] = [];
      for (let next = 1; next <= 50; next += 1) {
        const chunk = await apiFetch<MoneyView>(`/users/money?${moneyQuery(filters, next, 100)}`, token);
        rows.push(...chunk.items);
        if (next >= chunk.pages) break;
      }
      const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
      const lines = [
        [t("Date"), t("What"), t("From"), t("To"), t("Made by"), t("Status"), t("Amount"), t("Note")],
        ...rows.map((row) => [
          new Date(row.createdAt).toISOString(),
          t(MOVE_NAMES[row.type]),
          row.fromUser?.username ?? "",
          row.toUser.username,
          row.actor?.username ?? t("System"),
          t(STATUS_NAMES[row.status] ?? row.status),
          row.amount.toFixed(2),
          ts(row.reason),
        ]),
      ];
      const url = URL.createObjectURL(new Blob([lines.map((line) => line.map(cell).join(",")).join("\n")], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "money.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Export failed"));
    } finally {
      setExporting(false);
    }
  }

  const peopleByRole = useMemo(() => {
    const order: UserRow["role"][] = ["OWNER", "MANAGER", "PLAYER"];
    return order
      .map((role) => [role, people.filter((person) => person.role === role).sort((a, b) => a.username.localeCompare(b.username))] as const)
      .filter(([, list]) => list.length > 0);
  }, [people]);

  const filtered = filters.person !== "" || filters.kind !== DEFAULTS.kind || filters.status !== "" || filters.by !== "" || filters.search.trim() !== "";
  const chosenPerson = people.find((person) => person.id === filters.person);
  // Names open the person's page, for the people with one (Super Admin manages from Users).
  const personLink = (person: Person) =>
    isAdmin || person.id === me?.id || person.role === "SUPER_ADMIN" ? person.username : <Link className="row-name-link" href={`/dashboard/people/${person.id}`}>{person.username}</Link>;
  const when = (value: string) => date(value, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  if (!me || (!money && range !== null)) return failed ? null : <PageLoading label="Loading financial report" />;
  const summary = money?.summary;

  return (
    <div className="stack money-page">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Money")}</h1>
          <p className="muted report-subtitle">{t("Every credit you and your team gave and took back, with filters to find any one of them.")}</p>
        </div>
      </div>

      {canApprove && pending.length > 0 ? (
        <section className="card stack money-pending">
          <div className="tree-header">
            <h2 style={{ margin: 0 }}>{t("Waiting for your approval")}<HelpTip text="Big money transfers from your team that need your OK before the money moves. Approve sends it; Reject cancels it and no money moves." /></h2>
            <span className="muted">{t("{count} pending", { count: pending.length })}</span>
          </div>
          <div className="report-list">
            {pending.map((entry) => (
              <div className="report-list-row approval-row" key={entry.id}>
                <div>
                  <strong>{t("{type} of {amount}", { type: t(transactionLabel(entry.type)), amount: formatMoney(entry.amount) })}</strong>
                  <span className="muted">{entry.actor?.username ?? t("Unknown")} → {entry.toUser.username} · {ts(entry.reason)} · {when(entry.createdAt)}</span>
                  <Link className="row-detail-link" href={`/dashboard/finance/transaction/${entry.id}`}>{t("View details")}</Link>
                </div>
                <div className="row approval-actions">
                  <button type="button" onClick={() => decide(entry.id, true)} disabled={busy}>{t("Approve")}</button>
                  <button type="button" className="danger-button" onClick={() => decide(entry.id, false)} disabled={busy}>{t("Reject")}</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="card stack money-filters" aria-label={t("Filters")}>
        <div className="money-filter-top">
          <nav className="tabs-nav money-period" aria-label={t("Period")}>
            {PERIODS.map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={`tab-button${filters.period === value ? " is-active" : ""}`}
                aria-pressed={filters.period === value}
                onClick={() => change({ period: value })}
              >
                {t(label)}
              </button>
            ))}
          </nav>
          {filters.period === "custom" ? (
            <div className="money-dates">
              <label>{t("From")}<input type="date" value={filters.from} onChange={(event) => change({ from: event.target.value })} /></label>
              <label>{t("To")}<input type="date" value={filters.to} onChange={(event) => change({ to: event.target.value })} /></label>
            </div>
          ) : null}
        </div>
        <div className="money-filter-grid">
          <label>
            {t("Person")}
            <select value={filters.person} onChange={(event) => change({ person: event.target.value })}>
              <option value="">{t("Everyone")}</option>
              {peopleByRole.map(([role, list]) => (
                <optgroup key={role} label={t(ROLE_NAMES[role] ?? role)}>
                  {list.map((person) => <option key={person.id} value={person.id}>{person.username}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label>
            {t("What")}
            <select value={filters.kind} onChange={(event) => change({ kind: event.target.value as Kind })}>
              {KINDS.filter(([value]) => value !== "corrections" || isAdmin).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
          </label>
          <label>
            {t("Status")}
            <select value={filters.status} onChange={(event) => change({ status: event.target.value as Status })}>
              <option value="">{t("Any status")}</option>
              <option value="APPROVED">{t("Done")}</option>
              <option value="PENDING">{t("Waiting for approval")}</option>
              <option value="REJECTED">{t("Rejected")}</option>
            </select>
          </label>
          <label>
            {t("Made by")}
            <select value={filters.by} onChange={(event) => change({ by: event.target.value as By })}>
              <option value="">{t("Anyone")}</option>
              <option value="me">{t("You")}</option>
              <option value="others">{isAdmin ? t("Owners and their teams") : t("Your team")}</option>
            </select>
          </label>
          <label>
            {t("Name")}
            <input type="search" value={filters.search} placeholder={t("Search a name")} onChange={(event) => change({ search: event.target.value })} />
          </label>
        </div>
        {filtered ? (
          <div className="money-filter-note">
            <span className="muted">{chosenPerson ? t("Showing money to and from {name}.", { name: chosenPerson.username }) : t("Filters are on.")}</span>
            <button type="button" className="text-button" onClick={() => change({ person: "", kind: DEFAULTS.kind, status: "", by: "", search: "" })}>{t("Clear filters")}</button>
          </div>
        ) : null}
      </section>

      {range === null || !money || !summary ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>{t("Pick a start and end date")}</p></div>
      ) : (
        <>
          <div className="report-grid money-stats">
            {chosenPerson && summary.person ? (
              <>
                <div className="card report-stat">
                  <span className="muted">{t("Given to {name}", { name: chosenPerson.username })}<HelpTip text="The credit sent to this person in this period." /></span>
                  <strong>{formatMoney(summary.person.given)}</strong>
                  <span className="muted">{tn(summary.person.givenCount, "{count} transfer", "{count} transfers")}</span>
                </div>
                <div className="card report-stat">
                  <span className="muted">{t("Taken back from {name}", { name: chosenPerson.username })}<HelpTip text="The credit pulled back from this person in this period." /></span>
                  <strong>{formatMoney(summary.person.takenBack)}</strong>
                  <span className="muted">{tn(summary.person.takenBackCount, "{count} transfer", "{count} transfers")}</span>
                </div>
                <div className="card report-stat">
                  <span className="muted">{t("Net to {name}", { name: chosenPerson.username })}<HelpTip text="Credit given to this person minus credit taken back from them in this period." /></span>
                  <strong className={summary.person.given - summary.person.takenBack < 0 ? "ledger-negative" : undefined}>{formatMoney(summary.person.given - summary.person.takenBack)}</strong>
                  <span className="muted">{t("What's out with your team: credit given minus taken back")}</span>
                </div>
              </>
            ) : (
              <>
                <div className="card report-stat">
                  <span className="muted">{t("Credit given")}<HelpTip text="All the credit sent down to the people in your team in this period, with the filters above." /></span>
                  <strong>{formatMoney(summary.given)}</strong>
                  <span className="muted">{tn(summary.givenCount, "{count} transfer", "{count} transfers")}</span>
                </div>
                <div className="card report-stat">
                  <span className="muted">{t("Taken back")}<HelpTip text="All the credit pulled back from people in your team in this period, with the filters above." /></span>
                  <strong>{formatMoney(summary.takenBack)}</strong>
                  <span className="muted">{tn(summary.takenBackCount, "{count} transfer", "{count} transfers")}</span>
                </div>
                <div className="card report-stat">
                  <span className="muted">{t("Net given out")}<HelpTip text="Credit you gave minus credit you took back: how much more is out with your team than at the start of the period. Credit your team passes further down isn't counted again." /></span>
                  <strong className={summary.net < 0 ? "ledger-negative" : undefined}>{formatMoney(summary.net)}</strong>
                  <span className="muted">{t("Given minus taken back")}</span>
                </div>
              </>
            )}
            <div className="card report-stat">
              <span className="muted">{chosenPerson ? t("{name} holds now", { name: chosenPerson.username }) : t("Your team holds now")}<HelpTip text="The money in their balances right now, whatever period is picked." /></span>
              <strong>{formatMoney(summary.teamBalance)}</strong>
              <span className="muted">
                {chosenPerson ? t(ROLE_NAMES[chosenPerson.role] ?? chosenPerson.role) : tn(summary.teamAccounts, "{count} account", "{count} accounts")}
                {summary.yourBalance !== null && !chosenPerson ? ` · ${t("You hold {amount}", { amount: formatMoney(summary.yourBalance) })}` : ""}
              </span>
            </div>
          </div>

          <dl className="card money-strip">
            {chosenPerson && summary.person && chosenPerson.role !== "PLAYER" ? (
              <>
                <div>
                  <dt className="muted">{t("They gave their team")}</dt>
                  <dd>{formatMoney(summary.person.gaveTheirTeam)}</dd>
                </div>
                <div>
                  <dt className="muted">{t("They took back from their team")}</dt>
                  <dd>{formatMoney(summary.person.tookBackFromTheirTeam)}</dd>
                </div>
              </>
            ) : null}
            {summary.yourBalance !== null && !chosenPerson ? (
              <div>
                <dt className="muted">{t("Received from above")}</dt>
                <dd>{formatMoney(summary.received)}</dd>
              </div>
            ) : null}
            {summary.yourBalance !== null && !chosenPerson && summary.takenFromYou > 0 ? (
              <div>
                <dt className="muted">{t("Taken back from you")}</dt>
                <dd>{formatMoney(summary.takenFromYou)}</dd>
              </div>
            ) : null}
            <div>
              <dt className="muted">{t("Waiting for approval")}</dt>
              <dd>{summary.pendingCount > 0 ? `${formatMoney(summary.pendingAmount)} · ${summary.pendingCount}` : "–"}</dd>
            </div>
            {!chosenPerson && summary.withinTeam > 0 ? (
              <div>
                <dt className="muted">
                  {t("Passed on within the team")}
                  <HelpTip text="Credit your team moved further down (an Owner to a Manager, a Manager to a Player). It's credit already counted in Credit given, so it isn't added again." />
                </dt>
                <dd>{`${formatMoney(summary.withinTeam)} · ${summary.withinTeamCount}`}</dd>
              </div>
            ) : null}
            <div>
              <dt className="muted">{t("Sports staked")}<HelpTip text="Stakes on bets settled in this period, the same figures as on Overview and Commissions." /></dt>
              <dd>{`${formatMoney(summary.results.sports.staked)} · ${tn(summary.results.sports.bets, "{count} bet", "{count} bets")}`}</dd>
            </div>
            <div>
              <dt className="muted">{t("Sports paid out")}</dt>
              <dd>{formatMoney(summary.results.sports.paidOut)}</dd>
            </div>
            <div>
              <dt className="muted">{t("Sports profit")}</dt>
              <dd className={summary.results.sports.net < 0 ? "ledger-negative" : undefined}>{formatMoney(summary.results.sports.net)}</dd>
            </div>
            <div>
              <dt className="muted">{t("Casino staked")}</dt>
              <dd>{`${formatMoney(summary.results.casino.staked)} · ${tn(summary.results.casino.rounds, "{count} round", "{count} rounds")}`}</dd>
            </div>
            <div>
              <dt className="muted">{t("Casino profit")}</dt>
              <dd className={summary.results.casino.net < 0 ? "ledger-negative" : undefined}>{formatMoney(summary.results.casino.net)}</dd>
            </div>
            {isAdmin ? (
              <div>
                <dt className="muted">{t("Corrections")}</dt>
                <dd>{formatMoney(summary.corrections)}</dd>
              </div>
            ) : null}
          </dl>

          {money.requests && money.requests.length > 0 ? (
            <section className="card stack top-up-requests" aria-labelledby="top-up-requests-title">
              <h2 id="top-up-requests-title" style={{ margin: 0 }}>
                {t("Top-up requests")}
                <HelpTip text="Players who asked for more money and haven't been sent any since. Give credit opens their Credit form with what they asked for filled in." />
              </h2>
              <ul className="top-up-request-list">
                {money.requests.map((request) => (
                  <li key={request.id}>
                    <span>
                      <strong>{request.username}</strong>{" "}
                      {request.amount !== null ? t("asked for {amount}", { amount: formatMoney(request.amount) }) : t("asked for a top-up")}
                      <span className="muted">
                        {" · "}
                        {t("Balance {amount}", { amount: formatMoney(request.balance) })}
                        {" · "}
                        {noticeWhen(request.createdAt, new Date(), i18n)}
                      </span>
                    </span>
                    <span className="status-pill is-pending">{t("Waiting")}</span>
                    {isAdmin ? null : (
                      <Link className="button-link" href={`/dashboard/people/${request.playerId}?credit=1${request.amount !== null ? `&amount=${request.amount}` : ""}`}>
                        {t("Give credit")}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="money-view-bar">
            <nav className="tabs-nav" aria-label={t("View")}>
              <button type="button" className={`tab-button${view === "moves" ? " is-active" : ""}`} aria-pressed={view === "moves"} onClick={() => setView("moves")}>
                {t("Every move")}
              </button>
              <button type="button" className={`tab-button${view === "people" ? " is-active" : ""}`} aria-pressed={view === "people"} onClick={() => setView("people")}>
                {t("By person")}
              </button>
            </nav>
            {loading ? <LoadingSpinner label="Loading" size="small" /> : null}
            <button type="button" className="secondary is-small money-export" onClick={() => void exportCsv()} disabled={exporting || money.total === 0}>
              {exporting ? <LoadingSpinner label="Exporting" size="small" /> : <NamedIcon name="download" className="button-icon" />}
              {t("Export CSV")}
            </button>
          </div>

          {view === "moves" ? (
            <section className="card stack">
              <div className="tree-header">
                <h2 style={{ margin: 0 }}>{t("Every move")}<HelpTip text="Each money move on its own line: who sent it, who got it, who did it and when. Tap Receipt to see the full record. Use the filters above to narrow it down." /></h2>
                <span className="muted">{tn(money.total, "{count} move", "{count} moves")}</span>
              </div>
              {money.items.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>{t("Nothing matches these filters.")}</p>
              ) : (
                <div className="report-list money-list">
                  {money.items.map((row) => {
                    // Transfers are shown as they went, from → to; bets, casino and corrections with their sign.
                    const signed = row.type === "DELEGATION" || row.type === "RECLAIM" ? null : row.amount;
                    // Super Admin holds no balance, so credit it gives has no sender on record: it came from whoever did it.
                    const sender = row.fromUser ?? (row.type === "DELEGATION" ? row.actor : null);
                    return (
                      <div className={`report-list-row money-move${row.status !== "APPROVED" ? " is-muted" : ""}`} key={row.id}>
                        <div>
                          <span className="money-move-title">
                            <span className={`money-kind is-${row.type.toLowerCase()}`}>{t(MOVE_NAMES[row.type])}</span>
                            {row.status !== "APPROVED" ? <span className={`status-pill money-status is-${row.status.toLowerCase()}`}>{t(STATUS_NAMES[row.status])}</span> : null}
                          </span>
                          <strong className="money-route">
                            {sender ? <>{personLink(sender)} <span aria-hidden="true">→</span> </> : null}
                            {personLink(row.toUser)}
                          </strong>
                          <span className="muted">
                            {ts(row.reason)}
                            {row.actor && row.actor.id !== sender?.id && row.actor.id !== row.toUser.id ? ` · ${t("by {name}", { name: row.actor.username })}` : ""}
                            {row.approvedBy ? ` · ${t("approved by {name}", { name: row.approvedBy.username })}` : ""}
                          </span>
                        </div>
                        <div className="money-move-side">
                          <strong className={signed === null ? undefined : signed < 0 ? "ledger-negative" : "ledger-positive"}>
                            {signed !== null && signed > 0 ? "+" : ""}
                            {formatMoney(signed ?? row.amount)}
                          </strong>
                          <time className="muted" dateTime={row.createdAt}>{when(row.createdAt)}</time>
                          <Link className="row-detail-link" href={`/dashboard/finance/transaction/${row.id}`}>{t("Receipt")}</Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {money.pages > 1 ? (
                <div className="money-pager">
                  <span className="muted">
                    {t("{start}–{end} of {total}", { start: (money.page - 1) * money.limit + 1, end: Math.min(money.page * money.limit, money.total), total: money.total })}
                  </span>
                  <div className="row">
                    <button type="button" className="secondary is-small" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t("Previous")}</button>
                    <button type="button" className="secondary is-small" disabled={page >= money.pages || loading} onClick={() => setPage((value) => value + 1)}>{t("Next")}</button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : (
            <section className="card stack">
              <div className="tree-header">
                <h2 style={{ margin: 0 }}>{t("Money you sent and took back")}<HelpTip text="One line for each person right under you: how much money you sent them, how much you took back, and the difference on the right. Tap a line to see each of their moves." /></h2>
                <span className="muted">{report ? tn(report.recipients.length, "{count} person", "{count} people") : ""}</span>
              </div>
              {!report ? (
                <LoadingSpinner label="Loading" size="small" />
              ) : report.recipients.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>{t("No delegations in this period.")}</p>
              ) : (
                <div className="report-list">
                  {[...report.recipients].sort((a, b) => b.net - a.net).map((row) => (
                    <button
                      type="button"
                      className="report-list-row money-person-row"
                      key={row.userId}
                      onClick={() => {
                        change({ person: row.userId, kind: "transfers" });
                        setView("moves");
                      }}
                    >
                      <div>
                        <strong>{row.username}</strong>
                        <span className="muted">
                          {t(ROLE_NAMES[row.role] ?? row.role)} · {t("{amount} delegated", { amount: formatMoney(row.totalDelegated) })} · {t("{amount} reclaimed", { amount: formatMoney(row.totalReclaimed) })}
                        </span>
                      </div>
                      <span className="money-person-net">
                        <strong>{formatMoney(row.net)}</strong>
                        <NamedIcon name="chevron" className="money-person-chevron" />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
