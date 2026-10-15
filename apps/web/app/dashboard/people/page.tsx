"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccountReadyDialog, AddPersonDialog } from "../../../components/people-dialogs";
import { BulkActionModal } from "../../../components/bulk-actions";
import { NamedIcon } from "../../../components/icons";
import { PageLoading } from "../../../components/loading-spinner";
import { QuickTopUp } from "../../../components/quick-top-up";
import { useRealtime } from "../../../components/realtime-provider";
import { useToast } from "../../../components/toaster";
import { useI18n } from "../../../components/i18n-provider";
import { apiFetch, type BulkAction, type MeResponse, type UserRow } from "../../../lib/api";
import { formatMoney } from "../../../lib/format";
import { canGiveCredit, childrenOf, isBlocked, moveDestinations, ownerOf, team, type Team } from "../../../lib/people";

type OpenBets = Record<string, { bets: number; staked: number }>;
type Show = "tree" | "owners" | "players" | "managers";
/** The Owner's last choice of view, kept on this device. */
const VIEW_KEY = "bastal-team-view";

function savedView(): Show {
  try {
    const value = window.localStorage.getItem(VIEW_KEY);
    return value === "players" || value === "managers" || value === "owners" ? value : "tree";
  } catch {
    return "tree";
  }
}

/**
 * The people under you: a Manager's Players as one list; an Owner's team as
 * a tree (each Manager with their Players under them, then the Owner's own
 * Players), or as a list of Players or of Managers. Super Admin gets every
 * team: each Owner with their tree under them, or a list of Owners, Managers
 * or Players. Tapping a name opens their page, where everything about them
 * is done; the one thing done here is a quick top-up.
 */
/** Active people first, then by name. */
function byName(people: Team) {
  return (a: UserRow, b: UserRow) => Number(isBlocked(people, a)) - Number(isBlocked(people, b)) || a.username.localeCompare(b.username);
}

