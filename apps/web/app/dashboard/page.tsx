import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { HelpTip } from "../../components/help-tip";
import { NamedIcon } from "../../components/icons";
import { PlayerSportTabs, type SportTab } from "../../components/player-sport-tabs";
import { SportIcon } from "../../components/sport-icon";
import { ToastOnMount } from "../../components/toast-on-mount";
import {
  ActivityFeed,
  AttentionList,
  BarChart,
  Facts,
  KpiCard,
  Meter,
  Panel,
  type BarPoint,
} from "../../components/overview";
import {
  type CasinoLastGame,
  type CommissionDaily,
  type CommissionHistory,
  type ManagerCommissions,
  type MeResponse,
  type NotificationResponse,
  type OddsEvent,
  type MyBets,
  type PendingApproval,
  type RiskView,
  type SettlementEvent,
  type SlipInfo,
  type Sport,
  type SuperAdminCommissions,
  type TeamCommissions,
  type UserRow,
} from "../../lib/api";
import { getMe, serverApiFetch } from "../../lib/api-server";
import { formatMoney, formatSignedMoney } from "../../lib/format";
import { getT } from "../../lib/i18n/server";
import { livePill } from "../../lib/live";
import { addDays, dayKey, isDaysFromToday, startOfDay, startOfWeek } from "../../lib/time";

const MATCH_TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** "Today", "Tomorrow", or DD/MM/YYYY — so a match's day is never ambiguous. */
function topEventDayLabel(iso: string): string {
  const { t } = getT();
  if (isDaysFromToday(iso, 0)) return t("Today");
  if (isDaysFromToday(iso, 1)) return t("Tomorrow");
  const [year, month, day] = dayKey(iso).split("-");
  return `${day}/${month}/${year}`;
}
const DAY_MS = 86_400_000;
const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: "short" };
const SHORT_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };

type Period = { from: Date; to: Date };

/** This week so far, and the same stretch of last week for a fair comparison mid-week. */
function periods(now: Date) {
  const weekStart = startOfWeek(now);
  const thisWeek: Period = { from: weekStart, to: now };
  const lastWeek: Period = { from: addDays(weekStart, -7), to: new Date(now.getTime() - 7 * DAY_MS) };
  return { thisWeek, lastWeek };
}

function query(period: Period, extra = "") {
  return `from=${encodeURIComponent(period.from.toISOString())}&to=${encodeURIComponent(period.to.toISOString())}${extra}`;
}

/** A period can be empty for a moment right after midnight; treat that as no data, not an error. */
async function optional<T>(request: Promise<T>): Promise<T | null> {
  return request.catch(() => null);
}

type Day = CommissionDaily["days"][number];

async function lastSevenDays(token: string): Promise<Day[]> {
  const response = await optional(serverApiFetch<CommissionDaily>("/commissions/daily?days=7", token));
  return response?.days ?? [];
}

function dayLabel(day: Day, index: number, days: Day[]) {
  const { t, date } = getT();
  return index === days.length - 1 ? t("Today") : date(day.from, WEEKDAY);
}

function PageHeader({ username, subtitle, now }: { username: string; subtitle: string; now: Date }) {
  const { t, date } = getT();
  const weekStart = startOfWeek(now);
  return (
    <div className="overview-header">
      <div>
        <h1>{t("Welcome back, {name}", { name: username })}</h1>
        <p>{subtitle}</p>
      </div>
      <span className="period-chip">
        <NamedIcon name="calendar" className="period-chip-icon" />
        {weekStart.getTime() === startOfDay(now).getTime()
          ? t("This week · since {day}", { day: date(weekStart, SHORT_DATE) })
          : t("This week · {from} to {to}", { from: date(weekStart, SHORT_DATE), to: date(now, SHORT_DATE) })}
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: UserRow["status"] }) {
  const { t } = getT();
  return (
    <span className={`status-tag${status === "SUSPENDED" ? " is-suspended" : ""}`}>
      <span aria-hidden="true" />
      {status === "SUSPENDED" ? t("Suspended") : t("Active")}
    </span>
  );
}

function signedTone(value: number) {
  return value < 0 ? "is-bad" : value > 0 ? "is-good" : "";
}

export default async function DashboardPage() {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) redirect("/sign-in");

  const me = await getMe(token);

  if (me.role === "PLAYER") {
    return <PlayerHome me={me} token={token} />;
  }

  const now = new Date();
  if (me.role === "SUPER_ADMIN") return <SuperAdminOverview token={token} me={me} now={now} />;
  if (me.role === "OWNER") return <OwnerOverview token={token} me={me} now={now} />;
  return <ManagerOverview token={token} me={me} now={now} />;
}

async function notificationsFor(token: string) {
  const response = await optional(serverApiFetch<NotificationResponse>("/notifications", token));
  const items = response?.items ?? [];
  return {
    latest: items.filter((item) => !item.archivedAt).slice(0, 6),
    lowBalance: items.filter((item) => item.type === "LOW_BALANCE" && !item.readAt).length,
  };
}

