import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { apiFetch, type MeResponse, type UserRow } from "../../lib/api";
import { formatMoney } from "../../lib/format";

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="card report-stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
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
      {me.role === "OWNER" ? <OwnerOverview token={token} me={me} /> : null}
      {me.role === "MANAGER" ? <ManagerOverview me={me} /> : null}
      {me.role === "PLAYER" ? <PlayerOverview me={me} /> : null}
    </div>
  );
}

async function SuperAdminOverview({ token }: { token: string }) {
  const users = await apiFetch<UserRow[]>("/users", token);
  const owners = users.filter((user) => user.role === "OWNER").length;
  const managers = users.filter((user) => user.role === "MANAGER").length;
  const players = users.filter((user) => user.role === "PLAYER").length;
  const totalBalance = users.reduce((total, user) => total + Number(user.balance), 0);

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
        <StatTile label="Balance in circulation" value={formatMoney(totalBalance)} />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Set each Owner&apos;s commission rate from the <Link href="/dashboard/users">Users</Link> page.
      </p>
    </div>
  );
}

async function OwnerOverview({ token, me }: { token: string; me: MeResponse }) {
  const users = await apiFetch<UserRow[]>("/users", token);
  const managers = users.filter((user) => user.role === "MANAGER").length;
  const players = users.filter((user) => user.role === "PLAYER").length;
  const teamBalance = users
    .filter((user) => user.id !== me.id)
    .reduce((total, user) => total + Number(user.balance), 0);

  return (
    <div className="stack">
      <div className="page-title-row">
        <h2 style={{ margin: 0 }}>Business overview</h2>
        <Link href="/dashboard/users">Manage team →</Link>
      </div>
      <div className="report-grid">
        <StatTile label="Managers" value={String(managers)} />
        <StatTile label="Players" value={String(players)} />
        <StatTile label="Your balance" value={formatMoney(Number(me.balance))} />
        <StatTile label="Delegated to your team" value={formatMoney(teamBalance)} />
      </div>
      <div className="card stack">
        <span className="muted">Commission rate Super Admin set for you</span>
        <strong style={{ fontSize: "1.8rem" }}>{Number(me.commissionRate)}%</strong>
        <p className="muted" style={{ margin: 0 }}>
          Managers don&apos;t risk capital — set their commission rate from the{" "}
          <Link href="/dashboard/users">Users</Link> page as their pay for administering Players.
        </p>
      </div>
    </div>
  );
}

function ManagerOverview({ me }: { me: MeResponse }) {
  return (
    <div className="stack">
      <div className="page-title-row">
        <h2 style={{ margin: 0 }}>Your account</h2>
        <Link href="/dashboard/users">View your Players →</Link>
      </div>
      <div className="report-grid">
        <StatTile label="Balance" value={formatMoney(Number(me.balance))} />
        <StatTile label="Balance limit" value={formatMoney(Number(me.balanceLimit))} />
        <StatTile label="Commission rate" value={`${Number(me.commissionRate)}%`} />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Your balance is delegated by your Owner — you administer Players, not your own capital.
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
          Balance: <strong>{formatMoney(Number(me.balance))}</strong> · Status: <strong>{me.status}</strong>
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
        {me.parent ? (
          <Link href="/dashboard/bet" className="button-link" style={{ justifySelf: "start" }}>
            Browse matches
          </Link>
        ) : null}
      </div>
    </div>
  );
}
