"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { ApprovalLimitControl } from "../../../../components/approval-limit-field";
import { BettingLimitsCard } from "../../../../components/betting-limits-card";
import { CommissionRateControl } from "../../../../components/commission-field";
import { HelpTip } from "../../../../components/help-tip";
import { NamedIcon } from "../../../../components/icons";
import { useI18n } from "../../../../components/i18n-provider";
import { LoadingSpinner, PageLoading } from "../../../../components/loading-spinner";
import { BlockDialog, CorrectBalanceDialog, DeleteDialog, EditPersonDialog, MoveDialog, TakeBackDialog } from "../../../../components/people-dialogs";
import { PlayerActivityView } from "../../../../components/player-activity-view";
import { QuickTopUp } from "../../../../components/quick-top-up";
import { useRealtime } from "../../../../components/realtime-provider";
import { useToast } from "../../../../components/toaster";
import { apiFetch, transactionLabel, type BalanceEntry, type MeResponse, type PlayerActivity, type TeamSettings, type UserRow } from "../../../../lib/api";
import { formatMoney } from "../../../../lib/format";
import { msg } from "../../../../lib/i18n/core";
import { ROLE_NAMES, canGiveCredit, canMove, canTakeBack, childrenOf, isBlocked, lockedByAncestor, ownerOf, team, type Team } from "../../../../lib/people";

const LEDGER_STATUS: Record<string, string> = { PENDING: msg("Waiting for approval"), REJECTED: msg("Rejected") };

type Open = "credit" | "takeBack" | "correct" | "edit" | "block" | "move" | "delete" | null;

export default function PersonPage() {
  return (
    <Suspense fallback={<PageLoading label="Loading users" />}>
      <Person />
    </Suspense>
  );
}

/**
 * Everything about one person on one page: their balance and the things you
 * do for them as big buttons at the top, then their bets (a Player), their
 * Players and rules (a Manager) or their team and rate (an Owner, for Super
 * Admin), then every money move.
 */
