"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import { ManagerHistory, ManagerView, SuperAdminView, TeamView, teamPerformanceRows } from "../../../components/commission-views";
import {
  apiFetch,
  type CommissionHistory,
  type ManagerCommissions,
  type MeResponse,
  type SuperAdminCommissions,
  type TeamCommissions,
} from "../../../lib/api";

type Range = "this-week" | "last-week" | "this-month" | "custom";

const RANGES: Array<[Range, string]> = [
  ["this-week", "This week"],
  ["last-week", "Last week"],
  ["this-month", "This month"],
  ["custom", "Custom"],
];

function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

/** [from, to) in the viewer's local time. Weeks run Monday to Sunday. */
function rangeDates(range: Range, customFrom: string, customTo: string): { from: Date; to: Date } | null {
  const now = new Date();
  if (range === "this-week") return { from: startOfWeek(now), to: now };
  if (range === "last-week") {
    const to = startOfWeek(now);
    const from = new Date(to);
    from.setDate(from.getDate() - 7);
    return { from, to };
  }
  if (range === "this-month") return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
  if (!customFrom || !customTo) return null;
  const to = new Date(`${customTo}T00:00:00`);
  to.setDate(to.getDate() + 1);
  return { from: new Date(`${customFrom}T00:00:00`), to };
}

function periodLabel(from: string, to: string): string {
  const format = new Intl.DateTimeFormat("en", { day: "numeric", month: "short" });
  // `to` is exclusive; show the last day actually included.
  const last = new Date(new Date(to).getTime() - 1);
  return `${format.format(new Date(from))} to ${format.format(last)}`;
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
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const dates = rangeDates(range, customFrom, customTo);
    if (!dates) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load commissions");
    } finally {
      setLoading(false);
    }
  }, [range, customFrom, customTo, ownerId, me, getToken]);

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
        ["Player", "Settled bets", "Staked", "Paid out", "Player lost (+) / won (-)"],
        ...mine.players.map((p) => [p.username, p.bets, p.staked, p.paidOut, p.net]),
        ["Total", mine.totals.bets, mine.totals.staked, mine.totals.paidOut, mine.totals.net],
        [`Your commission (${mine.manager.commissionRate}%)`, "", "", "", mine.totals.commission],
      ]);
    } else if (showingTeam && team) {
      downloadCsv(`team-commission-${team.owner.username}-${stamp}.csv`, [
        ["Manager", "Rate %", "Players", "Settled bets", "Turnover", "Team profit", "Owner pays Manager"],
        ...team.managers.map((m) => [m.username, m.commissionRate, m.players.length, m.bets, m.staked, m.net, m.commission]),
        ["Players with no Manager", "", team.directPlayers.length, team.directPlayers.reduce((s, p) => s + p.bets, 0), team.directPlayers.reduce((s, p) => s + p.staked, 0), team.directPlayers.reduce((s, p) => s + p.net, 0), 0],
        [],
        ["Team profit", team.totals.net],
        [`Super Admin cut (${team.owner.commissionRate}%)`, team.totals.superAdminCut],
        ["Paid to Managers", team.totals.managerCommission],
        ["Owner keeps", team.totals.ownerKeeps],
        [],
        ["Player", "Manager", "Bets", "Turnover", "Team profit", "Manager earns"],
        ...teamPerformanceRows(team).map((p) => [p.username, p.manager ?? "No Manager", p.bets, p.staked, p.net, p.manager ? p.commission : ""]),
      ]);
    } else if (owners) {
      downloadCsv(`owner-commission-${stamp}.csv`, [
        ["Owner", "Rate %", "Players", "Settled bets", "Team profit", "Super Admin cut", "Paid to Managers", "Owner keeps"],
        ...owners.owners.map((o) => [o.username, o.commissionRate, o.players, o.bets, o.net, o.superAdminCut, o.managerCommission, o.ownerKeeps]),
        ["Total", "", "", owners.totals.bets, owners.totals.net, owners.totals.superAdminCut, owners.totals.managerCommission, owners.totals.ownerKeeps],
      ]);
    }
  }

  const subtitle =
    me?.role === "MANAGER"
      ? "What you earn from your players. You get your rate on what they lose, paid by your Owner."
      : me?.role === "OWNER"
        ? "What your team made, what you owe Super Admin and each Manager, and what you keep."
        : ownerId
          ? "What this Owner's team made, your cut, and what the Owner pays each Manager."
          : "Your cut from each Owner's team. Open an Owner to see what they owe their Managers.";

  return (
    <div className="stack">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{showingTeam && me?.role === "SUPER_ADMIN" && team ? `${team.owner.username}'s team` : "Commissions"}</h1>
          <p className="muted report-subtitle">{subtitle}</p>
        </div>
        {me?.role === "SUPER_ADMIN" && ownerId ? (
          <button type="button" className="text-button back-link" onClick={() => { setOwnerId(null); setTeam(null); }}>
            Back to all Owners
          </button>
        ) : null}
      </div>

      <div className="card stack commission-period">
        <nav className="tabs-nav commission-range" aria-label="Period">
          {RANGES.map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={`tab-button${range === value ? " is-active" : ""}`}
              aria-pressed={range === value}
              onClick={() => setRange(value)}
            >
              {label}
            </button>
          ))}
        </nav>
        {range === "custom" ? (
          <div className="filter-bar">
            <label>From<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label>
            <label>To<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label>
          </div>
        ) : null}
        <div className="commission-period-footer">
          <span className="muted">
            {current ? periodLabel(current.from, current.to) : range === "custom" ? "Pick a start and end date" : ""}
            {loading ? " · Loading…" : ""}
          </span>
          <button type="button" className="secondary" onClick={exportCsv} disabled={!current || loading}>
            Export CSV
          </button>
        </div>
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      {me?.role === "MANAGER" && mine ? <ManagerView data={mine} /> : null}
      {me?.role === "MANAGER" && history ? <ManagerHistory data={history} /> : null}
      {showingTeam && team && me ? <TeamView data={team} viewer={me.role === "OWNER" ? "OWNER" : "SUPER_ADMIN"} /> : null}
      {me?.role === "SUPER_ADMIN" && !ownerId && owners ? <SuperAdminView data={owners} onOpen={setOwnerId} /> : null}
    </div>
  );
}
