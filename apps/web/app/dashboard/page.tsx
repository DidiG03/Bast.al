import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { apiFetch, type MeResponse, type NotificationResponse, type OddsEvent, type PendingApproval, type SettlementEvent, type UserRow } from "../../lib/api";
import { formatMoney } from "../../lib/format";

const matchTimeFormat = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="card report-stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type AttentionItem = { label: string; count: number; href: string };

/** A "what needs me right now" list, so nothing waiting on you gets missed across separate pages. */
function NeedsAttention({ items }: { items: AttentionItem[] }) {
  const active = items.filter((item) => item.count > 0);
  return (
    <section className="card stack attention-card">
      <h2 style={{ margin: 0 }}>Needs your attention</h2>
      {active.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>You&apos;re all caught up — nothing waiting on you right now.</p>
      ) : (
        <div className="attention-list">
          {active.map((item) => (
            <Link key={item.href} href={item.href} className="attention-row">
              <span>{item.label}</span>
              <span className="status-pill odds-pill-warn">{item.count}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export default async function DashboardPage() {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) redirect("/sign-in");

  const me = await apiFetch<MeResponse>("/users/me", token);

  if (me.role === "PLAYER") {
    return <PlayerHome me={me} token={token} />;
  }

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
    </div>
  );
}

async function SuperAdminOverview({ token }: { token: string }) {
  const [users, pending, notifications, settlementEvents] = await Promise.all([
    apiFetch<UserRow[]>("/users", token),
    apiFetch<PendingApproval[]>("/users/balance/pending", token).catch(() => []),
    apiFetch<NotificationResponse>("/notifications", token).catch(() => null),
    apiFetch<SettlementEvent[]>("/bets/admin/events", token).catch(() => []),
  ]);
  const owners = users.filter((user) => user.role === "OWNER").length;
  const managers = users.filter((user) => user.role === "MANAGER").length;
  const players = users.filter((user) => user.role === "PLAYER").length;
  const totalBalance = users.reduce((total, user) => total + Number(user.balance), 0);
  const lowBalanceAlerts = notifications?.items.filter((item) => item.type === "LOW_BALANCE" && !item.readAt).length ?? 0;
  const needsSettlement = settlementEvents.filter((event) => event.needsAttention).length;

  return (
    <div className="stack">
      <NeedsAttention
        items={[
          { label: "Delegations waiting on your approval", count: pending.length, href: "/dashboard/finance" },
          { label: "Matches needing a manual result", count: needsSettlement, href: "/dashboard/settlement" },
          { label: "Low-balance alerts", count: lowBalanceAlerts, href: "/dashboard/users" },
        ]}
      />
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
  const [users, pending, notifications] = await Promise.all([
    apiFetch<UserRow[]>("/users", token),
    apiFetch<PendingApproval[]>("/users/balance/pending", token).catch(() => []),
    apiFetch<NotificationResponse>("/notifications", token).catch(() => null),
  ]);
  const managers = users.filter((user) => user.role === "MANAGER").length;
  const players = users.filter((user) => user.role === "PLAYER").length;
  const teamBalance = users
    .filter((user) => user.id !== me.id)
    .reduce((total, user) => total + Number(user.balance), 0);
  const lowBalanceAlerts = notifications?.items.filter((item) => item.type === "LOW_BALANCE" && !item.readAt).length ?? 0;

  return (
    <div className="stack">
      <NeedsAttention
        items={[
          { label: "Delegations waiting on your approval", count: pending.length, href: "/dashboard/finance" },
          { label: "Low-balance alerts", count: lowBalanceAlerts, href: "/dashboard/users" },
        ]}
      />
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