export default function PeoplePage() {
  const { getToken } = useAuth();
  const { t, tn } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const [people, setPeople] = useState<Team | null>(null);
  const [openBets, setOpenBets] = useState<OpenBets>({});
  const [failed, setFailed] = useState(false);
  const [show, setShowState] = useState<Show>("tree");
  /** Managers whose Players are folded away in the tree. */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<"PLAYER" | "MANAGER" | "OWNER" | null>(null);
  // Super Admin's tree opens with each Manager's Players folded away, the first time only.
  const foldedOnce = useRef(false);
  const [created, setCreated] = useState<{ user: UserRow; password: string } | null>(null);
  const [topUp, setTopUp] = useState<UserRow | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);

  async function load() {
    const token = await getToken();
    if (!token) return;
    const [me, users] = await Promise.all([apiFetch<MeResponse>("/users/me", token), apiFetch<UserRow[]>("/users", token)]);
    if (me.role === "PLAYER") {
      router.replace("/dashboard");
      return;
    }
    setPeople(team(me, users));
    if (me.role === "SUPER_ADMIN" && !foldedOnce.current) {
      foldedOnce.current = true;
      setFolded(new Set(users.filter((user) => user.role === "MANAGER").map((user) => user.id)));
    }
    // A badge that fails to load isn't worth an error on the whole page.
    setOpenBets(await apiFetch<OpenBets>("/bets/admin/open-by-player", token).catch(() => ({})));
  }

  useEffect(() => setShowState(savedView()), []);
  function setShow(next: Show) {
    setShowState(next);
    setSelecting(false);
    setSelected(new Set());
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Not remembered on this device; it opens on the tree next time.
    }
  }

  // The Overview's "Add a player" / "Add a manager" / "Add an owner" buttons land here with the form open.
  useEffect(() => {
    const add = new URLSearchParams(window.location.search).get("add");
    if (add === "player" || add === "manager" || add === "owner") {
      setAdding(add === "player" ? "PLAYER" : add === "manager" ? "MANAGER" : "OWNER");
      router.replace("/dashboard/people", { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load().catch((err: Error) => {
      setFailed(true);
      toast.error(err.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "balance.changed" || event.type === "bets.changed" || event.type === "resync") load().catch(() => undefined);
  });

  const query = search.trim().toLowerCase();
  // A Manager only has Players: the tree is an Owner's or Super Admin's, and only Super Admin has Owners.
  const role = people?.me.role;
  const view: Show = role === "SUPER_ADMIN" ? show : role === "OWNER" ? (show === "owners" ? "tree" : show) : "players";
  const list = useMemo(() => {
    if (!people) return [];
    const role = view === "managers" ? "MANAGER" : view === "owners" ? "OWNER" : "PLAYER";
    return people.users
      .filter((user) => user.role === role && user.id !== people.me.id && (!query || user.username.toLowerCase().includes(query)))
      .sort(byName(people));
  }, [people, view, query]);
  /**
   * The tree under one Owner: each Manager with the Players under them, then
   * the Owner's own Players. A search keeps a Manager whose name or Players
   * match; `keepAll` keeps everyone (the Owner's own name matched).
   */
  function teamTree(people: Team, ownerId: string, keepAll: boolean) {
    const matches = (user: UserRow) => keepAll || !query || user.username.toLowerCase().includes(query);
    const playersOf = (id: string) => childrenOf(people, id).filter((user) => user.role === "PLAYER");
    const groups = childrenOf(people, ownerId)
      .filter((user) => user.role === "MANAGER")
      .sort(byName(people))
      .map((manager) => ({ manager, players: playersOf(manager.id).filter((player) => matches(manager) || matches(player)).sort(byName(people)) }))
      .filter((group) => matches(group.manager) || group.players.length > 0);
    return { groups, own: playersOf(ownerId).filter(matches).sort(byName(people)) };
  }
  const tree = useMemo(() => (people ? teamTree(people, people.me.id, false) : { groups: [], own: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [people, query]);
  /** Super Admin's tree: every Owner with their team under them. */
  const owners = useMemo(() => {
    if (!people || people.me.role !== "SUPER_ADMIN") return [];
    return people.users
      .filter((user) => user.role === "OWNER")
      .sort(byName(people))
      .map((owner) => {
        const ownerMatches = !query || owner.username.toLowerCase().includes(query);
        return { owner, ...teamTree(people, owner.id, ownerMatches), ownerMatches };
      })
      .filter((branch) => branch.ownerMatches || branch.groups.length > 0 || branch.own.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, query]);

  if (!people) return failed ? null : <PageLoading label="Loading users" />;

  const isOwner = people.me.role === "OWNER";
  const isAdmin = people.me.role === "SUPER_ADMIN";
  const players = people.users.filter((user) => user.role === "PLAYER").length;
  const managers = people.users.filter((user) => user.role === "MANAGER").length;
  const ownerCount = people.users.filter((user) => user.role === "OWNER").length;
  const selectedUsers = people.users.filter((user) => selected.has(user.id));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function fold(id: string) {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  /** One person's line: their name and tags, balance, and a quick top-up if they're right under you. */
  function row(user: UserRow, line: string | null, nested = false) {
    if (!people) return null;
    const blocked = isBlocked(people, user);
    const open = openBets[user.id];
    return (
      <div role="listitem" key={user.id} className={`people-row${blocked ? " is-blocked" : ""}${selected.has(user.id) ? " is-selected" : ""}${nested ? " is-nested" : ""}`}>
        {selecting && user.role === "PLAYER" ? (
          <input type="checkbox" className="people-select" checked={selected.has(user.id)} onChange={() => toggle(user.id)} aria-label={t("Select {name}", { name: user.username })} />
        ) : null}
        <Link href={`/dashboard/people/${user.id}`} className="people-row-main">
          <span className="person-avatar" aria-hidden="true">{user.username.slice(0, 2).toUpperCase()}</span>
          <span className="people-row-text">
            <strong>{user.username}</strong>
            <span className="people-row-meta">
              {blocked ? <span className="people-tag is-blocked">{t("Blocked")}</span> : null}
              {open ? <span className="people-tag is-bets">{tn(open.bets, "{count} open bet", "{count} open bets")}</span> : null}
              {line ? <span>{line}</span> : null}
            </span>
          </span>
          <span className={`people-row-balance${Number(user.balance) < 0 ? " ledger-negative" : ""}`}>{formatMoney(user.balance)}</span>
          <span className="people-row-chevron" aria-hidden="true">›</span>
        </Link>
        {!selecting && canGiveCredit(people, user) ? (
          <button type="button" className="secondary is-small people-row-action" onClick={() => setTopUp(user)} aria-label={t("Top up {name}", { name: user.username })}>
            <NamedIcon name="plus" className="button-icon" />
            <span className="people-row-action-label">{t("Credit")}</span>
          </button>
        ) : null}
      </div>
    );
  }
  const playerCount = (id: string) => tn(childrenOf(people, id).filter((child) => child.role === "PLAYER").length, "{count} player", "{count} players");
  /** An Owner's line: how big their team is (every Player, theirs and their Managers'). */
  const ownerLine = (owner: UserRow) => {
    const under = people.users.filter((user) => user.role !== "OWNER" && ownerOf(people, user)?.id === owner.id);
    return `${tn(under.filter((user) => user.role === "MANAGER").length, "{count} manager", "{count} managers")} · ${tn(under.filter((user) => user.role === "PLAYER").length, "{count} player", "{count} players")}`;
  };
  /** A Manager and the Players under them, folded or open. */
  function managerBranch(manager: UserRow, under: UserRow[]) {
    const open = Boolean(query) || !folded.has(manager.id);
    return (
      <div key={manager.id} className="people-branch" role="presentation">
        <div className="people-branch-head">
          <button
            type="button"
            className={`people-fold${open ? " is-open" : ""}`}
            onClick={() => fold(manager.id)}
            disabled={under.length === 0}
            aria-expanded={open}
            aria-label={open ? t("Hide {name}'s players", { name: manager.username }) : t("Show {name}'s players", { name: manager.username })}
          >
            <NamedIcon name="chevron" className="people-fold-icon" />
          </button>
          {row(manager, `${t("Manager")} · ${playerCount(manager.id)}`)}
        </div>
        {open && under.length > 0 ? <div className="people-branch-children">{under.map((player) => row(player, null, true))}</div> : null}
      </div>
    );
  }

  function done(message: string) {
    toast.success(message);
    load().catch(() => undefined);
  }

  return (
    <div className="stack people-page">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{isAdmin ? t("People") : isOwner ? t("Your team") : t("Your players")}</h1>
          <p className="muted report-subtitle">
            {isAdmin ? t("Every Owner with their team under them. Tap a name to give credit, see their bets, or change their account.") : t("Tap a name to give credit, see their bets, or change their account.")}
          </p>
        </div>
        <div className="page-title-actions">
          {isAdmin ? (
            <button type="button" onClick={() => setAdding("OWNER")}>
              <NamedIcon name="userPlus" className="button-icon" />
              {t("Add an owner")}
            </button>
          ) : null}
          {isOwner ? (
            <button type="button" className="secondary" onClick={() => setAdding("MANAGER")}>
              <NamedIcon name="userPlus" className="button-icon" />
              {t("Add a manager")}
            </button>
          ) : null}
          {isAdmin ? null : (
            <button type="button" onClick={() => setAdding("PLAYER")}>
              <NamedIcon name="userPlus" className="button-icon" />
              {t("Add a player")}
            </button>
          )}
        </div>
      </div>

      {isOwner || isAdmin ? (
        <div className="segmented" role="tablist" aria-label={t("Show")}>
          <button type="button" role="tab" aria-selected={view === "tree"} className={view === "tree" ? "is-active" : ""} onClick={() => setShow("tree")}>
            {t("Tree")}
          </button>
          {isAdmin ? (
            <button type="button" role="tab" aria-selected={view === "owners"} className={view === "owners" ? "is-active" : ""} onClick={() => setShow("owners")}>
              {t("Owners")} <span className="segmented-count">{ownerCount}</span>
            </button>
          ) : null}
          <button type="button" role="tab" aria-selected={view === "managers"} className={view === "managers" ? "is-active" : ""} onClick={() => setShow("managers")}>
            {t("Managers")} <span className="segmented-count">{managers}</span>
          </button>
          <button type="button" role="tab" aria-selected={view === "players"} className={view === "players" ? "is-active" : ""} onClick={() => setShow("players")}>
            {t("Players")} <span className="segmented-count">{players}</span>
          </button>
        </div>
      ) : null}

      <div className="people-toolbar">
        <label className="search-field">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("Find by name")} aria-label={t("Find by name")} />
        </label>
        {view !== "managers" && view !== "owners" && players > 1 ? (
          <button type="button" className="text-button" onClick={() => (selecting ? (setSelecting(false), setSelected(new Set())) : setSelecting(true))}>
            {selecting ? t("Done") : t("Select several")}
          </button>
        ) : null}
      </div>

      {view === "tree" && isAdmin ? (
        <div className="card people-list people-tree" role="list">
          {owners.length === 0 ? (
            <div className="people-empty">
              <p style={{ margin: 0 }}>{query ? t("Nobody by that name.") : t("No Owners yet. Add one to start a team.")}</p>
            </div>
          ) : null}
          {owners.map(({ owner, groups, own }) => {
            const open = Boolean(query) || !folded.has(owner.id);
            const hasTeam = groups.length > 0 || own.length > 0;
            return (
              <div key={owner.id} className="people-branch is-owner" role="presentation">
                <div className="people-branch-head">
                  <button
                    type="button"
                    className={`people-fold${open ? " is-open" : ""}`}
                    onClick={() => fold(owner.id)}
                    disabled={!hasTeam}
                    aria-expanded={open}
                    aria-label={open ? t("Hide {name}'s team", { name: owner.username }) : t("Show {name}'s team", { name: owner.username })}
                  >
                    <NamedIcon name="chevron" className="people-fold-icon" />
                  </button>
                  {row(owner, ownerLine(owner))}
                </div>
                {open && hasTeam ? (
                  <div className="people-branch-children">
                    {groups.map(({ manager, players: under }) => managerBranch(manager, under))}
                    {own.length > 0 ? (
                      <div className="people-branch" role="presentation">
                        <div className="people-branch-label">{t("Their own players")}</div>
                        <div className="people-branch-children">{own.map((player) => row(player, null, true))}</div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : view === "tree" ? (
        <div className="card people-list people-tree" role="list">
          {tree.groups.length === 0 && tree.own.length === 0 ? (
            <div className="people-empty">
              <p style={{ margin: 0 }}>{query ? t("Nobody by that name.") : t("Your team is empty. Add a manager or a player to start.")}</p>
            </div>
          ) : null}
          {tree.groups.map(({ manager, players: under }) => managerBranch(manager, under))}
          {tree.own.length > 0 ? (
            <div className="people-branch" role="presentation">
              <div className="people-branch-label">{t("Your own players")}</div>
              <div className="people-branch-children">{tree.own.map((player) => row(player, null, true))}</div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="card people-list" role="list">
          {list.length === 0 ? (
            <div className="people-empty">
              <p style={{ margin: 0 }}>
                {query ? t("Nobody by that name.") : view === "owners" ? t("No Owners yet. Add one to start a team.") : view === "managers" ? (isAdmin ? t("No managers yet.") : t("You have no managers yet.")) : isAdmin ? t("No players yet.") : t("You have no players yet.")}
              </p>
              {!query && (!isAdmin || view === "owners") ? (
                <button type="button" onClick={() => setAdding(view === "owners" ? "OWNER" : view === "managers" ? "MANAGER" : "PLAYER")}>
                  {view === "owners" ? t("Add an owner") : view === "managers" ? t("Add a manager") : t("Add a player")}
                </button>
              ) : null}
            </div>
          ) : (
            list.map((user) => {
              const parent = user.parentId ? people.byId.get(user.parentId) : undefined;
              const owner = ownerOf(people, user);
              const line = isAdmin
                ? user.role === "OWNER"
                  ? ownerLine(user)
                  : user.role === "MANAGER"
                    ? `${playerCount(user.id)} · ${t("Owner: {name}", { name: owner?.username ?? "–" })}`
                    : parent && parent.role === "MANAGER"
                      ? `${t("Manager: {name}", { name: parent.username })} · ${t("Owner: {name}", { name: owner?.username ?? "–" })}`
                      : t("Owner: {name}", { name: owner?.username ?? "–" })
                : user.role === "MANAGER"
                  ? playerCount(user.id)
                  : isOwner
                    ? parent && parent.id !== people.me.id
                      ? t("Manager: {name}", { name: parent.username })
                      : t("Your own player")
                    : null;
              return row(user, line);
            })
          )}
        </div>
      )}

      {selecting && selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label={t("Actions for selected accounts")}>
          <span className="bulk-bar-count">{t("{count} selected", { count: selected.size })}</span>
          {selectedUsers.every((user) => canGiveCredit(people, user)) ? <button type="button" className="secondary" onClick={() => setBulk("delegate")}>{t("Give credit")}</button> : null}
          {selectedUsers.some((user) => user.status === "ACTIVE") ? <button type="button" className="secondary" onClick={() => setBulk("suspend")}>{t("Block")}</button> : null}
          {selectedUsers.some((user) => user.status === "SUSPENDED") ? <button type="button" className="secondary" onClick={() => setBulk("unsuspend")}>{t("Unblock")}</button> : null}
          {isOwner ? <button type="button" className="secondary" onClick={() => setBulk("reassign")}>{t("Move")}</button> : null}
        </div>
      ) : null}

      {adding ? (
        <AddPersonDialog
          people={people}
          kind={adding}
          onClose={() => setAdding(null)}
          onCreated={(user, password) => {
            setAdding(null);
            setCreated({ user, password });
            load().catch(() => undefined);
          }}
        />
      ) : null}
      {created ? (
        <AccountReadyDialog
          user={created.user}
          password={created.password}
          onClose={() => setCreated(null)}
          onOpen={() => {
            const { user } = created;
            setCreated(null);
            router.push(`/dashboard/people/${user.id}${user.role === "PLAYER" ? "?credit=1" : ""}`);
          }}
        />
      ) : null}
      {topUp ? (
        <QuickTopUp
          player={topUp}
          available={Number(people.me.balance)}
          approvalLimit={people.me.approvalLimit}
          newMoney={isAdmin}
          onClose={() => setTopUp(null)}
          onDone={(message) => {
            setTopUp(null);
            done(message);
          }}
        />
      ) : null}
      {bulk ? (
        <BulkActionModal
          action={bulk}
          users={bulk === "suspend" ? selectedUsers.filter((user) => user.status === "ACTIVE") : bulk === "unsuspend" ? selectedUsers.filter((user) => user.status === "SUSPENDED") : selectedUsers}
          destinations={moveDestinations(people)}
          onClose={() => setBulk(null)}
          onDone={(summary, failedIds) => {
            setSelected(new Set(failedIds));
            setBulk(null);
            if (failedIds.length === 0) toast.success(summary);
            load().catch(() => undefined);
          }}
        />
      ) : null}
    </div>
  );
}
