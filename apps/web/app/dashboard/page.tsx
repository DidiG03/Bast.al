import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  apiFetch,
  type BalanceEntry,
  type CommissionReport,
  type MeResponse,
  type UserRow,
} from "../../lib/api";

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="card report-stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function money(value: number) {
  return `$${value.toFixed(2)}`;
}

export default async function DashboardPage() {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) redirect("/sign-in");

  const me = await apiFetch<MeResponse>("/users/me", token);

  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Dashboard</h1>
      <div className="card stack">
        <p style={{ margin: 0 }}>
          Signed in as <strong>{me.username}</strong> · <span className="muted">{me.role}</span>
        </p>
      </div>
      {me.role === "SUPER_ADMIN" ? <SuperAdminOverview token={token} /> : null}
      {me.role === "OWNER" ? <OwnerOverview token={token} /> : null}
      {me.role === "MANAGER" ? <ManagerOverview token={token} me={me} /> : null}
      {me.role === "PLAYER" ? <PlayerOverview me={me} /> : null}
    </div>
  );
}

async function SuperAdminOverview({ token }: { token: string }) {
  const [users, commission] = await Promise.all([
    apiFetch<UserRow[]>("/users", token),
    apiFetch<CommissionReport>("/users/commission-report", token),
  ]);
  const owners = users.filter((user) => user.role === "OWNER").length;
  const managers = users.filter((user) => user.role === "MANAGER").length;
  const players = users.filter((user) => user.role === "PLAYER").length;
  const managerBalances = users
    .filter((user) => user.role === "MANAGER")
    .reduce((total, user) => total + Number(user.balance), 0);
  const totalCommission = commission.rows.reduce((total, row) => total + row.estimatedCommission, 0);

  return (
    <div className="stack">
      <div className="page-title-row">
        <h2 style={{ margin: 0 }}>Platform overview</h2>
        <Link href="/dashboard/reports">View reports →</Link>
      </div>
      <div className="report-grid">
        <StatTile label="Owners" value={String(owners)} />
        <StatTile label="Managers" value={String(managers)} />
        <StatTile label="Players" value={String(players)} />
        <StatTile label="Manager balances" value={money(managerBalances)} />
      </div>
      <div className="card stack">
        <span className="muted">Commission from Owners (estimated, this period)</span>
        <strong style={{ fontSize: "1.8rem" }}>{money(totalCommission)}</strong>
        <p className="muted" style={{ margin: 0 }}>
          Set each Owner&apos;s rate from the <Link href="/dashboard/users">Users</Link> page. See
          the full breakdown on the <Link href="/dashboard/reports">Reports → Commission</Link> tab.
        </p>
      </div>
    </div>
  );
}

async function OwnerOverview({ token }: { token: string }) {
  const [users, commission] = await Promise.all([
    apiFetch<UserRow[]>("/users", token),
    apiFetch<CommissionReport>("/users/commission-report", token),
  ]);
  const managers = users.filter((user) => user.role === "MANAGER").length;
  const players = users.filter((user) => user.role === "PLAYER").length;
  const managerBalances = users
    .filter((user) => user.role === "MANAGER")
    .reduce((total, user) => total + Number(user.balance), 0);
  const owedToManagers = commission.rows.reduce((total, row) => total + row.estimatedCommission, 0);

  return (
    <div className="stack">
      <div className="page-title-row">
        <h2 style={{ margin: 0 }}>Business overview</h2>
        <Link href="/dashboard/users">Manage team →</Link>
      </div>
      <div className="report-grid">
        <StatTile label="Managers" value={String(managers)} />
        <StatTile label="Players" value={String(players)} />
        <StatTile label="Manager balances" value={money(managerBalances)} />
      </div>
      <div className="reports-columns">
        <div className="card stack">
          <span className="muted">Commission you owe Super Admin (estimated)</span>
          <strong style={{ fontSize: "1.8rem" }}>
            {commission.self ? money(commission.self.estimatedCommission) : "$0.00"}
          </strong>
          <p className="muted" style={{ margin: 0 }}>
            {commission.self ? `${commission.self.rate}% of your Managers' ledger activity.` : "No rate set yet."}
          </p>
        </div>
        <div className="card stack">
          <span className="muted">Commission you owe your Managers (estimated)</span>
          <strong style={{ fontSize: "1.8rem" }}>{money(owedToManagers)}</strong>
          <p className="muted" style={{ margin: 0 }}>
            Managers don&apos;t risk capital — this is their pay for administering Players. Set
            rates from the <Link href="/dashboard/users">Users</Link> page.
          </p>
        </div>
      </div>
    </div>
  );
}

async function ManagerOverview({ token, me }: { token: string; me: MeResponse }) {
  const ledger = await apiFetch<BalanceEntry[]>(`/users/${me.id}/balance/ledger`, token);
  const basisVolume = ledger
    .filter((entry) => (entry.type === "DEBIT" || entry.type === "REVERSAL") && entry.status !== "PENDING" && entry.status !== "REJECTED")
    .reduce((total, entry) => total + entry.amount, 0);
  const estimatedCommission = (basisVolume * me.commissionRate) / 100;

  return (
    <div className="stack">
      <div className="page-title-row">
        <h2 style={{ margin: 0 }}>Your account</h2>
        <Link href="/dashboard/users">View your Players →</Link>
      </div>
      <div className="report-grid">
        <StatTile label="Balance" value={money(Number(me.balance))} />
        <StatTile label="Balance limit" value={money(Number(me.balanceLimit))} />
        <StatTile label="Commission rate" value={`${me.commissionRate}%`} />
        <StatTile label="Estimated commission earned" value={money(estimatedCommission)} />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Your balance is funded by your Owner — you administer Players, not your own capital.
        Commission is your pay, set by your Owner.
      </p>
    </div>
  );
}

function PlayerOverview({ me }: { me: MeResponse }) {
  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Your account</h2>
        <p style={{ margin: 0 }}>
          Status: <strong>{me.status}</strong>
        </p>
        <p style={{ margin: 0 }}>
          {me.parent ? (
            <>
              Administered by <strong>{me.parent.username}</strong>{" "}
              <span className="muted">({me.parent.role})</span>
            </>
          ) : (
            <span className="muted">Not yet assigned to a Manager or Owner.</span>
          )}
        </p>
        <p className="muted" style={{ margin: 0 }}>
          Wagering is coming soon — your account isn&apos;t able to place bets yet.
        </p>
      </div>
    </div>
  );
}
