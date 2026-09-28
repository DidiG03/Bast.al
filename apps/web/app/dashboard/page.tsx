import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NamedIcon } from "../../components/icons";
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
  apiFetch,
  type CommissionDaily,
  type CommissionHistory,
  type ManagerCommissions,
  type MeResponse,
  type NotificationResponse,
  type OddsEvent,
  type PendingApproval,
  type RiskView,
  type SettlementEvent,
  type SuperAdminCommissions,
  type TeamCommissions,
  type UserRow,
} from "../../lib/api";
import { formatMoney, formatSignedMoney } from "../../lib/format";

const matchTimeFormat = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });
const DAY_MS = 86_400_000;
const weekdayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
const shortDateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Monday 00:00 UTC, the same week boundary commissions settle on. */
function startOfWeek(now: Date): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
}

type Period = { from: Date; to: Date };

/** This week so far, and the same stretch of last week for a fair comparison mid-week. */
function periods(now: Date) {
  const weekStart = startOfWeek(now);
  const thisWeek: Period = { from: weekStart, to: now };
  const lastWeek: Period = { from: new Date(weekStart.getTime() - 7 * DAY_MS), to: new Date(now.getTime() - 7 * DAY_MS) };
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
  const response = await optional(apiFetch<CommissionDaily>("/commissions/daily?days=7", token));
  return response?.days ?? [];
}

function dayLabel(day: Day, index: number, days: Day[]) {
  return index === days.length - 1 ? "Today" : weekdayFormat.format(new Date(day.from));
}

