"use client";

import Link from "next/link";
import { useState } from "react";
import { formatMoney, formatSignedMoney } from "../lib/format";
import type { CommissionHistory, CommissionPayout, CommissionTotals, ManagerCommissions, PlayerResult, SuperAdminCommissions, TeamCommissions } from "../lib/api";
import { useI18n, type I18n } from "./i18n-provider";

const DAY: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };

/** "1 Sep to 7 Sep" for a [from, to) period. */
function periodText({ t, date }: I18n, from: string, to: string, options: Intl.DateTimeFormatOptions = DAY): string {
  return t("{from} to {to}", { from: date(from, options), to: date(new Date(new Date(to).getTime() - 1), options) });
}

/**
 * The collect/pay button for one row, or where that row's commission already
 * stands for this period: paid, waiting for approval, or paid for a period
 * that overlaps this one (so this one can't be paid without paying days twice).
 */
function PayoutAction({
  payout,
  period,
  periodEnded,
  busy,
  kind,
  onClick,
}: {
  payout: CommissionPayout | undefined;
  period: { from: string; to: string };
  periodEnded: boolean;
  busy: boolean;
  kind: "collect" | "pay";
  onClick: () => void;
}) {
  const i18n = useI18n();
  const { t, date } = i18n;
  if (payout) {
    const samePeriod = new Date(payout.periodFrom).getTime() === new Date(period.from).getTime() && new Date(payout.periodTo).getTime() === new Date(period.to).getTime();
    const amount = formatMoney(payout.amount);
    const text =
      payout.status === "PENDING"
        ? t("Awaiting approval · {amount}", { amount })
        : samePeriod
          ? kind === "collect"
            ? t("Collected ✓ {amount} on {day}", { amount, day: date(payout.createdAt, DAY) })
            : t("Paid ✓ {amount} on {day}", { amount, day: date(payout.createdAt, DAY) })
          : kind === "collect"
            ? t("Collected for {period}", { period: periodText(i18n, payout.periodFrom, payout.periodTo) })
            : t("Paid for {period}", { period: periodText(i18n, payout.periodFrom, payout.periodTo) });
    return (
      <span className="status-pill commission-paid-pill" title={samePeriod ? undefined : t("This overlaps a period that was already paid, so it can't be paid again.")}>
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="secondary"
      disabled={busy || !periodEnded}
      title={periodEnded ? undefined : t("Pick a period that's over, like Last week, to pay it.")}
      onClick={(event) => {
        // Inside a <summary>, a click would also open or close the row.
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      {kind === "collect" ? (busy ? t("Collecting…") : t("Mark as collected")) : busy ? t("Paying…") : t("Mark as paid")}
    </button>
  );
}

/** Why the buttons are greyed out while a running period is on screen. */
function RunningPeriodHint({ periodEnded, kind }: { periodEnded: boolean; kind: "collect" | "pay" }) {
  const { t } = useI18n();
  if (periodEnded) return null;
  return (
    <p className="muted" style={{ margin: 0 }}>
      {kind === "collect"
        ? t("This period is still running. To collect commission, choose Last week or a custom range that has ended.")
        : t("This period is still running. To pay commission, choose Last week or a custom range that has ended.")}
    </p>
  );
}

/** A Player's result in their own words: what they lost (the team's profit) or won. */
export function playerOutcome(player: CommissionTotals, t: I18n["t"]): string {
  if (player.bets === 0) return t("No settled bets");
  if (player.net > 0) return t("Lost {amount}", { amount: formatMoney(player.net) });
  if (player.net < 0) return t("Won {amount}", { amount: formatMoney(-player.net) });
  return t("Broke even");
}

function ofResult(t: I18n["t"], rate: number, net: number): string {
  return net < 0 ? t("{rate}% of a {amount} loss", { rate, amount: formatMoney(-net) }) : t("{rate}% of {amount} profit", { rate, amount: formatMoney(net) });
}

export function Stat({ label, value, hint, highlight }: { label: string; value: string; hint?: string; highlight?: "good" | "bad" }) {
  return (
    <div className={`card report-stat commission-stat${highlight ? ` commission-highlight-${highlight}` : ""}`}>
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      {hint ? <span className="muted commission-stat-hint">{hint}</span> : null}
    </div>
  );
}

function PlayerList({ players }: { players: PlayerResult[] }) {
  const { t, tn } = useI18n();
  if (players.length === 0) return <p className="muted" style={{ margin: 0 }}>{t("No players yet.")}</p>;
  return (
    <div className="report-list">
      {players.map((player) => (
        <div className="report-list-row" key={player.id}>
          <div>
            <Link href={`/dashboard/players/${player.id}`} className="commission-player-link">{player.username}</Link>
            <span className="muted">
              {tn(player.bets, "{count} bet · {amount} staked", "{count} bets · {amount} staked", { amount: formatMoney(player.staked) })}
              {player.status === "SUSPENDED" ? ` · ${t("Suspended")}` : ""}
            </span>
          </div>
          <span className="commission-amount">{playerOutcome(player, t)}</span>
        </div>
      ))}
    </div>
  );
}

export function SuperAdminView({
  data,
  onOpen,
  onCollect,
  collectingId,
  payouts,
  periodEnded,
}: {
  data: SuperAdminCommissions;
  onOpen: (ownerId: string) => void;
  onCollect: (owner: { id: string; username: string; superAdminCut: number }) => void;
  collectingId: string | null;
  /** The payout already made for each Owner in a period overlapping this one. */
  payouts: Record<string, CommissionPayout>;
  periodEnded: boolean;
}) {
  const { t, tn } = useI18n();
  return (
    <>
      <div className="report-grid">
        <Stat label={t("Your cut")} value={formatSignedMoney(data.totals.superAdminCut)} hint={t("What Owners pay you")} highlight={data.totals.superAdminCut < 0 ? "bad" : "good"} />
        <Stat label={t("Total team profit")} value={formatSignedMoney(data.totals.net)} hint={t("Player stakes minus payouts")} />
        <Stat label={t("Paid to Managers")} value={formatSignedMoney(data.totals.managerCommission)} hint={t("Owners pay this")} />
        <Stat label={t("Owners keep")} value={formatSignedMoney(data.totals.ownerKeeps)} />
      </div>
      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>{t("Your cut by Owner")}</h2>
          <span className="muted">{tn(data.owners.length, "{count} owner", "{count} owners")}</span>
        </div>
        <RunningPeriodHint periodEnded={periodEnded} kind="collect" />
        {data.owners.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No Owners yet.")}</p>
        ) : (
          <div className="report-list">
            {data.owners.map((owner) => {
              return (
                <div className="report-list-row commission-owner-row" key={owner.id}>
                  <div>
                    <strong>{owner.username}</strong>
                    <span className="muted">
                      {ofResult(t, owner.commissionRate, owner.net)} · {tn(owner.players, "{count} player", "{count} players")}
                      {owner.status === "SUSPENDED" ? ` · ${t("Suspended")}` : ""}
                    </span>
                  </div>
                  <div className="commission-amount-block">
                    <strong className={owner.superAdminCut < 0 ? "ledger-negative" : undefined}>{formatSignedMoney(owner.superAdminCut)}</strong>
                    <div className="commission-row-actions">
                      {owner.superAdminCut > 0 || payouts[owner.id] ? (
                        <PayoutAction payout={payouts[owner.id]} period={data} periodEnded={periodEnded} busy={collectingId === owner.id} kind="collect" onClick={() => onCollect(owner)} />
                      ) : null}
                      <button type="button" className="text-button" onClick={() => onOpen(owner.id)}>
                        {t("View team")}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

export function TeamView({
  data,
  viewer,
  onCollect,
  collectingId,
  payouts = {},
  periodEnded = false,
}: {
  data: TeamCommissions;
  viewer: "OWNER" | "SUPER_ADMIN";
  onCollect?: (manager: { id: string; username: string; commission: number }) => void;
  collectingId?: string | null;
  /** The payout already made to each Manager in a period overlapping this one. */
  payouts?: Record<string, CommissionPayout>;
  periodEnded?: boolean;
}) {
  const { t, tn } = useI18n();
  const isOwner = viewer === "OWNER";
  const { totals, owner } = data;
  return (
    <>
      <div className="report-grid">
        <Stat
          label={isOwner ? t("Your team's profit") : t("{name}'s team profit", { name: owner.username })}
          value={formatSignedMoney(totals.net)}
          hint={tn(totals.bets, "{amount} turnover · {count} bet", "{amount} turnover · {count} bets", { amount: formatMoney(totals.staked) })}
        />
        <Stat
          label={isOwner ? t("You pay Super Admin") : t("Your cut")}
          value={formatSignedMoney(totals.superAdminCut)}
          hint={t("{rate}% of team profit", { rate: owner.commissionRate })}
          highlight={isOwner ? undefined : totals.superAdminCut < 0 ? "bad" : "good"}
        />
        <Stat label={isOwner ? t("You pay your Managers") : t("Owner pays Managers")} value={formatSignedMoney(totals.managerCommission)} hint={tn(data.managers.length, "{count} manager", "{count} managers")} />
        <Stat label={isOwner ? t("You keep") : t("Owner keeps")} value={formatSignedMoney(totals.ownerKeeps)} highlight={isOwner ? (totals.ownerKeeps < 0 ? "bad" : "good") : undefined} />
      </div>
      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>{isOwner ? t("What you owe each Manager") : t("Manager payouts")}</h2>
          <span className="muted">{tn(data.managers.length, "{count} manager", "{count} managers")}</span>
        </div>
        {isOwner && onCollect ? <RunningPeriodHint periodEnded={periodEnded} kind="pay" /> : null}
        {data.managers.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No Managers yet.")}</p>
        ) : (
          <div className="report-list">
            {data.managers.map((manager) => (
              <details className="commission-details" key={manager.id}>
                <summary className="report-list-row">
                  <div>
                    <strong>{manager.username}</strong>
                    <span className="muted">
                      {ofResult(t, manager.commissionRate, manager.net)} · {t("{amount} turnover", { amount: formatMoney(manager.staked) })} · {tn(manager.players.length, "{count} player", "{count} players")}
                      {manager.status === "SUSPENDED" ? ` · ${t("Suspended")}` : ""}
                    </span>
                  </div>
                  <div className="commission-amount-block">
                    <strong className={manager.commission < 0 ? "ledger-negative" : undefined}>
                      {manager.commission < 0 ? t("Owes {amount}", { amount: formatMoney(-manager.commission) }) : t("Pay {amount}", { amount: formatMoney(manager.commission) })}
                    </strong>
                    <div className="commission-row-actions">
                      {payouts[manager.id] || (isOwner && onCollect && manager.commission > 0 && manager.status !== "SUSPENDED") ? (
                        <PayoutAction payout={payouts[manager.id]} period={data} periodEnded={periodEnded} busy={collectingId === manager.id} kind="pay" onClick={() => onCollect?.(manager)} />
                      ) : null}
                      <span className="muted">{t("Show players")}</span>
                    </div>
                  </div>
                </summary>
                <div className="commission-players">
                  <PlayerList players={manager.players} />
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
      {data.directPlayers.length > 0 ? (
        <section className="card stack">
          <div className="tree-header">
            <h2 style={{ margin: 0 }}>{t("Players with no Manager")}</h2>
            <span className="muted">{t("No Manager commission")}</span>
          </div>
          <PlayerList players={data.directPlayers} />
        </section>
      ) : null}
      <TeamPerformance data={data} />
    </>
  );
}

type PerformanceRow = PlayerResult & { manager: string | null; commission: number };
type SortKey = "net" | "staked" | "bets" | "commission";

/** Every Player in the team side by side: turnover, result and what their Manager earns from them. */
export function teamPerformanceRows(data: TeamCommissions): PerformanceRow[] {
  return [
    ...data.managers.flatMap((manager) =>
      manager.players.map((player) => ({ ...player, manager: manager.username, commission: Math.round(player.net * manager.commissionRate) / 100 })),
    ),
    ...data.directPlayers.map((player) => ({ ...player, manager: null, commission: 0 })),
  ];
}

function TeamPerformance({ data }: { data: TeamCommissions }) {
  const { t, tn } = useI18n();
  const [sort, setSort] = useState<SortKey>("net");
  const rows = teamPerformanceRows(data).sort((a, b) => b[sort] - a[sort] || a.username.localeCompare(b.username));
  const columns: Array<[SortKey, string]> = [
    ["bets", t("Bets")],
    ["staked", t("Turnover")],
    ["net", t("Team profit")],
    ["commission", t("Manager earns")],
  ];
  return (
    <section className="card stack">
      <div className="tree-header">
        <h2 style={{ margin: 0 }}>{t("Team performance")}</h2>
        <span className="muted">{tn(rows.length, "{count} player", "{count} players")}</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{t("No players yet.")}</p>
      ) : (
        <div className="performance-table-wrap">
          <table className="performance-table">
            <thead>
              <tr>
                <th scope="col">{t("Player")}</th>
                {columns.map(([key, label]) => (
                  <th scope="col" key={key} aria-sort={sort === key ? "descending" : undefined}>
                    <button type="button" className={`text-button${sort === key ? " is-active" : ""}`} onClick={() => setSort(key)}>
                      {label}
                      {sort === key ? " ↓" : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <span className="performance-player">
                      <Link href={`/dashboard/players/${row.id}`} className="commission-player-link">{row.username}</Link>
                      <span className="muted">{row.manager ?? t("No Manager")}</span>
                    </span>
                  </th>
                  <td>{row.bets}</td>
                  <td>{formatMoney(row.staked)}</td>
                  <td className={row.net < 0 ? "ledger-negative" : undefined}>{formatSignedMoney(row.net)}</td>
                  <td>{row.manager ? formatSignedMoney(row.commission) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ManagerView({ data }: { data: ManagerCommissions }) {
  const { t, tn } = useI18n();
  const { totals, manager } = data;
  return (
    <>
      <div className="report-grid">
        <Stat
          label={totals.commission < 0 ? t("You owe") : t("You earned")}
          value={formatMoney(Math.abs(totals.commission))}
          hint={data.paidBy ? t("Settled with {name}", { name: data.paidBy }) : undefined}
          highlight={totals.commission < 0 ? "bad" : "good"}
        />
        <Stat
          label={t("Your players' result")}
          value={totals.net < 0 ? t("Won {amount}", { amount: formatMoney(-totals.net) }) : t("Lost {amount}", { amount: formatMoney(totals.net) })}
          hint={t("Stakes minus payouts")}
        />
        <Stat label={t("Your rate")} value={`${manager.commissionRate}%`} hint={t("Set by your Owner")} />
        <Stat label={t("Settled bets")} value={String(totals.bets)} hint={t("{amount} staked", { amount: formatMoney(totals.staked) })} />
      </div>
      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>{t("Your players")}</h2>
          <span className="muted">{tn(data.players.length, "{count} player", "{count} players")}</span>
        </div>
        <PlayerList players={data.players} />
      </section>
    </>
  );
}

/** A Manager's earnings week by week, newest first. */
export function ManagerHistory({ data }: { data: CommissionHistory }) {
  const i18n = useI18n();
  const { t, tn } = i18n;
  const best = Math.max(...data.weeks.map((week) => Math.abs(week.commission)), 1);
  return (
    <section className="card stack">
      <div className="tree-header">
        <h2 style={{ margin: 0 }}>{t("Week by week")}</h2>
        <span className="muted">{tn(data.weeks.length, "Last {count} week", "Last {count} weeks")}</span>
      </div>
      <div className="report-list">
        {data.weeks.map((week, index) => (
          <div className="report-list-row commission-week" key={week.from}>
            <div>
              <strong>{index === 0 ? t("This week") : periodText(i18n, week.from, week.to, { ...DAY, timeZone: "UTC" })}</strong>
              <span className="muted">
                {week.bets === 0
                  ? t("No settled bets")
                  : week.net > 0
                    ? tn(week.bets, "{count} bet · players lost {amount}", "{count} bets · players lost {amount}", { amount: formatMoney(week.net) })
                    : week.net < 0
                      ? tn(week.bets, "{count} bet · players won {amount}", "{count} bets · players won {amount}", { amount: formatMoney(-week.net) })
                      : tn(week.bets, "{count} bet · players broke even", "{count} bets · players broke even")}
              </span>
              <span className="commission-week-bar" aria-hidden="true">
                <span className={week.commission < 0 ? "is-negative" : undefined} style={{ width: `${(Math.abs(week.commission) / best) * 100}%` }} />
              </span>
            </div>
            <strong className={week.commission < 0 ? "ledger-negative" : undefined}>
              {week.commission < 0 ? t("Owe {amount}", { amount: formatMoney(-week.commission) }) : formatMoney(week.commission)}
            </strong>
          </div>
        ))}
      </div>
    </section>
  );
}
