"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import { ManagerHistory, ManagerView, SuperAdminView, TeamView, teamPerformanceRows } from "../../../components/commission-views";
import {
  apiFetch,
  type CommissionHistory,
  type CommissionPayout,
  type ManagerCommissions,
  type MeResponse,
  type PayoutStanding,
  type SuperAdminCommissions,
  type TeamCommissions,
} from "../../../lib/api";
import { formatMoney } from "../../../lib/format";
import { addDays, fromDateInput, startOfMonth, startOfWeek, TIME_ZONE } from "../../../lib/time";
import { useIdempotencyKey } from "../../../lib/use-idempotency-key";
import { useI18n, type I18n } from "../../../components/i18n-provider";
import { LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { useToast } from "../../../components/toaster";
import { msg } from "../../../lib/i18n/core";
import { HelpTip } from "../../../components/help-tip";

type Range = "this-week" | "last-week" | "this-month" | "custom";

const RANGES: Array<[Range, string]> = [
  ["this-week", msg("This week")],
  ["last-week", msg("Last week")],
  ["this-month", msg("This month")],
  ["custom", msg("Custom")],
];

/** [from, to) on Albanian time, the same for everyone wherever they are. Weeks run Monday to Sunday. */
function rangeDates(range: Range, customFrom: string, customTo: string): { from: Date; to: Date } | null {
  const now = new Date();
  if (range === "this-week") return { from: startOfWeek(now), to: now };
  if (range === "last-week") {
    const to = startOfWeek(now);
    return { from: addDays(to, -7), to };
  }
  if (range === "this-month") return { from: startOfMonth(now), to: now };
  const from = fromDateInput(customFrom);
  const lastDay = fromDateInput(customTo);
  if (!from || !lastDay) return null;
  return { from, to: addDays(lastDay, 1) };
}

/** "1 Sep to 7 Sep", in English: it goes into the ledger, which the API keeps in English. */
function ledgerPeriod(from: string, to: string): string {
  const format = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: TIME_ZONE });
  // `to` is exclusive; show the last day actually included.
  const last = new Date(new Date(to).getTime() - 1);
  return `${format.format(new Date(from))} to ${format.format(last)}`;
}

/** The same period in the reader's language, for the page. */
function periodLabel({ t, date }: I18n, from: string, to: string): string {
  const last = new Date(new Date(to).getTime() - 1);
  return t("{from} to {to}", { from: date(from, { day: "numeric", month: "short" }), to: date(last, { day: "numeric", month: "short" }) });
}

