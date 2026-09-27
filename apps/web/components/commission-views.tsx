"use client";

import { formatMoney, formatSignedMoney } from "../lib/format";
import type { ManagerCommissions, PlayerResult, SuperAdminCommissions, TeamCommissions } from "../lib/api";

function playerOutcome(player: PlayerResult): string {
  if (player.bets === 0) return "No settled bets";
  if (player.net > 0) return `Lost ${formatMoney(player.net)}`;
  if (player.net < 0) return `Won ${formatMoney(-player.net)}`;
  return "Broke even";
}

function ofResult(rate: number, net: number): string {
  return net < 0 ? `${rate}% of a ${formatMoney(-net)} loss` : `${rate}% of ${formatMoney(net)} profit`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function Stat({ label, value, hint, highlight }: { label: string; value: string; hint?: string; highlight?: "good" | "bad" }) {
  return (
    <div className={`card report-stat commission-stat${highlight ? ` commission-highlight-${highlight}` : ""}`}>
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      {hint ? <span className="muted commission-stat-hint">{hint}</span> : null}
    </div>
  );
}

function PlayerList({ players }: { players: PlayerResult[] }) {
  if (players.length === 0) return <p className="muted" style={{ margin: 0 }}>No players yet.</p>;
  return (
    <div className="report-list">
      {players.map((player) => (
        <div className="report-list-row" key={player.id}>
          <div>
            <strong>{player.username}</strong>
            <span className="muted">
              {plural(player.bets, "bet")} · {formatMoney(player.staked)} staked
              {player.status === "SUSPENDED" ? " · Suspended" : ""}
            </span>
          </div>
          <span className="commission-amount">{playerOutcome(player)}</span>
        </div>
      ))}
    </div>
  );
}

export function SuperAdminView({ data, onOpen }: { data: SuperAdminCommissions; onOpen: (ownerId: string) => void }) {
  return (
    <>
      <div className="report-grid">
        <Stat label="Your cut" value={formatSignedMoney(data.totals.superAdminCut)} hint="What Owners pay you" highlight={data.totals.superAdminCut < 0 ? "bad" : "good"} />
        <Stat label="Total team profit" value={formatSignedMoney(data.totals.net)} hint="Player stakes minus payouts" />
        <Stat label="Paid to Managers" value={formatSignedMoney(data.totals.managerCommission)} hint="Owners pay this" />
        <Stat label="Owners keep" value={formatSignedMoney(data.totals.ownerKeeps)} />
      </div>
      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>Your cut by Owner</h2>
          <span className="muted">{plural(data.owners.length, "owner")}</span>
        </div>
        {data.owners.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No Owners yet.</p>
        ) : (
          <div className="report-list">
            {data.owners.map((owner) => (
              <button type="button" className="report-list-row commission-row-button" key={owner.id} onClick={() => onOpen(owner.id)}>
                <div>
                  <strong>{owner.username}</strong>
                  <span className="muted">
                    {ofResult(owner.commissionRate, owner.net)} · {plural(owner.players, "player")}
                    {owner.status === "SUSPENDED" ? " · Suspended" : ""}
                  </span>
                </div>
                <div className="commission-amount-block">
                  <strong className={owner.superAdminCut < 0 ? "ledger-negative" : undefined}>{formatSignedMoney(owner.superAdminCut)}</strong>
                  <span className="muted">View team</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export function TeamView({ data, viewer }: { data: TeamCommissions; viewer: "OWNER" | "SUPER_ADMIN" }) {
  const isOwner = viewer === "OWNER";
  const { totals, owner } = data;
  return (
    <>
      <div className="report-grid">
        <Stat label={isOwner ? "Your team's profit" : `${owner.username}'s team profit`} value={formatSignedMoney(totals.net)} hint={`${plural(totals.bets, "settled bet")}`} />
        <Stat
          label={isOwner ? "You pay Super Admin" : "Your cut"}
          value={formatSignedMoney(totals.superAdminCut)}
          hint={`${owner.commissionRate}% of team profit`}
          highlight={isOwner ? undefined : totals.superAdminCut < 0 ? "bad" : "good"}
        />
        <Stat label={isOwner ? "You pay your Managers" : "Owner pays Managers"} value={formatSignedMoney(totals.managerCommission)} hint={plural(data.managers.length, "manager")} />
        <Stat label={isOwner ? "You keep" : "Owner keeps"} value={formatSignedMoney(totals.ownerKeeps)} highlight={isOwner ? (totals.ownerKeeps < 0 ? "bad" : "good") : undefined} />
      </div>
      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>{isOwner ? "What you owe each Manager" : "Manager payouts"}</h2>
          <span className="muted">{plural(data.managers.length, "manager")}</span>
        </div>
        {data.managers.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No Managers yet.</p>
        ) : (
          <div className="report-list">
            {data.managers.map((manager) => (
              <details className="commission-details" key={manager.id}>
                <summary className="report-list-row">
                  <div>
                    <strong>{manager.username}</strong>
                    <span className="muted">
                      {ofResult(manager.commissionRate, manager.net)} · {plural(manager.players.length, "player")}
                      {manager.status === "SUSPENDED" ? " · Suspended" : ""}
                    </span>
                  </div>
                  <div className="commission-amount-block">
                    <strong className={manager.commission < 0 ? "ledger-negative" : undefined}>
                      {manager.commission < 0 ? `Owes ${formatMoney(-manager.commission)}` : `Pay ${formatMoney(manager.commission)}`}
                    </strong>
                    <span className="muted">Show players</span>
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
            <h2 style={{ margin: 0 }}>Players with no Manager</h2>
            <span className="muted">No Manager commission</span>
          </div>
          <PlayerList players={data.directPlayers} />
        </section>
      ) : null}
    </>
  );
}

export function ManagerView({ data }: { data: ManagerCommissions }) {
  const { totals, manager } = data;
  return (
    <>
      <div className="report-grid">
        <Stat
          label={totals.commission < 0 ? "You owe" : "You earned"}
          value={formatMoney(Math.abs(totals.commission))}
          hint={data.paidBy ? `Settled with ${data.paidBy}` : undefined}
          highlight={totals.commission < 0 ? "bad" : "good"}
        />
        <Stat label="Your players' result" value={totals.net < 0 ? `Won ${formatMoney(-totals.net)}` : `Lost ${formatMoney(totals.net)}`} hint="Stakes minus payouts" />
        <Stat label="Your rate" value={`${manager.commissionRate}%`} hint="Set by your Owner" />
        <Stat label="Settled bets" value={String(totals.bets)} hint={`${formatMoney(totals.staked)} staked`} />
      </div>
      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>Your players</h2>
          <span className="muted">{plural(data.players.length, "player")}</span>
        </div>
        <PlayerList players={data.players} />
      </section>
    </>
  );
}