function Person() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const { getToken } = useAuth();
  const { t, tn, ts, date } = useI18n();
  const toast = useToast();
  const [people, setPeople] = useState<Team | null>(null);
  const [activity, setActivity] = useState<PlayerActivity | null>(null);
  const [ledger, setLedger] = useState<BalanceEntry[] | null>(null);
  const [teamSettings, setTeamSettings] = useState<TeamSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Open>(params.get("credit") ? "credit" : null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const token = await getToken();
    if (!token) return;
    const [me, users] = await Promise.all([apiFetch<MeResponse>("/users/me", token), apiFetch<UserRow[]>("/users", token)]);
    const next = team(me, users);
    const person = next.byId.get(id);
    if (!person || person.id === me.id) throw new Error(t("This account isn't in your team."));
    setPeople(next);
    const [entries, playerActivity, settings] = await Promise.all([
      apiFetch<BalanceEntry[]>(`/users/${id}/balance/ledger?limit=50`, token).catch(() => []),
      person.role === "PLAYER" ? apiFetch<PlayerActivity>(`/players/${id}/activity`, token).catch(() => null) : null,
      me.role === "OWNER" && person.role === "MANAGER" ? apiFetch<TeamSettings>("/users/me/team-settings", token).catch(() => null) : null,
    ]);
    setLedger(entries);
    setActivity(playerActivity);
    setTeamSettings(settings);
  }

  useEffect(() => {
    load().catch((err: Error) => {
      setFailed(true);
      toast.error(err.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useRealtime((event) => {
    if (event.type === "balance.changed" || event.type === "bets.changed" || event.type === "resync") load().catch(() => undefined);
  });

  const person = people?.byId.get(id);
  if (!people || !person) {
    return failed ? (
      <div className="stack">
        <Link href="/dashboard/people" className="back-link">← {t("Back")}</Link>
      </div>
    ) : (
      <PageLoading label="Loading users" />
    );
  }

  const me = people.me;
  const isPlayer = person.role === "PLAYER";
  const blocked = isBlocked(people, person);
  const lockedBy = lockedByAncestor(people, person) ? people.byId.get(person.parentId ?? "") : undefined;
  const parent = person.parentId ? people.byId.get(person.parentId) : undefined;
  const isAdmin = me.role === "SUPER_ADMIN";
  const isOwnerPage = person.role === "OWNER";
  const teamOwner = isAdmin && !isOwnerPage ? ownerOf(people, person) : undefined;
  const theirPlayers = childrenOf(people, person.id).filter((child) => child.role === "PLAYER");
  const theirManagers = childrenOf(people, person.id).filter((child) => child.role === "MANAGER");
  const backTo = isAdmin ? t("People") : me.role === "OWNER" ? t("Your team") : t("Your players");
  const fileName = `${person.username}-money.csv`;

  function close(message?: string) {
    setOpen(null);
    if (message) toast.success(message);
    load().catch(() => undefined);
  }

  async function decide(entryId: string, approve: boolean) {
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      await apiFetch(`/users/balance/transactions/${entryId}/approve`, token, { method: "POST", body: JSON.stringify({ approve }) });
      close(approve ? t("Transfer approved. The money has moved.") : t("Transfer rejected. No money moved."));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Approval update failed"));
    } finally {
      setBusy(false);
    }
  }

  function exportLedger() {
    if (!ledger) return;
    const rows = [[t("Date"), t("Type"), t("Amount"), t("Reason"), t("By")], ...ledger.map((entry) => [new Date(entry.createdAt).toISOString(), t(transactionLabel(entry.type)), entry.amount.toFixed(2), ts(entry.reason), ts(entry.counterparty ?? entry.actor?.username ?? "System")])];
    const csv = rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="stack person-page">
      <Link href="/dashboard/people" className="back-link">← {backTo}</Link>

      <section className={`card person-hero${blocked ? " is-blocked" : ""}`}>
        <div className="person-hero-top">
          <div className="person-hero-who">
            <span className="person-avatar is-large" aria-hidden="true">{person.username.slice(0, 2).toUpperCase()}</span>
            <div>
              <h1>{person.username}</h1>
              <p className="person-hero-meta">
                <span>{t(ROLE_NAMES[person.role])}</span>
                {parent && parent.id !== me.id && parent.role === "MANAGER" ? (
                  <span>· {isAdmin ? <Link href={`/dashboard/people/${parent.id}`}>{t("Manager: {name}", { name: parent.username })}</Link> : t("Manager: {name}", { name: parent.username })}</span>
                ) : null}
                {teamOwner ? (
                  <span>· <Link href={`/dashboard/people/${teamOwner.id}`}>{t("Owner: {name}", { name: teamOwner.username })}</Link></span>
                ) : null}
                {blocked ? (
                  <span className="people-tag is-blocked">{lockedBy ? t("Blocked because {name} is blocked", { name: lockedBy.username }) : t("Blocked")}</span>
                ) : (
                  <span className="people-tag is-active">{t("Can sign in")}</span>
                )}
              </p>
            </div>
          </div>
          <div className="person-hero-balance">
            <span className="muted">{t("Balance")}</span>
            <strong className={Number(person.balance) < 0 ? "ledger-negative" : undefined}>{formatMoney(person.balance)}</strong>
          </div>
        </div>
        {Number(person.balance) < 0 ? <p className="field-hint" style={{ margin: 0 }}>{t("They owe this: a corrected result took back winnings. Credit you give pays it off first.")}</p> : null}
        <div className="person-toolbar" role="toolbar" aria-label={t("Actions for {name}", { name: person.username })}>
          {canGiveCredit(people, person) ? (
            <button type="button" onClick={() => setOpen("credit")}>
              <NamedIcon name="plus" className="button-icon" />
              {t("Give credit")}
            </button>
          ) : null}
          {canTakeBack(people, person) ? (
            <button type="button" className="secondary" onClick={() => setOpen("takeBack")}>
              <NamedIcon name="minus" className="button-icon" />
              {t("Take back")}
            </button>
          ) : null}
          <button type="button" className="secondary" onClick={() => setOpen("edit")}>
            <NamedIcon name="edit" className="button-icon" />
            {t("Name or password")}
          </button>
          {isAdmin ? (
            <button type="button" className="secondary" onClick={() => setOpen("correct")}>
              <NamedIcon name="sliders" className="button-icon" />
              {t("Correct balance")}
            </button>
          ) : null}
          {canMove(people, person) ? (
            <button type="button" className="secondary" onClick={() => setOpen("move")}>
              <NamedIcon name="move" className="button-icon" />
              {t("Move")}
            </button>
          ) : null}
          {!lockedBy ? (
            <button type="button" className={`${person.status === "ACTIVE" ? "danger-button" : "secondary"} person-toolbar-end`} onClick={() => setOpen("block")}>
              <NamedIcon name={person.status === "ACTIVE" ? "block" : "check"} className="button-icon" />
              {person.status === "ACTIVE" ? t("Block") : t("Unblock")}
            </button>
          ) : null}
        </div>
      </section>

      {isPlayer ? (
        <>
          {activity ? <PlayerActivityView data={activity} /> : null}
          <BettingLimitsCard playerId={person.id} />
        </>
      ) : isOwnerPage ? (
        <>
          <section className="card stack">
            <div className="tree-header">
              <h2 style={{ margin: 0 }}>{t("Their team")}</h2>
              <span className="muted">
                {tn(theirManagers.length, "{count} manager", "{count} managers")} · {tn(people.users.filter((user) => user.role === "PLAYER" && ownerOf(people, user)?.id === person.id).length, "{count} player", "{count} players")}
              </span>
            </div>
            {theirManagers.length === 0 && theirPlayers.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>{t("Nobody in their team yet.")}</p>
            ) : (
              <div className="people-list is-flat" role="list">
                {[...theirManagers, ...theirPlayers].map((member) => (
                  <div role="listitem" key={member.id} className={`people-row${isBlocked(people, member) ? " is-blocked" : ""}`}>
                    <Link href={`/dashboard/people/${member.id}`} className="people-row-main">
                      <span className="person-avatar" aria-hidden="true">{member.username.slice(0, 2).toUpperCase()}</span>
                      <span className="people-row-text">
                        <strong>{member.username}</strong>
                        <span className="people-row-meta">
                          <span>{member.role === "MANAGER" ? `${t("Manager")} · ${tn(childrenOf(people, member.id).length, "{count} player", "{count} players")}` : t("Their own player")}</span>
                        </span>
                      </span>
                      <span className="people-row-balance">{formatMoney(member.balance)}</span>
                      <span className="people-row-chevron" aria-hidden="true">›</span>
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="card stack person-pay-limits">
            <h2 style={{ margin: 0 }}>{t("Pay and limits")}</h2>
            <CommissionRateControl
              userId={person.id}
              currentRate={Number(person.commissionRate)}
              label={t("Your share")}
              description={t("The part of their team's profit they pay you each week.")}
              onSaved={() => load().catch(() => undefined)}
            />
          </section>
        </>
      ) : (
        <>
          <section className="card stack">
            <div className="tree-header">
              <h2 style={{ margin: 0 }}>{t("Their players")}</h2>
              <span className="muted">{t("{count} of {max}", { count: theirPlayers.length, max: person.managerCapacity })}</span>
            </div>
            {theirPlayers.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>{t("No players yet.")}</p>
            ) : (
              <div className="people-list is-flat" role="list">
                {theirPlayers.map((player) => (
                  <div role="listitem" key={player.id} className={`people-row${isBlocked(people, player) ? " is-blocked" : ""}`}>
                    <Link href={`/dashboard/people/${player.id}`} className="people-row-main">
                      <span className="person-avatar" aria-hidden="true">{player.username.slice(0, 2).toUpperCase()}</span>
                      <span className="people-row-text"><strong>{player.username}</strong></span>
                      <span className="people-row-balance">{formatMoney(player.balance)}</span>
                      <span className="people-row-chevron" aria-hidden="true">›</span>
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </section>
          {me.role === "OWNER" || isAdmin ? (
            <section className="card stack person-pay-limits">
              <h2 style={{ margin: 0 }}>{t("Pay and limits")}</h2>
              <CommissionRateControl
                userId={person.id}
                currentRate={Number(person.commissionRate)}
                label={t("Their commission")}
                description={isAdmin ? t("Their share of the profit from their players, paid by their Owner each week.") : t("Their share of the profit from their players, paid by you each week.")}
                onSaved={() => load().catch(() => undefined)}
              />
              <ApprovalLimitControl
                key={person.id}
                userId={person.id}
                currentLimit={person.approvalLimit === null ? null : Number(person.approvalLimit)}
                teamLimit={teamSettings?.managerApprovalLimit ?? null}
                forAdmin={isAdmin}
                onSaved={() => load().catch(() => undefined)}
              />
            </section>
          ) : null}
        </>
      )}

      {person.parentId === me.id || isAdmin ? <LimitsCard person={person} canSetCapacity={!isPlayer && (me.role === "OWNER" || isAdmin)} onSaved={(message) => close(message)} /> : null}

      <section className="card stack">
        <div className="ledger-header">
          <h2 style={{ margin: 0 }}>
            {t("Money history")}
            <HelpTip text="Every time money moved in or out of this account, newest first." />
          </h2>
          {ledger && ledger.length > 0 ? (
            <div className="row person-ledger-actions">
              <Link className="row-detail-link" href={`/dashboard/finance?person=${encodeURIComponent(person.id)}&period=all`}>{t("See on Money page")}</Link>
              <button type="button" className="secondary is-small" onClick={exportLedger}>
                <NamedIcon name="download" className="button-icon" />
                {t("Export CSV")}
              </button>
            </div>
          ) : null}
        </div>
        {ledger === null ? (
          <LoadingSpinner label="Loading" />
        ) : ledger.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No money has moved yet.")}</p>
        ) : (
          <div className="ledger-list">
            {ledger.map((entry) => (
              <div className="ledger-row" key={entry.id}>
                <div>
                  <strong>
                    {t(transactionLabel(entry.type))}
                    {entry.status && LEDGER_STATUS[entry.status] ? <span className="muted"> ({t(LEDGER_STATUS[entry.status])})</span> : null}
                  </strong>
                  <span className="muted">{ts(entry.reason)} · {ts(entry.counterparty ?? entry.actor?.username ?? "System")}</span>
                  <Link className="row-detail-link" href={`/dashboard/finance/transaction/${entry.id}`}>{t("View receipt")}</Link>
                </div>
                <div>
                  <strong className={entry.amount < 0 ? "ledger-negative" : "ledger-positive"}>{entry.amount < 0 ? "-" : "+"}{formatMoney(Math.abs(entry.amount))}</strong>
                  <time className="muted" dateTime={entry.createdAt}>{date(entry.createdAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
                </div>
                {entry.status === "PENDING" && me.role !== "MANAGER" ? (
                  <div className="row ledger-actions">
                    <button type="button" onClick={() => decide(entry.id, true)} disabled={busy}>{t("Approve")}</button>
                    <button type="button" className="danger-button" onClick={() => decide(entry.id, false)} disabled={busy}>{t("Reject")}</button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="person-footer">
        <button type="button" className="text-button danger-text" onClick={() => setOpen("delete")}>{t("Delete this account")}</button>
      </div>

      {open === "credit" && canGiveCredit(people, person) ? (
        <QuickTopUp player={person} available={Number(me.balance)} approvalLimit={me.approvalLimit} newMoney={isAdmin} onClose={() => { setOpen(null); router.replace(`/dashboard/people/${person.id}`, { scroll: false }); }} onDone={(message) => close(message)} />
      ) : null}
      {open === "takeBack" ? <TakeBackDialog person={person} retire={isAdmin} onClose={() => setOpen(null)} onDone={close} /> : null}
      {open === "correct" && isAdmin ? <CorrectBalanceDialog person={person} onClose={() => setOpen(null)} onDone={close} /> : null}
      {open === "edit" ? <EditPersonDialog person={person} onClose={() => setOpen(null)} onDone={close} /> : null}
      {open === "block" ? <BlockDialog people={people} person={person} onClose={() => setOpen(null)} onDone={close} /> : null}
      {open === "move" ? <MoveDialog people={people} person={person} onClose={() => setOpen(null)} onDone={close} /> : null}
      {open === "delete" ? (
        <DeleteDialog
          person={person}
          onClose={() => setOpen(null)}
          onDone={(message) => {
            toast.success(message);
            router.replace("/dashboard/people");
          }}
        />
      ) : null}
    </div>
  );
}

/** The most money they can hold, and for a Manager how many Players they can have. */
function LimitsCard({ person, canSetCapacity, onSaved }: { person: UserRow; canSetCapacity: boolean; onSaved: (message: string) => void }) {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [limit, setLimit] = useState(String(Number(person.balanceLimit)));
  const [capacity, setCapacity] = useState(String(person.managerCapacity));
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent, path: string, body: object, message: string) {
    event.preventDefault();
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      await apiFetch(path, token, { method: "POST", body: JSON.stringify(body) });
      onSaved(message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Update failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card person-more">
      <summary>
        <span>
          <strong>{t("More settings")}</strong>
          <span className="muted">{canSetCapacity ? t("The most money they can hold, and how many players they can have.") : t("The most money they can hold.")}</span>
        </span>
        <NamedIcon name="chevron" className="person-more-chevron" />
      </summary>
      <div className="stack">
        <form className="inline-edit-form" onSubmit={(event) => save(event, `/users/${person.id}/balance-limit`, { limit: Number(limit) }, t("Balance limit saved."))}>
          <label>
            {t("Most money they can hold")}
            <input type="number" min="0.01" step="0.01" max="100000000" value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="decimal" />
          </label>
          <button type="submit" className="secondary" disabled={busy}>{t("Save")}</button>
        </form>
        {canSetCapacity ? (
          <form className="inline-edit-form" onSubmit={(event) => save(event, `/users/${person.id}/manager-capacity`, { capacity: Number(capacity) }, t("Player capacity saved."))}>
            <label>
              {t("Most players they can have")}
              <input type="number" min="1" step="1" max="100000" value={capacity} onChange={(event) => setCapacity(event.target.value)} inputMode="numeric" />
            </label>
            <button type="submit" className="secondary" disabled={busy}>{t("Save")}</button>
          </form>
        ) : null}
      </div>
    </details>
  );
}