function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function CommissionsPage() {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t } = i18n;
  const [me, setMe] = useState<MeResponse | null>(null);
  const [range, setRange] = useState<Range>("this-week");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [owners, setOwners] = useState<SuperAdminCommissions | null>(null);
  const [team, setTeam] = useState<TeamCommissions | null>(null);
  const [mine, setMine] = useState<ManagerCommissions | null>(null);
  const [history, setHistory] = useState<CommissionHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const toast = useToast();
  const [collectingId, setCollectingId] = useState<string | null>(null);
  // Commission already paid for periods overlapping the one on screen, stored
  // on the server, so a period can't be paid twice even after a reload.
  const [payouts, setPayouts] = useState<CommissionPayout[]>([]);
  const idempotency = useIdempotencyKey();

  const load = useCallback(async () => {
    const dates = rangeDates(range, customFrom, customTo);
    if (!dates) return;
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const profile = me ?? (await apiFetch<MeResponse>("/users/me", token));
      setMe(profile);
      const params = new URLSearchParams({ from: dates.from.toISOString(), to: dates.to.toISOString() });
      if (profile.role === "MANAGER") {
        const [period, weeks] = await Promise.all([
          apiFetch<ManagerCommissions>(`/commissions/mine?${params}`, token),
          apiFetch<CommissionHistory>("/commissions/mine/history?weeks=8", token),
        ]);
        setMine(period);
        setHistory(weeks);
      } else if (profile.role === "OWNER") {
        setTeam(await apiFetch<TeamCommissions>(`/commissions/team?${params}`, token));
      } else if (profile.role === "SUPER_ADMIN") {
        if (ownerId) {
          params.set("ownerId", ownerId);
          setTeam(await apiFetch<TeamCommissions>(`/commissions/team?${params}`, token));
        } else {
          setOwners(await apiFetch<SuperAdminCommissions>(`/commissions/owners?${params}`, token));
        }
      }
      if (profile.role === "SUPER_ADMIN" || profile.role === "OWNER") {
        const period = new URLSearchParams({ from: dates.from.toISOString(), to: dates.to.toISOString() });
        setPayouts(await apiFetch<CommissionPayout[]>(`/commissions/payouts?${period}`, token));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Unable to load commissions"));
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [range, customFrom, customTo, ownerId, me, getToken, toast, t]);

  useEffect(() => {
    load().catch(() => undefined);
    // Reload when the period or the opened Owner changes, not when `me` first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, customFrom, customTo, ownerId]);

  const showingTeam = me?.role === "OWNER" || (me?.role === "SUPER_ADMIN" && ownerId !== null);
  const current = me?.role === "MANAGER" ? mine : showingTeam ? team : owners;

  function exportCsv() {
    if (!me || !current) return;
    const stamp = current.from.slice(0, 10);
    if (me.role === "MANAGER" && mine) {
      downloadCsv(`commission-${stamp}.csv`, [
        [t("Player"), t("Settled bets"), t("Staked"), t("Paid out"), t("Player lost (+) / won (-)")],
        ...mine.players.map((p) => [p.username, p.bets, p.staked, p.paidOut, p.net]),
        [t("Total"), mine.totals.bets, mine.totals.staked, mine.totals.paidOut, mine.totals.net],
        [t("Your commission ({rate}%)", { rate: mine.manager.commissionRate }), "", "", "", mine.totals.commission],
      ]);
    } else if (showingTeam && team) {
      downloadCsv(`team-commission-${team.owner.username}-${stamp}.csv`, [
        [t("Manager"), t("Rate %"), t("Players"), t("Settled bets"), t("Turnover"), t("Team profit"), t("Owner pays Manager")],
        ...team.managers.map((m) => [m.username, m.commissionRate, m.players.length, m.bets, m.staked, m.net, m.commission]),
        [t("Players with no Manager"), "", team.directPlayers.length, team.directPlayers.reduce((s, p) => s + p.bets, 0), team.directPlayers.reduce((s, p) => s + p.staked, 0), team.directPlayers.reduce((s, p) => s + p.net, 0), 0],
        [],
        [t("Team profit"), team.totals.net],
        [t("Super Admin cut ({rate}%)", { rate: team.owner.commissionRate }), team.totals.superAdminCut],
        [t("Paid to Managers"), team.totals.managerCommission],
        [t("Owner keeps"), team.totals.ownerKeeps],
        [],
        [t("Player"), t("Manager"), t("Bets"), t("Turnover"), t("Team profit"), t("Manager earns")],
        ...teamPerformanceRows(team).map((p) => [p.username, p.manager ?? t("No Manager"), p.bets, p.staked, p.net, p.manager ? p.commission : ""]),
      ]);
    } else if (owners) {
      downloadCsv(`owner-commission-${stamp}.csv`, [
        [t("Owner"), t("Rate %"), t("Players"), t("Settled bets"), t("Team profit"), t("Super Admin cut"), t("Paid to Managers"), t("Owner keeps")],
        ...owners.owners.map((o) => [o.username, o.commissionRate, o.players, o.bets, o.net, o.superAdminCut, o.managerCommission, o.ownerKeeps]),
        [t("Total"), "", "", owners.totals.bets, owners.totals.net, owners.totals.superAdminCut, owners.totals.managerCommission, owners.totals.ownerKeeps],
      ]);
    }
  }

  /**
   * Collects Super Admin's cut from an Owner, or pays a Manager as their Owner.
   * Losses carry over, so a payment covers everything since the last one: the
   * server works out that amount itself and refuses anything already paid;
   * what's shown here is only for the confirmation.
   */
  async function payCommission(user: { id: string; username: string }, standing: PayoutStanding, kind: "collect" | "pay") {
    if (!current || !standing.start) return;
    const label = periodLabel(i18n, standing.start, current.to);
    const vars = { amount: formatMoney(standing.due), name: user.username, period: label };
    const question = kind === "collect" ? t("Take {amount} back from {name} for your commission ({period})?", vars) : t("Pay {amount} to {name} for their commission ({period})?", vars);
    if (!window.confirm(question)) return;
    setCollectingId(user.id);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const path = "/commissions/payouts";
      const body = JSON.stringify({ userId: user.id, from: current.from, to: current.to, label: ledgerPeriod(current.from, current.to) });
      const payout = await apiFetch<CommissionPayout>(path, token, { method: "POST", body, idempotencyKey: idempotency.keyFor(path, body) });
      idempotency.done();
      setPayouts((list) => [payout, ...list]);
      toast.success(
        payout.status === "PENDING"
          ? t("Submitted for approval: {amount} to {name}.", { amount: formatMoney(payout.amount), name: user.username })
          : kind === "collect"
            ? t("Collected {amount} from {name}.", { amount: formatMoney(payout.amount), name: user.username })
            : t("Paid {amount} to {name}.", { amount: formatMoney(payout.amount), name: user.username }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : kind === "collect" ? t("Couldn't collect the commission") : t("Couldn't pay the commission"));
    } finally {
      setCollectingId(null);
    }
  }

  // The latest payout that still counts (not rejected) for each account, among those overlapping this period.
  const payoutById: Record<string, CommissionPayout> = {};
  for (const payout of payouts) {
    if (payout.status === "REJECTED" || payoutById[payout.userId]) continue;
    payoutById[payout.userId] = payout;
  }
  // Only a period that's over can be paid: "this week" is still running, and
  // paying part of it would block the rest of it later.
  const periodEnded = range === "last-week" || (range === "custom" && current !== null && new Date(current.to).getTime() <= Date.now());

  const subtitle =
    me?.role === "MANAGER"
      ? t("What you earn from your players. You get your rate on what they lose, paid by your Owner.")
      : me?.role === "OWNER"
        ? t("What your team made, what you owe Super Admin and each Manager, and what you keep.")
        : ownerId
          ? t("What this Owner's team made, your cut, and what the Owner pays each Manager.")
          : t("Your cut from each Owner's team. Open an Owner to see what they owe their Managers.");

  // The first time, only the spinner shows until the numbers are in.
  if (!loadedOnce) return <PageLoading label="Loading commissions" />;

  return (
    <div className="stack">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{showingTeam && me?.role === "SUPER_ADMIN" && team ? t("{name}'s team", { name: team.owner.username }) : t("Commissions")}</h1>
          <p className="muted report-subtitle">{subtitle}</p>
        </div>
        {me?.role === "SUPER_ADMIN" && ownerId ? (
          <button type="button" className="text-button back-link" onClick={() => { setOwnerId(null); setTeam(null); }}>
            {t("Back to all Owners")}
          </button>
        ) : null}
      </div>

      <div className="card stack commission-period">
        <nav className="tabs-nav commission-range" aria-label={t("Period")}>
          {RANGES.map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={`tab-button${range === value ? " is-active" : ""}`}
              aria-pressed={range === value}
              onClick={() => setRange(value)}
            >
              {t(label)}
            </button>
          ))}
        </nav>
        {range === "custom" ? (
          <div className="filter-bar">
            <label>{t("From")}<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label>
            <label>{t("To")}<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label>
          </div>
        ) : null}
        <div className="commission-period-footer">
          <span className="muted">
            {current ? periodLabel(i18n, current.from, current.to) : range === "custom" ? t("Pick a start and end date") : ""}<HelpTip text="Choose which days to count. “This week” is still running, so it can't be paid yet. To pay or collect, choose “Last week” or your own dates that are over. Losses carry over: each payment covers everything since the last one, so a losing week is made up before anything more is paid. Export CSV saves the numbers as a file." />
          </span>
          {loading ? <LoadingSpinner label="Loading commissions" size="small" /> : null}
          <button type="button" className="secondary" onClick={exportCsv} disabled={!current || loading}>
            {t("Export CSV")}
          </button>
        </div>
      </div>


      {me?.role === "MANAGER" && mine ? <ManagerView data={mine} /> : null}
      {me?.role === "MANAGER" && history ? <ManagerHistory data={history} /> : null}
      {showingTeam && team && me ? (
        <TeamView
          data={team}
          viewer={me.role === "OWNER" ? "OWNER" : "SUPER_ADMIN"}
          onCollect={me.role === "OWNER" ? (manager) => void payCommission(manager, manager.payout, "pay") : undefined}
          collectingId={collectingId}
          payouts={payoutById}
          periodEnded={periodEnded}
        />
      ) : null}
      {me?.role === "SUPER_ADMIN" && !ownerId && owners ? (
        <SuperAdminView
          data={owners}
          onOpen={setOwnerId}
          onCollect={(owner) => void payCommission(owner, owner.payout, "collect")}
          collectingId={collectingId}
          payouts={payoutById}
          periodEnded={periodEnded}
        />
      ) : null}
    </div>
  );
}