function PageHeader({ username, subtitle, now }: { username: string; subtitle: string; now: Date }) {
  const weekStart = startOfWeek(now);
  return (
    <div className="overview-header">
      <div>
        <h1>Welcome back, {username}</h1>
        <p>{subtitle}</p>
      </div>
      <span className="period-chip">
        <NamedIcon name="calendar" className="period-chip-icon" />
        {weekStart.getTime() === new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime()
          ? `This week · since ${shortDateFormat.format(weekStart)}`
          : `This week · ${shortDateFormat.format(weekStart)} to ${shortDateFormat.format(now)}`}
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: UserRow["status"] }) {
  return (
    <span className={`status-tag${status === "SUSPENDED" ? " is-suspended" : ""}`}>
      <span aria-hidden="true" />
      {status === "SUSPENDED" ? "Suspended" : "Active"}
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

  const me = await apiFetch<MeResponse>("/users/me", token);

  if (me.role === "PLAYER") {
    return <PlayerHome me={me} token={token} />;
  }

  const now = new Date();
  if (me.role === "SUPER_ADMIN") return <SuperAdminOverview token={token} me={me} now={now} />;
  if (me.role === "OWNER") return <OwnerOverview token={token} me={me} now={now} />;
  return <ManagerOverview token={token} me={me} now={now} />;
}

async function notificationsFor(token: string) {
  const response = await optional(apiFetch<NotificationResponse>("/notifications", token));
  const items = response?.items ?? [];
  return {
    latest: items.filter((item) => !item.archivedAt).slice(0, 6),
    lowBalance: items.filter((item) => item.type === "LOW_BALANCE" && !item.readAt).length,
  };
}

async function SuperAdminOverview({ token, me, now }: { token: string; me: MeResponse; now: Date }) {
  const { thisWeek, lastWeek } = periods(now);
  const [users, pending, notifications, settlementEvents, week, previous, days] = await Promise.all([
    apiFetch<UserRow[]>("/users", token),
    optional(apiFetch<PendingApproval[]>("/users/balance/pending", token)),
    notificationsFor(token),
    optional(apiFetch<SettlementEvent[]>("/bets/admin/events", token)),
    optional(apiFetch<SuperAdminCommissions>(`/commissions/owners?${query(thisWeek)}`, token)),
    optional(apiFetch<SuperAdminCommissions>(`/commissions/owners?${query(lastWeek)}`, token)),
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
    detail: `${formatMoney(day.staked)} staked`,
  }));
  const weekStaked = days.reduce((total, day) => total + day.staked, 0);

  return (
    <div className="overview">
      <PageHeader username={me.username} now={now} subtitle="How the whole platform is doing this week, and what each Owner owes you." />

      <div className="overview-layout">
        <div className="overview-main">
          <div className="kpi-row">
            <KpiCard
              label="Turnover"
              icon="turnover"
              value={formatMoney(totals?.staked ?? 0)}
              spark={days.map((day) => day.staked)}
              delta={{ current: totals?.staked ?? 0, previous: previousTotals?.staked ?? 0, label: "vs last week" }}
              hint={`${totals?.bets ?? 0} settled bets`}
            />
            <KpiCard
              label="Platform profit"
              icon="profit"
              value={formatSignedMoney(totals?.net ?? 0)}
              tone={(totals?.net ?? 0) < 0 ? "bad" : undefined}
              spark={days.map((day) => day.net)}
              delta={{ current: totals?.net ?? 0, previous: previousTotals?.net ?? 0, label: "vs last week" }}
              hint="Stakes minus payouts, across every team"
            />
            <KpiCard
              label="Owed to you"
              icon="wallet"
              value={formatSignedMoney(totals?.superAdminCut ?? 0)}
              tone={(totals?.superAdminCut ?? 0) < 0 ? "bad" : undefined}
              delta={{ current: totals?.superAdminCut ?? 0, previous: previousTotals?.superAdminCut ?? 0, label: "vs last week" }}
              hint="Each Owner's rate on their team's profit"
            />
          </div>

          <Panel title="Daily turnover" icon="chart" action={<Link href="/dashboard/reports" className="panel-link">Reports</Link>}>
            <BarChart
              points={chart}
              summary={
                <>
                  <strong>{formatMoney(weekStaked)}</strong>
                  <span>staked over the last 7 days</span>
                </>
              }
            />
          </Panel>
        </div>

        <aside className="overview-rail">
          <Panel title="Needs your attention" icon="inbox">
            <AttentionList
              items={[
                { label: "Delegations to approve", count: pending?.length ?? 0, href: "/dashboard/finance" },
                { label: "Matches needing a result", count: needsSettlement, href: "/dashboard/settlement" },
                { label: "Low-balance alerts", count: notifications.lowBalance, href: "/dashboard/users" },
              ]}
            />
          </Panel>
          <Panel title="Platform" icon="users" action={<Link href="/dashboard/users" className="panel-link">Users</Link>}>
            <Facts
              rows={[
                { label: "Owners", value: count("OWNER") },
                { label: "Managers", value: count("MANAGER") },
                { label: "Players", value: count("PLAYER") },
                { label: "Balance in circulation", value: formatMoney(inCirculation) },
              ]}
            />
          </Panel>
          <Panel title="Latest updates" icon="bell" flush>
            <ActivityFeed items={notifications.latest} now={now} />
          </Panel>
        </aside>
      </div>

      <Panel title="Owners this week" icon="commissions" flush action={<Link href="/dashboard/commissions" className="panel-link">Commissions</Link>}>
        {week && week.owners.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Owner</th>
                <th scope="col" className="num">Rate</th>
                <th scope="col" className="num">Players</th>
                <th scope="col" className="num">Turnover</th>
                <th scope="col" className="num">Team profit</th>
                <th scope="col" className="num">Owes you</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {week.owners.map((owner) => (
                <tr key={owner.id}>
                  <th scope="row" data-label="Owner">
                    <span className="person">
                      <span className="person-avatar" aria-hidden="true">{owner.username.slice(0, 2).toUpperCase()}</span>
                      {owner.username}
                    </span>
                  </th>
                  <td className="num" data-label="Rate">{owner.commissionRate}%</td>
                  <td className="num" data-label="Players">{owner.players}</td>
                  <td className="num" data-label="Turnover">{formatMoney(owner.staked)}</td>
                  <td className={`num ${signedTone(owner.net)}`} data-label="Team profit">{formatSignedMoney(owner.net)}</td>
                  <td className={`num strong${owner.superAdminCut < 0 ? " is-bad" : ""}`} data-label="Owes you">
                    {owner.superAdminCut < 0 ? `You owe ${formatMoney(-owner.superAdminCut)}` : formatMoney(owner.superAdminCut)}
                  </td>
                  <td data-label="Status"><StatusDot status={owner.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="panel-empty">No Owners yet. Create one from the Users page.</p>
        )}
      </Panel>
    </div>
  );
}

async function OwnerOverview({ token, me, now }: { token: string; me: MeResponse; now: Date }) {
  const { thisWeek, lastWeek } = periods(now);
  const [users, pending, notifications, week, previous, days, risk] = await Promise.all([
    apiFetch<UserRow[]>("/users", token),
    optional(apiFetch<PendingApproval[]>("/users/balance/pending", token)),
    notificationsFor(token),
    optional(apiFetch<TeamCommissions>(`/commissions/team?${query(thisWeek)}`, token)),
    optional(apiFetch<TeamCommissions>(`/commissions/team?${query(lastWeek)}`, token)),
    lastSevenDays(token),
    optional(apiFetch<RiskView>("/risk", token)),
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
    detail: `${formatSignedMoney(day.net)} profit`,
  }));
  const weekNet = days.reduce((total, day) => total + day.net, 0);
  const riskiest = [...(risk?.events ?? [])].sort((a, b) => b.worst.payout - a.worst.payout).slice(0, 3);
  const directPlayers = week?.directPlayers ?? [];

  return (
    <div className="overview">
      <PageHeader username={me.username} now={now} subtitle="Your team's results this week, what you owe, and where your risk sits." />

      <div className="overview-layout">
        <div className="overview-main">
          <div className="kpi-row">
            <KpiCard
              label="Team profit"
              icon="profit"
              value={formatSignedMoney(totals?.net ?? 0)}
              tone={(totals?.net ?? 0) < 0 ? "bad" : undefined}
              spark={days.map((day) => day.net)}
              delta={{ current: totals?.net ?? 0, previous: previousTotals?.net ?? 0, label: "vs last week" }}
              hint={`${formatMoney(totals?.staked ?? 0)} staked on ${totals?.bets ?? 0} bets`}
            />
            <KpiCard
              label="You owe Super Admin"
              icon="wallet"
              value={formatSignedMoney(totals?.superAdminCut ?? 0)}
              goodWhenUp={false}
              hint={`${Number(me.commissionRate)}% of team profit, before Managers are paid`}
            />
            <KpiCard
              label="You keep"
              icon="money"
              value={formatSignedMoney(totals?.ownerKeeps ?? 0)}
              tone={(totals?.ownerKeeps ?? 0) < 0 ? "bad" : undefined}
              delta={{ current: totals?.ownerKeeps ?? 0, previous: previousTotals?.ownerKeeps ?? 0, label: "vs last week" }}
              hint={`After ${formatSignedMoney(totals?.managerCommission ?? 0)} to your Managers`}
            />
          </div>

          <Panel title="Daily team profit" icon="chart" action={<Link href="/dashboard/commissions" className="panel-link">Commissions</Link>}>
            <BarChart
              points={chart}
              summary={
                <>
                  <strong className={weekNet < 0 ? "is-bad" : undefined}>{formatSignedMoney(weekNet)}</strong>
                  <span>over the last 7 days</span>
                </>
              }
            />
          </Panel>
        </div>

        <aside className="overview-rail">
          <Panel title="Risk right now" icon="risk" action={<Link href="/dashboard/risk" className="panel-link">Risk</Link>}>
            {risk ? (
              <div className="stack-tight">
                <Facts
                  rows={[
                    { label: "Open bets", value: risk.totals.openBets },
                    { label: "Staked on them", value: formatMoney(risk.totals.staked) },
                    { label: "Worst case payout", value: <span className="strong">{formatMoney(risk.totals.worstCase)}</span> },
                    { label: "Payout cap", value: risk.cap === null ? "None set" : formatMoney(risk.cap) },
                  ]}
                />
                {riskiest.length > 0 ? (
                  <ul className="risk-list">
                    {riskiest.map((event) => (
                      <li key={event.id}>
                        <div>
                          <strong>{event.name}</strong>
                          <span>{event.worst.selection} · {event.worst.market}</span>
                        </div>
                        <span className="num">{formatMoney(event.worst.payout)}</span>
                        {risk.cap ? <Meter share={event.worst.payout / risk.cap} label={`${event.name} against the payout cap`} /> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="panel-empty">No open bets right now.</p>
            )}
          </Panel>
          <Panel title="Needs your attention" icon="inbox">
            <AttentionList
              items={[
                { label: "Delegations to approve", count: pending?.length ?? 0, href: "/dashboard/finance" },
                { label: "Low-balance alerts", count: notifications.lowBalance, href: "/dashboard/users" },
              ]}
            />
          </Panel>
          <Panel title="Latest updates" icon="bell" flush>
            <ActivityFeed items={notifications.latest} now={now} />
          </Panel>
        </aside>
      </div>

      <Panel
        title="Managers this week"
        icon="users"
        flush
        action={<span className="panel-meta">{managers} Managers · {players} Players · {formatMoney(teamBalance)} delegated</span>}
      >
        {week && (week.managers.length > 0 || directPlayers.length > 0) ? (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Manager</th>
                <th scope="col" className="num">Rate</th>
                <th scope="col" className="num">Players</th>
                <th scope="col" className="num">Turnover</th>
                <th scope="col" className="num">Profit</th>
                <th scope="col" className="num">You pay them</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {week.managers.map((manager) => (
                <tr key={manager.id}>
                  <th scope="row" data-label="Manager">
                    <span className="person">
                      <span className="person-avatar" aria-hidden="true">{manager.username.slice(0, 2).toUpperCase()}</span>
                      {manager.username}
                    </span>
                  </th>
                  <td className="num" data-label="Rate">{manager.commissionRate}%</td>
                  <td className="num" data-label="Players">{manager.players.length}</td>
                  <td className="num" data-label="Turnover">{formatMoney(manager.staked)}</td>
                  <td className={`num ${signedTone(manager.net)}`} data-label="Profit">{formatSignedMoney(manager.net)}</td>
                  <td className="num strong" data-label="You pay them">{formatSignedMoney(manager.commission)}</td>
                  <td data-label="Status"><StatusDot status={manager.status} /></td>
                </tr>
              ))}
              {directPlayers.length > 0 ? (
                <tr className="is-muted-row">
                  <th scope="row" data-label="Manager">
                    <span className="person">
                      <span className="person-avatar" aria-hidden="true">—</span>
                      Your own Players
                    </span>
                  </th>
                  <td className="num" data-label="Rate">—</td>
                  <td className="num" data-label="Players">{directPlayers.length}</td>
                  <td className="num" data-label="Turnover">{formatMoney(directPlayers.reduce((total, player) => total + player.staked, 0))}</td>
                  <td className="num" data-label="Profit">{formatSignedMoney(directPlayers.reduce((total, player) => total + player.net, 0))}</td>
                  <td className="num" data-label="You pay them">—</td>
                  <td data-label="Status" />
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : (
          <p className="panel-empty">No Managers yet. Add one from the Users page.</p>
        )}
      </Panel>
    </div>
  );
}

async function ManagerOverview({ token, me, now }: { token: string; me: MeResponse; now: Date }) {
  const { thisWeek, lastWeek } = periods(now);
  const [users, notifications, week, previous, history] = await Promise.all([
    apiFetch<UserRow[]>("/users", token),
    notificationsFor(token),
    optional(apiFetch<ManagerCommissions>(`/commissions/mine?${query(thisWeek)}`, token)),
    optional(apiFetch<ManagerCommissions>(`/commissions/mine?${query(lastWeek)}`, token)),
    optional(apiFetch<CommissionHistory>("/commissions/mine/history?weeks=8", token)),
  ]);

  const players = users.filter((user) => user.role === "PLAYER");
  const suspended = players.filter((player) => player.status === "SUSPENDED").length;
  const playerBalances = players.reduce((total, player) => total + Number(player.balance), 0);
  const results = new Map((week?.players ?? []).map((player) => [player.id, player]));
  const balance = Number(me.balance);
  const limit = Number(me.balanceLimit);
  const weeks = [...(history?.weeks ?? [])].reverse();
  const chart: BarPoint[] = weeks.map((row, index) => ({
    label: index === weeks.length - 1 ? "This wk" : shortDateFormat.format(new Date(row.from)),
    value: row.commission,
    current: index === weeks.length - 1,
    detail: `${formatSignedMoney(row.commission)} earned`,
  }));
  const eightWeeks = weeks.reduce((total, row) => total + row.commission, 0);
  const sortedPlayers = [...players].sort((a, b) => (results.get(b.id)?.staked ?? 0) - (results.get(a.id)?.staked ?? 0));

  return (
    <div className="overview">
      <PageHeader username={me.username} now={now} subtitle="Your Players, their balances, and what you've earned this week." />

      <div className="overview-layout">
        <div className="overview-main">
          <div className="kpi-row">
            <KpiCard
              label="Your commission"
              icon="money"
              value={formatSignedMoney(week?.totals.commission ?? 0)}
              tone={(week?.totals.commission ?? 0) < 0 ? "bad" : undefined}
              spark={weeks.map((row) => row.commission)}
              delta={{ current: week?.totals.commission ?? 0, previous: previous?.totals.commission ?? 0, label: "vs last week" }}
              hint={`${Number(me.commissionRate)}% of the profit from your Players${week?.paidBy ? `, paid by ${week.paidBy}` : ""}`}
            />
            <KpiCard
              label="Profit from your Players"
              icon="profit"
              value={formatSignedMoney(week?.totals.net ?? 0)}
              tone={(week?.totals.net ?? 0) < 0 ? "bad" : undefined}
              delta={{ current: week?.totals.net ?? 0, previous: previous?.totals.net ?? 0, label: "vs last week" }}
              hint={`${formatMoney(week?.totals.staked ?? 0)} staked on ${week?.totals.bets ?? 0} bets`}
            />
            <KpiCard
              label="Your balance"
              icon="wallet"
              value={formatMoney(balance)}
              hint={
                limit > 0 ? (
                  <>
                    <Meter share={balance / limit} label="Balance used against your limit" />
                    <span className="kpi-hint-line">Limit {formatMoney(limit)}</span>
                  </>
                ) : (
                  "Delegated by your Owner"
                )
              }
            />
          </div>

          <Panel title="Your commission by week" icon="chart" action={<Link href="/dashboard/commissions" className="panel-link">Commissions</Link>}>
            {chart.length > 0 ? (
              <BarChart
                points={chart}
                summary={
                  <>
                    <strong className={eightWeeks < 0 ? "is-bad" : undefined}>{formatSignedMoney(eightWeeks)}</strong>
                    <span>over the last {chart.length} weeks</span>
                  </>
                }
              />
            ) : (
              <p className="panel-empty">No settled bets yet.</p>
            )}
          </Panel>
        </div>

        <aside className="overview-rail">
          <Panel title="Your team" icon="users" action={<Link href="/dashboard/users" className="panel-link">Players</Link>}>
            <Facts
              rows={[
                { label: "Players", value: players.length },
                { label: "Suspended", value: suspended },
                { label: "Their balances", value: formatMoney(playerBalances) },
                { label: "Your Owner", value: me.parent?.username ?? "—" },
              ]}
            />
          </Panel>
          <Panel title="Needs your attention" icon="inbox">
            <AttentionList items={[{ label: "Low-balance alerts", count: notifications.lowBalance, href: "/dashboard/users" }]} />
          </Panel>
          <Panel title="Latest updates" icon="bell" flush>
            <ActivityFeed items={notifications.latest} now={now} />
          </Panel>
        </aside>
      </div>

      <Panel title="Players this week" icon="users" flush action={<Link href="/dashboard/users" className="panel-link">Manage Players</Link>}>
        {sortedPlayers.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col" className="num">Balance</th>
                <th scope="col" className="num">Bets</th>
                <th scope="col" className="num">Staked</th>
                <th scope="col" className="num">Profit</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {sortedPlayers.map((player) => {
                const result = results.get(player.id);
                return (
                  <tr key={player.id}>
                    <th scope="row" data-label="Player">
                      <Link href={`/dashboard/players/${player.id}`} className="person">
                        <span className="person-avatar" aria-hidden="true">{player.username.slice(0, 2).toUpperCase()}</span>
                        {player.username}
                      </Link>
                    </th>
                    <td className="num" data-label="Balance">{formatMoney(Number(player.balance))}</td>
                    <td className="num" data-label="Bets">{result?.bets ?? 0}</td>
                    <td className="num" data-label="Staked">{formatMoney(result?.staked ?? 0)}</td>
                    <td className={`num ${signedTone(result?.net ?? 0)}`} data-label="Profit">{formatSignedMoney(result?.net ?? 0)}</td>
                    <td data-label="Status"><StatusDot status={player.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="panel-empty">No Players yet. Add one from the Players page.</p>
        )}
      </Panel>
    </div>
  );
}

async function PlayerHome({ me, token }: { me: MeResponse; token: string }) {
  const events = me.parent
    ? await apiFetch<OddsEvent[]>("/odds/events?filter=upcoming", token).catch(() => [])
    : [];
  const live = me.parent
    ? await apiFetch<OddsEvent[]>("/odds/events?filter=live", token).catch(() => [])
    : [];
  const topEvents = [...live, ...events].slice(0, 4);

  return (
    <div className="stack player-home">
      <section className="player-hero">
        <span className="player-hero-label">Your balance</span>
        <strong className="player-hero-balance">{formatMoney(Number(me.balance))}</strong>
        <div className="player-hero-meta">
          <span className={`status-pill player-status-${me.status.toLowerCase()}`}>{me.status}</span>
          {me.parent ? (
            <span className="muted">
              Backed by <strong>{me.parent.username}</strong> ({me.parent.role})
            </span>
          ) : (
            <span className="muted">Not yet assigned to a Manager or Owner.</span>
          )}
        </div>
        {me.parent ? (
          <Link href="/dashboard/bet" className="player-hero-cta">
            Browse matches →
          </Link>
        ) : null}
      </section>

      {me.parent ? (
        <section className="stack">
          <div className="page-title-row">
            <h2 style={{ margin: 0 }}>Top events</h2>
            <Link href="/dashboard/bet">View all →</Link>
          </div>
          {topEvents.length === 0 ? (
            <div className="card">
              <p className="muted" style={{ margin: 0 }}>No matches open for bets right now. Check back soon.</p>
            </div>
          ) : (
            <div className="player-top-events">
              {topEvents.map((event) => (
                <Link key={event.id} href="/dashboard/bet" className="player-top-event">
                  <span className="player-top-event-league">{event.league}</span>
                  <div className="player-top-event-teams">
                    <span className="team-badge" aria-hidden="true">{(event.homeTeam ?? event.name).slice(0, 1)}</span>
                    <span>{event.homeTeam ?? event.name}</span>
                    <span className="muted">vs</span>
                    <span>{event.awayTeam ?? ""}</span>
                    <span className="team-badge" aria-hidden="true">{(event.awayTeam ?? "?").slice(0, 1)}</span>
                  </div>
                  <span className={`status-pill${event.status === "LIVE" ? " is-active" : ""}`}>
                    {event.status === "LIVE" ? (event.elapsed === null ? "Live" : `Live ${event.elapsed}'`) : matchTimeFormat.format(new Date(event.startsAt))}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <section className="stack">
        <h2 style={{ margin: 0 }}>My Bets</h2>
        <div className="player-quick-links">
          <Link href="/dashboard/bet?tab=open" className="card player-quick-link">
            <strong>Open</strong>
            <span className="muted">Bets still in play</span>
          </Link>
          <Link href="/dashboard/bet?tab=settled" className="card player-quick-link">
            <strong>Settled</strong>
            <span className="muted">Wins &amp; losses</span>
          </Link>
        </div>
      </section>
    </div>
  );
}