async function SuperAdminOverview({ token, me, now }: { token: string; me: MeResponse; now: Date }) {
  const { t, tn } = getT();
  const { thisWeek, lastWeek } = periods(now);
  const [users, pending, notifications, settlementEvents, week, previous, days] = await Promise.all([
    serverApiFetch<UserRow[]>("/users", token),
    optional(serverApiFetch<PendingApproval[]>("/users/balance/pending", token)),
    notificationsFor(token),
    optional(serverApiFetch<SettlementEvent[]>("/bets/admin/events", token)),
    optional(serverApiFetch<SuperAdminCommissions>(`/commissions/owners?${query(thisWeek)}`, token)),
    optional(serverApiFetch<SuperAdminCommissions>(`/commissions/owners?${query(lastWeek)}`, token)),
    lastSevenDays(token),
  ]);

  const count = (role: UserRow["role"]) => users.filter((user) => user.role === role).length;
  const inCirculation = users.filter((user) => user.id !== me.id).reduce((total, user) => total + Number(user.balance), 0);
  const needsSettlement = (settlementEvents ?? []).filter((event) => event.needsAttention).length;
  const totals = week?.totals;
  const previousTotals = previous?.totals;
  const chart: BarPoint[] = days.map((day, index) => ({
    label: dayLabel(day, index, days),
    value: day.staked,
    current: index === days.length - 1,
    detail: t("{amount} staked", { amount: formatMoney(day.staked) }),
  }));
  const weekStaked = days.reduce((total, day) => total + day.staked, 0);

  return (
    <div className="overview">
      <PageHeader username={me.username} now={now} subtitle={t("How the whole platform is doing this week, and what each Owner owes you.")} />

      <div className="overview-layout">
        <div className="overview-main">
          <div className="kpi-row">
            <KpiCard
              label={t("Turnover")} help="All the money Players bet this week, on bets that are already finished. It shows how busy the site is, not how much you earned."
              icon="turnover"
              value={formatMoney(totals?.staked ?? 0)}
              spark={days.map((day) => day.staked)}
              delta={{ current: totals?.staked ?? 0, previous: previousTotals?.staked ?? 0, label: t("vs last week") }}
              hint={tn(totals?.bets ?? 0, "{count} settled bet", "{count} settled bets")}
            />
            <KpiCard
              label={t("Platform profit")} help="What all the teams made this week: the money Players lost, minus the money paid to Players who won. Red means Players won more than they lost."
              icon="profit"
              value={formatSignedMoney(totals?.net ?? 0)}
              tone={(totals?.net ?? 0) < 0 ? "bad" : undefined}
              spark={days.map((day) => day.net)}
              delta={{ current: totals?.net ?? 0, previous: previousTotals?.net ?? 0, label: t("vs last week") }}
              hint={t("Stakes minus payouts, across every team")}
            />
            <KpiCard
              label={t("Owed to you")} help="Your share of every team's profit this week. Each Owner pays you their rate (%) of what their team made. You collect it on the Commissions page."
              icon="wallet"
              value={formatSignedMoney(totals?.superAdminCut ?? 0)}
              tone={(totals?.superAdminCut ?? 0) < 0 ? "bad" : undefined}
              delta={{ current: totals?.superAdminCut ?? 0, previous: previousTotals?.superAdminCut ?? 0, label: t("vs last week") }}
              hint={t("Each Owner's rate on their team's profit")}
            />
          </div>

          <Panel title={t("Daily turnover")} help="One bar for each of the last 7 days. A taller bar means more money was bet that day. Put your mouse on a bar, or tap it, to see the exact amount." icon="chart" action={<Link href="/dashboard/reports" className="panel-link">{t("Reports")}</Link>}>
            <BarChart
              points={chart}
              summary={
                <>
                  <strong>{formatMoney(weekStaked)}</strong>
                  <span>{t("staked over the last 7 days")}</span>
                </>
              }
            />
          </Panel>
        </div>

        <aside className="overview-rail">
          <Panel title={t("Needs your attention")} help="Things waiting for you. A number means you have something to do: a big transfer to approve, a match with no final score, or a user almost out of money. Tap a line to go there." icon="inbox">
            <AttentionList
              items={[
                { label: t("Delegations to approve"), count: pending?.length ?? 0, href: "/dashboard/finance" },
                { label: t("Matches needing a result"), count: needsSettlement, href: "/dashboard/settlement" },
                { label: t("Low-balance alerts"), count: notifications.lowBalance, href: "/dashboard/users" },
              ]}
            />
          </Panel>
          <Panel title={t("Platform")} help="How many Owners, Managers and Players there are, and all the money sitting in their balances together." icon="users" action={<Link href="/dashboard/users" className="panel-link">{t("Users")}</Link>}>
            <Facts
              rows={[
                { label: t("Owners"), value: count("OWNER") },
                { label: t("Managers"), value: count("MANAGER") },
                { label: t("Players"), value: count("PLAYER") },
                { label: t("Balance in circulation"), value: formatMoney(inCirculation) },
              ]}
            />
          </Panel>
          <Panel title={t("Latest updates")} help="Your newest notifications: money sent, approvals and alerts. The bell at the top of the page shows all of them." icon="bell" flush>
            <ActivityFeed items={notifications.latest} now={now} />
          </Panel>
        </aside>
      </div>

      <Panel title={t("Owners this week")} help="One line for each Owner: how much their team bet and made this week, and how much they owe you. Status shows if you already collected it." icon="commissions" flush action={<Link href="/dashboard/commissions" className="panel-link">{t("Commissions")}</Link>}>
        {week && week.owners.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("Owner")}</th>
                <th scope="col" className="num">{t("Rate")}</th>
                <th scope="col" className="num">{t("Players")}</th>
                <th scope="col" className="num">{t("Turnover")}</th>
                <th scope="col" className="num">{t("Team profit")}</th>
                <th scope="col" className="num">{t("Owes you")}</th>
                <th scope="col">{t("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {week.owners.map((owner) => (
                <tr key={owner.id}>
                  <th scope="row" data-label={t("Owner")}>
                    <span className="person">
                      <span className="person-avatar" aria-hidden="true">{owner.username.slice(0, 2).toUpperCase()}</span>
                      {owner.username}
                    </span>
                  </th>
                  <td className="num" data-label={t("Rate")}>{owner.commissionRate}%</td>
                  <td className="num" data-label={t("Players")}>{owner.players}</td>
                  <td className="num" data-label={t("Turnover")}>{formatMoney(owner.staked)}</td>
                  <td className={`num ${signedTone(owner.net)}`} data-label={t("Team profit")}>{formatSignedMoney(owner.net)}</td>
                  <td className={`num strong${owner.superAdminCut < 0 ? " is-bad" : ""}`} data-label={t("Owes you")}>
                    {owner.superAdminCut < 0 ? t("You owe {amount}", { amount: formatMoney(-owner.superAdminCut) }) : formatMoney(owner.superAdminCut)}
                  </td>
                  <td data-label={t("Status")}><StatusDot status={owner.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="panel-empty">{t("No Owners yet. Create one from the Users page.")}</p>
        )}
      </Panel>
    </div>
  );
}

async function OwnerOverview({ token, me, now }: { token: string; me: MeResponse; now: Date }) {
  const { t, tn, ts } = getT();
  const { thisWeek, lastWeek } = periods(now);
  const [users, pending, notifications, week, previous, days, risk] = await Promise.all([
    serverApiFetch<UserRow[]>("/users", token),
    optional(serverApiFetch<PendingApproval[]>("/users/balance/pending", token)),
    notificationsFor(token),
    optional(serverApiFetch<TeamCommissions>(`/commissions/team?${query(thisWeek)}`, token)),
    optional(serverApiFetch<TeamCommissions>(`/commissions/team?${query(lastWeek)}`, token)),
    lastSevenDays(token),
    optional(serverApiFetch<RiskView>("/risk", token)),
  ]);

  const managers = users.filter((user) => user.role === "MANAGER").length;
  const players = users.filter((user) => user.role === "PLAYER").length;
  const teamBalance = users.filter((user) => user.id !== me.id).reduce((total, user) => total + Number(user.balance), 0);
  const totals = week?.totals;
  const previousTotals = previous?.totals;
  const chart: BarPoint[] = days.map((day, index) => ({
    label: dayLabel(day, index, days),
    value: day.net,
    current: index === days.length - 1,
    detail: t("{amount} profit", { amount: formatSignedMoney(day.net) }),
  }));
  const weekNet = days.reduce((total, day) => total + day.net, 0);
  const riskiest = [...(risk?.events ?? [])].sort((a, b) => b.worst.payout - a.worst.payout).slice(0, 3);
  const directPlayers = week?.directPlayers ?? [];

  return (
    <div className="overview">
      <PageHeader username={me.username} now={now} subtitle={t("Your team's results this week, what you owe, and where your risk sits.")} />

      <div className="overview-layout">
        <div className="overview-main">
          <div className="kpi-row">
            <KpiCard
              label={t("Team profit")} help="What your whole team made this week: the money your Players lost, minus the money paid to Players who won. Red means your Players won more than they lost."
              icon="profit"
              value={formatSignedMoney(totals?.net ?? 0)}
              tone={(totals?.net ?? 0) < 0 ? "bad" : undefined}
              spark={days.map((day) => day.net)}
              delta={{ current: totals?.net ?? 0, previous: previousTotals?.net ?? 0, label: t("vs last week") }}
              hint={tn(totals?.bets ?? 0, "{amount} staked on {count} bet", "{amount} staked on {count} bets", { amount: formatMoney(totals?.staked ?? 0) })}
            />
            <KpiCard
              label={t("You owe Super Admin")} help="Super Admin's share of your team's profit: your rate (%) of it. You pay this to Super Admin for each week."
              icon="wallet"
              value={formatSignedMoney(totals?.superAdminCut ?? 0)}
              goodWhenUp={false}
              hint={t("{rate}% of team profit, before Managers are paid", { rate: Number(me.commissionRate) })}
            />
            <KpiCard
              label={t("You keep")} help="Your money after paying Super Admin and your Managers. This is what your team earned for you this week."
              icon="money"
              value={formatSignedMoney(totals?.ownerKeeps ?? 0)}
              tone={(totals?.ownerKeeps ?? 0) < 0 ? "bad" : undefined}
              delta={{ current: totals?.ownerKeeps ?? 0, previous: previousTotals?.ownerKeeps ?? 0, label: t("vs last week") }}
              hint={t("After {amount} to your Managers", { amount: formatSignedMoney(totals?.managerCommission ?? 0) })}
            />
          </div>

          <Panel title={t("Daily team profit")} help="One bar for each day. Above the line: your team made money that day. Below the line: your Players won money. Tap a bar to see the exact amount." icon="chart" action={<Link href="/dashboard/commissions" className="panel-link">{t("Commissions")}</Link>}>
            <BarChart
              points={chart}
              summary={
                <>
                  <strong className={weekNet < 0 ? "is-bad" : undefined}>{formatSignedMoney(weekNet)}</strong>
                  <span>{t("over the last 7 days")}</span>
                </>
              }
            />
          </Panel>
        </div>

        <aside className="overview-rail">
          <Panel title={t("Risk right now")} help="Bets that are not finished yet. “Worst case payout” is the most you could have to pay if the Players' picks win. The payout cap stops new bets that could pay more than it." icon="risk" action={<Link href="/dashboard/risk" className="panel-link">{t("Risk")}</Link>}>
            {risk ? (
              <div className="stack-tight">
                <Facts
                  rows={[
                    { label: t("Open bets"), value: risk.totals.openBets },
                    { label: t("Staked on them"), value: formatMoney(risk.totals.staked) },
                    { label: t("Worst case payout"), value: <span className="strong">{formatMoney(risk.totals.worstCase)}</span> },
                    { label: t("Payout cap"), value: risk.cap === null ? t("None set") : formatMoney(risk.cap) },
                  ]}
                />
                {riskiest.length > 0 ? (
                  <ul className="risk-list">
                    {riskiest.map((event) => (
                      <li key={event.id}>
                        <div>
                          <strong>{event.name}</strong>
                          <span>{ts(event.worst.selection)} · {ts(event.worst.market)}</span>
                        </div>
                        <span className="num">{formatMoney(event.worst.payout)}</span>
                        {risk.cap ? <Meter share={event.worst.payout / risk.cap} label={t("{match} against the payout cap", { match: event.name })} /> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="panel-empty">{t("No open bets right now.")}</p>
            )}
          </Panel>
          <Panel title={t("Needs your attention")} help="Things waiting for you: big transfers from your Managers that need your OK, and users who are almost out of money. Tap a line to go there." icon="inbox">
            <AttentionList
              items={[
                { label: t("Delegations to approve"), count: pending?.length ?? 0, href: "/dashboard/finance" },
                { label: t("Low-balance alerts"), count: notifications.lowBalance, href: "/dashboard/users" },
              ]}
            />
          </Panel>
          <Panel title={t("Latest updates")} help="Your newest notifications: money sent, approvals and alerts. The bell at the top of the page shows all of them." icon="bell" flush>
            <ActivityFeed items={notifications.latest} now={now} />
          </Panel>
        </aside>
      </div>

      <Panel
        title={t("Managers this week")} help="One line for each Manager: how much their Players bet and lost this week, and the commission you pay that Manager."
        icon="users"
        flush
        action={
          <span className="panel-meta">
            {tn(managers, "{count} Manager", "{count} Managers")} · {tn(players, "{count} Player", "{count} Players")} · {t("{amount} given out", { amount: formatMoney(teamBalance) })}
          </span>
        }
      >
        {week && (week.managers.length > 0 || directPlayers.length > 0) ? (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("Manager")}</th>
                <th scope="col" className="num">{t("Rate")}</th>
                <th scope="col" className="num">{t("Players")}</th>
                <th scope="col" className="num">{t("Turnover")}</th>
                <th scope="col" className="num">{t("Profit")}</th>
                <th scope="col" className="num">{t("You pay them")}</th>
                <th scope="col">{t("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {week.managers.map((manager) => (
                <tr key={manager.id}>
                  <th scope="row" data-label={t("Manager")}>
                    <span className="person">
                      <span className="person-avatar" aria-hidden="true">{manager.username.slice(0, 2).toUpperCase()}</span>
                      {manager.username}
                    </span>
                  </th>
                  <td className="num" data-label={t("Rate")}>{manager.commissionRate}%</td>
                  <td className="num" data-label={t("Players")}>{manager.players.length}</td>
                  <td className="num" data-label={t("Turnover")}>{formatMoney(manager.staked)}</td>
                  <td className={`num ${signedTone(manager.net)}`} data-label={t("Profit")}>{formatSignedMoney(manager.net)}</td>
                  <td className="num strong" data-label={t("You pay them")}>{formatSignedMoney(manager.commission)}</td>
                  <td data-label={t("Status")}><StatusDot status={manager.status} /></td>
                </tr>
              ))}
              {directPlayers.length > 0 ? (
                <tr className="is-muted-row">
                  <th scope="row" data-label={t("Manager")}>
                    <span className="person">
                      <span className="person-avatar" aria-hidden="true">—</span>
                      {t("Your own Players")}
                    </span>
                  </th>
                  <td className="num" data-label={t("Rate")}>—</td>
                  <td className="num" data-label={t("Players")}>{directPlayers.length}</td>
                  <td className="num" data-label={t("Turnover")}>{formatMoney(directPlayers.reduce((total, player) => total + player.staked, 0))}</td>
                  <td className="num" data-label={t("Profit")}>{formatSignedMoney(directPlayers.reduce((total, player) => total + player.net, 0))}</td>
                  <td className="num" data-label={t("You pay them")}>—</td>
                  <td data-label={t("Status")} />
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : (
          <p className="panel-empty">{t("No Managers yet. Add one from the Users page.")}</p>
        )}
      </Panel>
    </div>
  );
}

async function ManagerOverview({ token, me, now }: { token: string; me: MeResponse; now: Date }) {
  const { t, tn, date } = getT();
  const { thisWeek, lastWeek } = periods(now);
  const [users, notifications, week, previous, history] = await Promise.all([
    serverApiFetch<UserRow[]>("/users", token),
    notificationsFor(token),
    optional(serverApiFetch<ManagerCommissions>(`/commissions/mine?${query(thisWeek)}`, token)),
    optional(serverApiFetch<ManagerCommissions>(`/commissions/mine?${query(lastWeek)}`, token)),
    optional(serverApiFetch<CommissionHistory>("/commissions/mine/history?weeks=8", token)),
  ]);

  const players = users.filter((user) => user.role === "PLAYER");
  const suspended = players.filter((player) => player.status === "SUSPENDED").length;
  const playerBalances = players.reduce((total, player) => total + Number(player.balance), 0);
  const results = new Map((week?.players ?? []).map((player) => [player.id, player]));
  const balance = Number(me.balance);
  const limit = Number(me.balanceLimit);
  const weeks = [...(history?.weeks ?? [])].reverse();
  const chart: BarPoint[] = weeks.map((row, index) => ({
    label: index === weeks.length - 1 ? t("This wk") : date(row.from, SHORT_DATE),
    value: row.commission,
    current: index === weeks.length - 1,
    detail: t("{amount} earned", { amount: formatSignedMoney(row.commission) }),
  }));
  const eightWeeks = weeks.reduce((total, row) => total + row.commission, 0);
  const sortedPlayers = [...players].sort((a, b) => (results.get(b.id)?.staked ?? 0) - (results.get(a.id)?.staked ?? 0));

  return (
    <div className="overview">
      <PageHeader username={me.username} now={now} subtitle={t("Your Players, their balances, and what you've earned this week.")} />

      <div className="overview-layout">
        <div className="overview-main">
          <div className="kpi-row">
            <KpiCard
              label={t("Your commission")} help="What you earned this week. You get your rate (%) of the money your Players lose. Your Owner pays it to you."
              icon="money"
              value={formatSignedMoney(week?.totals.commission ?? 0)}
              tone={(week?.totals.commission ?? 0) < 0 ? "bad" : undefined}
              spark={weeks.map((row) => row.commission)}
              delta={{ current: week?.totals.commission ?? 0, previous: previous?.totals.commission ?? 0, label: t("vs last week") }}
              hint={
                week?.paidBy
                  ? t("{rate}% of the profit from your Players, paid by {name}", { rate: Number(me.commissionRate), name: week.paidBy })
                  : t("{rate}% of the profit from your Players", { rate: Number(me.commissionRate) })
              }
            />
            <KpiCard
              label={t("Profit from your Players")} help="The money your Players lost, minus the money they won, this week. The higher it is, the more you earn. Red means they won more than they lost."
              icon="profit"
              value={formatSignedMoney(week?.totals.net ?? 0)}
              tone={(week?.totals.net ?? 0) < 0 ? "bad" : undefined}
              delta={{ current: week?.totals.net ?? 0, previous: previous?.totals.net ?? 0, label: t("vs last week") }}
              hint={tn(week?.totals.bets ?? 0, "{amount} staked on {count} bet", "{amount} staked on {count} bets", { amount: formatMoney(week?.totals.staked ?? 0) })}
            />
            <KpiCard
              label={t("Your balance")} help="Money you can give to your Players. Your Owner sends it to you. The bar shows how close you are to your limit."
              icon="wallet"
              value={formatMoney(balance)}
              hint={
                limit > 0 ? (
                  <>
                    <Meter share={balance / limit} label={t("Balance used against your limit")} />
                    <span className="kpi-hint-line">{t("Limit {amount}", { amount: formatMoney(limit) })}</span>
                  </>
                ) : (
                  t("Given to you by your Owner")
                )
              }
            />
          </div>

          <Panel title={t("Your commission by week")} help="What you earned in each of the last weeks. Tap a bar to see the exact amount." icon="chart" action={<Link href="/dashboard/commissions" className="panel-link">{t("Commissions")}</Link>}>
            {chart.length > 0 ? (
              <BarChart
                points={chart}
                summary={
                  <>
                    <strong className={eightWeeks < 0 ? "is-bad" : undefined}>{formatSignedMoney(eightWeeks)}</strong>
                    <span>{tn(chart.length, "over the last {count} week", "over the last {count} weeks")}</span>
                  </>
                }
              />
            ) : (
              <p className="panel-empty">{t("No settled bets yet.")}</p>
            )}
          </Panel>
        </div>

        <aside className="overview-rail">
          <Panel title={t("Your team")} help="Your Players: how many you have, how many are blocked (suspended), and how much money they hold together." icon="users" action={<Link href="/dashboard/users" className="panel-link">{t("Players")}</Link>}>
            <Facts
              rows={[
                { label: t("Players"), value: players.length },
                { label: t("Suspended"), value: suspended },
                { label: t("Their balances"), value: formatMoney(playerBalances) },
                { label: t("Your Owner"), value: me.parent?.username ?? "—" },
              ]}
            />
          </Panel>
          <Panel title={t("Needs your attention")} help="Players who are almost out of money. Tap the line to see them and top them up." icon="inbox">
            <AttentionList items={[{ label: t("Low-balance alerts"), count: notifications.lowBalance, href: "/dashboard/users" }]} />
          </Panel>
          <Panel title={t("Latest updates")} help="Your newest notifications: money sent, approvals and alerts. The bell at the top of the page shows all of them." icon="bell" flush>
            <ActivityFeed items={notifications.latest} now={now} />
          </Panel>
        </aside>
      </div>

      <Panel title={t("Players this week")} help="One line for each Player: how much they bet this week, and whether they won or lost." icon="users" flush action={<Link href="/dashboard/users" className="panel-link">{t("Manage Players")}</Link>}>
        {sortedPlayers.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("Player")}</th>
                <th scope="col" className="num">{t("Balance")}</th>
                <th scope="col" className="num">{t("Bets")}</th>
                <th scope="col" className="num">{t("Staked")}</th>
                <th scope="col" className="num">{t("Profit")}</th>
                <th scope="col">{t("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {sortedPlayers.map((player) => {
                const result = results.get(player.id);
                return (
                  <tr key={player.id}>
                    <th scope="row" data-label={t("Player")}>
                      <Link href={`/dashboard/players/${player.id}`} className="person">
                        <span className="person-avatar" aria-hidden="true">{player.username.slice(0, 2).toUpperCase()}</span>
                        {player.username}
                      </Link>
                    </th>
                    <td className="num" data-label={t("Balance")}>{formatMoney(Number(player.balance))}</td>
                    <td className="num" data-label={t("Bets")}>{result?.bets ?? 0}</td>
                    <td className="num" data-label={t("Staked")}>{formatMoney(result?.staked ?? 0)}</td>
                    <td className={`num ${signedTone(result?.net ?? 0)}`} data-label={t("Profit")}>{formatSignedMoney(result?.net ?? 0)}</td>
                    <td data-label={t("Status")}><StatusDot status={player.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="panel-empty">{t("No Players yet. Add one from the Users page.")}</p>
        )}
      </Panel>
    </div>
  );
}

/** The sports on the home page's Top events, in the Bet page's order. Greyhounds have their own section. */
const HOME_SPORTS: Array<[Sport, string]> = [
  ["football", "Football"],
  ["tennis", "Tennis"],
  ["basketball", "Basketball"],
  ["volleyball", "Volleyball"],
  ["handball", "Handball"],
  ["nfl", "NFL"],
  ["mma", "MMA"],
];

/** Each Casino game's page and its sign on the Continue card. */
const CASINO_GAMES: Record<CasinoLastGame["game"], { href: string; icon: string; name: string }> = {
  slot: { href: "/dashboard/casino/slot", icon: "🍒", name: "Sizzling Hot" },
  book: { href: "/dashboard/casino/book", icon: "📖", name: "Book of Ra" },
  roulette: { href: "/dashboard/casino/roulette", icon: "🎡", name: "Roulette" },
  blackjack: { href: "/dashboard/casino/blackjack", icon: "🃏", name: "Blackjack" },
  mines: { href: "/dashboard/casino/mines", icon: "💎", name: "Mines" },
  penalty: { href: "/dashboard/casino/penalty", icon: "⚽", name: "Penalty" },
  plinko: { href: "/dashboard/casino/plinko", icon: "🔴", name: "Plinko" },
  dice: { href: "/dashboard/casino/dice", icon: "🎲", name: "Dice" },
  keno: { href: "/dashboard/casino/keno", icon: "🔢", name: "Keno" },
};

const LAST_PLAYED: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

async function PlayerHome({ me, token }: { me: MeResponse; token: string }) {
  const { t, tn, ts, date } = getT();
  // Live first, then the next two days' matches with the most to bet on: picked by the API, for each sport.
  const [bySport, nextRaces, slip, bets, lastGame] = me.parent
    ? await Promise.all([
        Promise.all(HOME_SPORTS.map(([sport]) => serverApiFetch<OddsEvent[]>(`/odds/top-events?count=4&sport=${sport}`, token).catch(() => [] as OddsEvent[]))),
        serverApiFetch<OddsEvent[]>("/odds/top-events?count=3&sport=greyhounds", token).catch(() => []),
        serverApiFetch<SlipInfo>("/bets/slip", token).catch(() => null),
        serverApiFetch<MyBets>("/bets/mine?status=open", token).catch(() => null),
        me.casinoOpen ? serverApiFetch<{ last: CasinoLastGame | null }>("/casino/last-game", token).then((answer) => answer.last).catch(() => null) : Promise.resolve(null),
      ])
    : [[], [], null, null, null];
  // Why this account can't bet (a suspended Manager, no team yet): a warning toast, and no Top events.
  const blocked = me.status === "SUSPENDED" ? t("Your account is suspended. Ask your Manager or Owner.") : slip?.blocked ? ts(slip.blocked) : null;
  const week = bets?.week;
  const weekNet = week ? Math.round((week.returned - week.staked) * 100) / 100 : 0;

  const sports = HOME_SPORTS.map(([sport, label], index) => ({ sport, label: t(label), events: bySport[index] ?? [] })).filter((entry) => entry.events.length > 0);
  // All sports together: every match playing now first, then the soonest to start.
  const everything = sports.flatMap(({ sport, events }) => events.map((event) => ({ sport, event })));
  const all = [
    ...everything.filter(({ event }) => event.status === "LIVE"),
    ...everything.filter(({ event }) => event.status !== "LIVE").sort((a, b) => a.event.startsAt.localeCompare(b.event.startsAt)),
  ].slice(0, 6);
  const liveCount = (events: OddsEvent[]) => events.filter((event) => event.status === "LIVE").length;

  const eventCard = (sport: Sport, event: OddsEvent, showSport: boolean) => (
    <Link key={event.id} href={`/dashboard/bet?${sport === "football" ? "" : `sport=${sport}&`}match=${encodeURIComponent(event.id)}`} className="player-top-event">
      <div className="player-top-event-head">
        <span className="player-top-event-league">
          {showSport ? <SportIcon sport={sport} /> : null}
          {event.league}
        </span>
        <span className={`status-pill${event.status === "LIVE" ? " is-active" : ""}`}>
          {event.status === "LIVE" ? livePill(event, t) : `${topEventDayLabel(event.startsAt)} · ${date(event.startsAt, MATCH_TIME)}`}
        </span>
      </div>
      <div className="player-top-event-teams">
        <span className="team-badge" aria-hidden="true">{(event.homeTeam ?? event.name).slice(0, 1)}</span>
        <span>{event.homeTeam ?? event.name}</span>
        {event.live && event.homeScore !== null && event.awayScore !== null ? (
          <strong className="odds-score">
            {event.homeScore} – {event.awayScore}
          </strong>
        ) : (
          <span className="muted">{t("vs")}</span>
        )}
        <span>{event.awayTeam ?? ""}</span>
        <span className="team-badge" aria-hidden="true">{(event.awayTeam ?? "?").slice(0, 1)}</span>
      </div>
    </Link>
  );
  const tabs: SportTab[] =
    sports.length === 0
      ? []
      : [
          ...(sports.length > 1
            ? [{ key: "all" as const, label: t("All"), live: liveCount(all.map(({ event }) => event)), panel: <div className="player-top-events">{all.map(({ sport, event }) => eventCard(sport, event, true))}</div> }]
            : []),
          ...sports.map(({ sport, label, events }) => ({ key: sport, label, live: liveCount(events), panel: <div className="player-top-events">{events.map((event) => eventCard(sport, event, false))}</div> })),
        ];

  const continueGame = lastGame ? CASINO_GAMES[lastGame.game] : null;

  return (
    <div className="stack player-home">
      {blocked ? <ToastOnMount kind="warning" message={blocked} /> : null}
      {me.parent ? null : <ToastOnMount kind="warning" message={t("Not yet assigned to a Manager or Owner.")} />}

      {me.parent && !blocked && lastGame && continueGame ? (
        <section className="stack">
          <h2 style={{ margin: 0 }}>{lastGame.waiting ? t("Continue playing") : t("Play again")}</h2>
          <Link href={continueGame.href} className={`card player-continue${lastGame.waiting ? " is-waiting" : ""}`}>
            <span className="player-continue-icon" aria-hidden="true">
              {continueGame.icon}
            </span>
            <span className="player-continue-body">
              <strong>{lastGame.name ?? t(continueGame.name)}</strong>
              <span className="muted">
                {lastGame.waiting === "round"
                  ? t("Your round is still in play: {amount} on the table.", { amount: formatMoney(lastGame.amount) })
                  : lastGame.waiting === "freeSpins"
                    ? tn(lastGame.freeSpins ?? 0, "{count} free spin waiting, at {amount}.", "{count} free spins waiting, at {amount}.", { amount: formatMoney(lastGame.amount) })
                    : lastGame.waiting === "gamble"
                      ? t("A {amount} win is waiting: double it or take it.", { amount: formatMoney(lastGame.amount) })
                      : t("Last played {when}, at {amount}.", { when: date(lastGame.at, LAST_PLAYED), amount: formatMoney(lastGame.amount) })}
              </span>
            </span>
            <span className="player-continue-go">{lastGame.waiting ? t("Continue") : t("Play")} →</span>
          </Link>
        </section>
      ) : null}

      {me.parent && !blocked ? (
        <section className="stack">
          <div className="page-title-row">
            <h2 style={{ margin: 0 }}>
              {t("Top events")}
              <HelpTip text="Matches playing now first, then the matches of the next two days with the most ways to bet, for each sport. Tap one to go straight to its prices." />
            </h2>
            <Link href="/dashboard/bet">{t("View all")} →</Link>
          </div>
          {tabs.length === 0 ? (
            <div className="card">
              <p className="muted" style={{ margin: 0 }}>{t("No matches are open for bets right now. Check back soon.")}</p>
            </div>
          ) : (
            <PlayerSportTabs tabs={tabs} label={t("Sport")} />
          )}
        </section>
      ) : null}

      {me.parent && !blocked && nextRaces.length > 0 ? (
        <section className="stack">
          <div className="page-title-row">
            <h2 style={{ margin: 0 }}>
              {t("Next races")}
              <HelpTip text="The next greyhound races. Back a dog to win, or pick the 1st and 2nd. Race bets pay the starting price, set when the race starts." />
            </h2>
            <Link href="/dashboard/bet?sport=greyhounds">{t("View all")} →</Link>
          </div>
          <div className="player-next-races">
            {nextRaces.map((race) => (
              <Link key={race.id} href="/dashboard/bet?sport=greyhounds" className="card player-next-race">
                <span className="player-top-event-league">{race.league}</span>
                <strong>{t("Race {number}", { number: race.race?.raceNumber ?? "" })}</strong>
                <span className="status-pill">{date(race.startsAt, MATCH_TIME)}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="stack">
        <h2 style={{ margin: 0 }}>
          {t("My bets")}
          <HelpTip text="Your bets. “Open” means the match is not finished yet. “Settled” means it is finished: you won, lost, or got your money back." />
        </h2>
        <div className="player-quick-links">
          <Link href="/dashboard/bet?tab=open" className="card player-quick-link">
            <strong>{t("Open")}</strong>
            <span className="player-quick-number">{bets ? tn(bets.open.count, "{count} bet", "{count} bets") : "–"}</span>
            <span className="muted">{bets && bets.open.count > 0 ? t("{amount} on matches not finished yet", { amount: formatMoney(bets.open.staked) }) : t("Bets still in play")}</span>
          </Link>
          <Link href="/dashboard/bet?tab=settled" className="card player-quick-link">
            <strong>{t("Last 7 days")}</strong>
            {week && week.count > 0 ? (
              <>
                <span className={`player-quick-number ${weekNet >= 0 ? "is-positive" : "is-negative"}`}>
                  {weekNet >= 0 ? t("You won {amount}", { amount: `+${formatMoney(weekNet)}` }) : t("You lost {amount}", { amount: `−${formatMoney(-weekNet)}` })}
                </span>
                <span className="muted">{tn(week.count, "{count} finished bet, {amount} bet", "{count} finished bets, {amount} bet", { amount: formatMoney(week.staked) })}</span>
              </>
            ) : (
              <>
                <span className="player-quick-number">–</span>
                <span className="muted">{t("No finished bets this week")}</span>
              </>
            )}
          </Link>
        </div>
      </section>
    </div>
  );
}
