"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch, type BalanceEntry, type BalanceStatement, type MeResponse, type ReassignmentPreview, type UserRow } from "../../../lib/api";
import { LoadingSpinner } from "../../../components/loading-spinner";
import { CommissionRateControl } from "../../../components/commission-field";

const ROLE_OPTIONS: Record<MeResponse["role"], Array<"OWNER" | "MANAGER" | "PLAYER">> = {
  SUPER_ADMIN: ["OWNER"],
  OWNER: ["MANAGER", "PLAYER"],
  MANAGER: ["PLAYER"],
  PLAYER: [],
};

export default function UsersPage() {
  const { getToken } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"OWNER" | "MANAGER" | "PLAYER">("PLAYER");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [confirmation, setConfirmation] = useState<{ action: "suspend" | "delete"; user: UserRow } | null>(null);
  const [reassignUser, setReassignUser] = useState<UserRow | null>(null);
  const [reassignManagerId, setReassignManagerId] = useState("");
  const [reassignmentPreview, setReassignmentPreview] = useState<ReassignmentPreview | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [balanceUser, setBalanceUser] = useState<UserRow | null>(null);
  const [balanceAmount, setBalanceAmount] = useState("");
  const [balanceReason, setBalanceReason] = useState("");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [balanceLimit, setBalanceLimit] = useState("");
  const [managerCapacity, setManagerCapacity] = useState("");
  const [statementFrom, setStatementFrom] = useState("");
  const [statementTo, setStatementTo] = useState("");
  const [balanceLedger, setBalanceLedger] = useState<BalanceEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [commissionUser, setCommissionUser] = useState<UserRow | null>(null);

  const creatable = useMemo(() => (me ? ROLE_OPTIONS[me.role] : []), [me]);
  const assignableManagers = useMemo(
    () => users.filter((user) => user.role === "MANAGER" && user.status === "ACTIVE"),
    [users],
  );

  async function load() {
    const token = await getToken();
    if (!token) return;
    const [profile, list] = await Promise.all([
      apiFetch<MeResponse>("/users/me", token),
      apiFetch<UserRow[]>("/users", token),
    ]);
    setMe(profile);
    setUsers(list);
    const options = ROLE_OPTIONS[profile.role];
    if (options[0]) setRole(options[0]);
  }

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [error]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      await apiFetch("/users", token, {
        method: "POST",
        body: JSON.stringify({ username, password, role, ...(role === "PLAYER" && parentId ? { parentId } : {}) }),
      });
      setUsername("");
      setPassword("");
      setParentId("");
      setCreateOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSuspend(id: string) {
    setError(null);
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      await apiFetch(`/users/${id}/suspend`, token, { method: "POST" });
      setConfirmation(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suspend failed");
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(user: UserRow) {
    setEditingId(user.id);
    setEditingUser(user);
    setEditUsername(user.username);
    setEditPassword("");
    setError(null);
  }

  async function onUpdate(e: FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setError(null);
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      await apiFetch(`/users/${editingId}/update`, token, {
        method: "POST",
        body: JSON.stringify({
          username: editUsername,
          ...(editPassword ? { password: editPassword } : {}),
        }),
      });
      setEditingId(null);
      setEditingUser(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(user: UserRow) {
    setError(null);
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      await apiFetch(`/users/${user.id}/delete`, token, { method: "POST" });
      setConfirmation(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDelegateCredit(event: FormEvent) {
    event.preventDefault();
    if (!balanceUser) return;
    setError(null);
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      await apiFetch(`/users/${balanceUser.id}/delegate`, token, {
        method: "POST",
        body: JSON.stringify({ amount: Number(balanceAmount), reason: balanceReason }),
      });
      setBalanceUser(null);
      setBalanceAmount("");
      setBalanceReason("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delegating credit failed");
    } finally {
      setBusy(false);
    }
  }

  async function onAdjustBalance(event: FormEvent) {
    event.preventDefault();
    if (!balanceUser) return;
    setError(null);
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      await apiFetch(`/users/${balanceUser.id}/adjust-balance`, token, {
        method: "POST",
        body: JSON.stringify({ amount: Number(adjustAmount), reason: adjustReason }),
      });
      setAdjustAmount("");
      setAdjustReason("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Adjustment failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSetBalanceLimit(event: FormEvent) {
      event.preventDefault();
      if (!balanceUser) return;
      setError(null);
      setBusy(true);
      try {
        const token = await getToken();
        if (!token) throw new Error("Not signed in");
        await apiFetch(`/users/${balanceUser.id}/balance-limit`, token, {
          method: "POST",
          body: JSON.stringify({ limit: Number(balanceLimit) }),
        });
        setBalanceUser({ ...balanceUser, balanceLimit: Number(balanceLimit) });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Balance limit update failed");
      } finally {
        setBusy(false);
      }

  }

  async function onSetManagerCapacity(event: FormEvent) {
        event.preventDefault();
        if (!balanceUser) return;
        setBusy(true);
        try {
          const token = await getToken();
          if (!token) throw new Error("Not signed in");
          await apiFetch(`/users/${balanceUser.id}/manager-capacity`, token, { method: "POST", body: JSON.stringify({ capacity: Number(managerCapacity) }) });
          await load();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Capacity update failed");
        } finally {
          setBusy(false);
      }
  }

  async function approveTransaction(id: string, approve: boolean) {
      setError(null);
      setBusy(true);
      try {
        const token = await getToken();
        if (!token) throw new Error("Not signed in");
        await apiFetch(`/users/balance/transactions/${id}/approve`, token, {
          method: "POST",
          body: JSON.stringify({ approve }),
        });
        if (balanceUser) {
          setBalanceLedger(await apiFetch<BalanceEntry[]>(`/users/${balanceUser.id}/balance/ledger`, token));
          await load();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Approval update failed");
      } finally {
        setBusy(false);
    }
  }

  async function onReassign(event: FormEvent) {
      event.preventDefault();
      if (!reassignUser || !reassignManagerId) return;
      setError(null);
      setBusy(true);
      try {
        const token = await getToken();
        if (!token) throw new Error("Not signed in");
        await apiFetch(`/users/${reassignUser.id}/reassign`, token, {
          method: "POST",
          body: JSON.stringify({ managerId: reassignManagerId }),
        });
        setReassignUser(null);
        setReassignManagerId("");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Reassignment failed");
      } finally {
        setBusy(false);
    }

  }

  async function loadReassignmentPreview(managerId: string, user: UserRow) {
      setReassignManagerId(managerId);
      setReassignmentPreview(null);
      if (!managerId) return;
      try {
        const token = await getToken();
        if (!token) throw new Error("Not signed in");
        setReassignmentPreview(await apiFetch<ReassignmentPreview>(`/users/${user.id}/reassignment-preview?managerId=${encodeURIComponent(managerId)}`, token));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not preview reassignment");
    }
  }

  async function openBalance(user: UserRow) {
      setActionMenuId(null);
      setBalanceUser(user);
      setBalanceAmount("");
      setBalanceReason("");
      setAdjustAmount("");
      setAdjustReason("");
      setBalanceLimit(String(Number(user.balanceLimit)));
      setManagerCapacity(String(user.managerCapacity));
      try {
        const token = await getToken();
        if (!token) throw new Error("Not signed in");
        setBalanceLedger(await apiFetch<BalanceEntry[]>(`/users/${user.id}/balance/ledger`, token));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Ledger failed");
      }
    }

  function exportLedger() {
      if (!balanceUser) return;
      const rows = [
        ["Date", "Type", "Amount", "Reason", "Actor"],
        ...balanceLedger.map((entry) => [
          new Date(entry.createdAt).toISOString(),
          entry.type,
          entry.amount.toFixed(2),
          entry.reason,
          entry.counterparty ?? entry.actor?.username ?? "System",
        ]),
      ];
      const csv = rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${balanceUser.username}-balance-ledger.csv`;
      link.click();
      URL.revokeObjectURL(url);
  }

  async function exportStatement() {
    if (!balanceUser) return;
    const token = await getToken();
    if (!token) return;
    const params = new URLSearchParams();
    if (statementFrom) params.set("from", new Date(`${statementFrom}T00:00:00`).toISOString());
    if (statementTo) params.set("to", new Date(`${statementTo}T23:59:59.999`).toISOString());
    const statement = await apiFetch<BalanceStatement>(`/users/${balanceUser.id}/balance/statement?${params}`, token);
    const rows = [["Date", "Type", "Amount", "Reason", "Actor"], ...statement.entries.map((entry) => [new Date(entry.createdAt).toISOString(), entry.type, entry.amount.toFixed(2), entry.reason, entry.actor?.username ?? "System"])];
    const url = URL.createObjectURL(new Blob([rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\n")], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${balanceUser.username}-statement.csv`; link.click(); URL.revokeObjectURL(url);
  }

  if (!me) {
    return (
      <>
        {error ? <ErrorToast message={error} onDismiss={() => setError(null)} /> : null}
        <div className="loading-state loading-state-page"><LoadingSpinner label="Loading users" /><span className="muted">Loading users…</span></div>
      </>
    );
  }

  if (creatable.length === 0) {
    return <p className="muted">Your role cannot create users.</p>;
  }

  const childrenByParent = new Map<string | null, UserRow[]>();
  users.forEach((user) => {
    const siblings = childrenByParent.get(user.parentId) ?? [];
    siblings.push(user);
    childrenByParent.set(user.parentId, siblings);
  });
  const userIds = new Set(users.map((user) => user.id));
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visibleUserIds = new Set(
    users
      .filter((user) => !normalizedSearch || `${user.username} ${user.role} ${user.status}`.toLowerCase().includes(normalizedSearch))
      .map((user) => user.id),
  );
  users.forEach((user) => {
    if (!visibleUserIds.has(user.id)) return;
    let parentId = user.parentId;
    while (parentId && userIds.has(parentId)) {
      visibleUserIds.add(parentId);
      parentId = users.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    }
  });
  const visibleUsers = users.filter((user) => visibleUserIds.has(user.id));
  const roots = visibleUsers.filter((user) => user.parentId === null || !userIds.has(user.parentId));

  function renderTreeNode(user: UserRow): ReactNode {
    const children = (childrenByParent.get(user.id) ?? []).filter((child) => visibleUserIds.has(child.id));
    return (
      <div className="tree-node" key={user.id}>
        <div className="tree-row">
          <div className="tree-identity">
            <span className={`status-dot ${user.status === "ACTIVE" ? "is-active" : "is-suspended"}`} />
            <strong>{user.username}</strong>
            <span className="tree-role">{user.role}</span>
            <span className="tree-status">{user.status}</span>
            {user.role !== "SUPER_ADMIN" ? <span className="tree-balance">${Number(user.balance).toFixed(2)}</span> : null}
          </div>
          {user.id !== me?.id ? (
            <div className="user-actions">
              <button
                type="button"
                className="action-menu-trigger secondary"
                disabled={busy}
                onClick={() => setActionMenuId(actionMenuId === user.id ? null : user.id)}
                aria-label={`Actions for ${user.username}`}
                aria-expanded={actionMenuId === user.id}
                aria-haspopup="menu"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="5" r="1.4" />
                  <circle cx="12" cy="12" r="1.4" />
                  <circle cx="12" cy="19" r="1.4" />
                </svg>
              </button>
              {actionMenuId === user.id ? (
                <div className="action-menu" role="menu">
                  {user.parentId === me?.id || me?.role === "SUPER_ADMIN" ? (
                    <button type="button" role="menuitem" onClick={() => openBalance(user)}>
                      <svg className="action-menu-icon dollar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M15.5 7.25c-.55-.85-1.7-1.5-3.5-1.5-2.2 0-3.5 1.1-3.5 2.6 0 4.15 7 1.65 7 5.8 0 1.5-1.3 2.6-3.5 2.6-1.8 0-2.95-.65-3.5-1.5" /></svg>
                      Balance
                    </button>
                  ) : null}
                  {user.role === "OWNER" && me?.role === "SUPER_ADMIN" ? (
                    <button type="button" role="menuitem" onClick={() => { setActionMenuId(null); setCommissionUser(user); }}>
                      <svg className="action-menu-icon dollar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M15.5 7.25c-.55-.85-1.7-1.5-3.5-1.5-2.2 0-3.5 1.1-3.5 2.6 0 4.15 7 1.65 7 5.8 0 1.5-1.3 2.6-3.5 2.6-1.8 0-2.95-.65-3.5-1.5" /></svg>
                      Commission
                    </button>
                  ) : null}
                  <button type="button" role="menuitem" onClick={() => { setActionMenuId(null); beginEdit(user); }}>
                    <svg className="action-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.8 4.3 4.3-.8L19.8 7.7a2.1 2.1 0 0 0-3-3L4 16.5Z" /><path d="m14.8 6.2 3 3" /></svg>
                    Edit
                  </button>
                  {user.role === "PLAYER" && (me?.role === "OWNER" || me?.role === "SUPER_ADMIN") ? (
                    <button type="button" role="menuitem" onClick={() => { setActionMenuId(null); setReassignUser(user); setReassignManagerId(""); setReassignmentPreview(null); }}>
                      <svg className="action-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11M7 7l3-3M7 7l3 3M17 17H6M17 17l-3-3M17 17l-3 3" /></svg>
                      Reassign
                    </button>
                  ) : null}
                  {user.status === "ACTIVE" ? <button type="button" role="menuitem" onClick={() => { setActionMenuId(null); setConfirmation({ action: "suspend", user }); }}>
                    <svg className="action-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1" /><rect x="14" y="4" width="5" height="16" rx="1" /></svg>
                    Suspend
                  </button> : null}
                  <button type="button" role="menuitem" className="danger-menu-item" onClick={() => { setActionMenuId(null); setConfirmation({ action: "delete", user }); }}>
                    <svg className="action-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
                    Delete
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {children.length > 0 ? <div className="tree-children">{children.map((child) => renderTreeNode(child))}</div> : null}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="page-title-row">
        <h1 style={{ margin: 0 }}>Users</h1>
        <button
          type="button"
          className="add-button"
          onClick={() => {
            setError(null);
            setCreateOpen(true);
          }}
          aria-label="Create user"
          title="Create user"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <div className="card tree-card">
        <div className="tree-header">
          <span>Hierarchy</span>
          <span className="muted">{normalizedSearch ? `${visibleUsers.length} of ${users.length}` : users.length} users</span>
        </div>
        <label className="search-field">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
          <input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search users, roles, or status" aria-label="Search users" />
        </label>
        <div className="user-tree">
          {roots.length > 0 ? roots.map((root) => renderTreeNode(root)) : <p className="muted empty-search">No users match your search.</p>}
        </div>
      </div>
      {createOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setCreateOpen(false)}>
          <section className="modal card" role="dialog" aria-modal="true" aria-labelledby="create-user-title">
            <div className="modal-header">
              <h2 id="create-user-title">Create user</h2>
              <button type="button" className="modal-close secondary" onClick={() => setCreateOpen(false)} aria-label="Close">×</button>
            </div>
            <form className="stack" onSubmit={onCreate}>
              <label>
                Username
                <input type="text" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]+" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
              </label>
              <label>
                Initial password
                <input type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </label>
              <label>
                Role
                <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                  {creatable.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              {role === "PLAYER" && me.role === "OWNER" ? (
                <label>
                  Assign to Manager
                  <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                    <option value="">Assign to me</option>
                    {assignableManagers.map((manager) => (
                      <option key={manager.id} value={manager.id}>{manager.username}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</button>
                <button type="submit" disabled={busy}>{busy ? <><LoadingSpinner label="Creating user" size="small" /> Creating…</> : "Create user"}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
      {editingUser ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setEditingUser(null)}>
          <section className="modal card" role="dialog" aria-modal="true" aria-labelledby="edit-user-title">
            <div className="modal-header"><h2 id="edit-user-title">Edit user</h2><button type="button" className="modal-close secondary" onClick={() => setEditingUser(null)} aria-label="Close">×</button></div>
            <form className="stack" onSubmit={onUpdate}>
              <label>Username<input value={editUsername} onChange={(e) => setEditUsername(e.target.value)} minLength={3} maxLength={32} pattern="[A-Za-z0-9_]+" required /></label>
              <label>New password<input type="password" placeholder="Leave blank to keep current password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} minLength={10} /></label>
              <div className="modal-actions"><button type="button" className="secondary" onClick={() => setEditingUser(null)} disabled={busy}>Cancel</button><button type="submit" disabled={busy}>{busy ? <LoadingSpinner label="Saving changes" size="small" /> : "Save changes"}</button></div>
            </form>
          </section>
        </div>
      ) : null}
      {balanceUser ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setBalanceUser(null)}>
          <section className="modal card" role="dialog" aria-modal="true" aria-labelledby="charge-balance-title">
            <div className="modal-header"><h2 id="charge-balance-title">Balance</h2><button type="button" className="modal-close secondary" onClick={() => setBalanceUser(null)} aria-label="Close">×</button></div>
            <p className="muted">Current balance: <strong>${Number(balanceUser.balance).toFixed(2)}</strong> · Limit: <strong>${Number(balanceUser.balanceLimit).toFixed(2)}</strong></p>
            <form className="inline-edit-form" onSubmit={onSetBalanceLimit}>
              <input type="number" min="0.01" step="0.01" max="100000000" value={balanceLimit} onChange={(event) => setBalanceLimit(event.target.value)} aria-label="Manager balance limit" />
              <button type="submit" className="secondary" disabled={busy}>Set limit</button>
            </form>
            <form className="inline-edit-form" onSubmit={onSetManagerCapacity}>
              <input type="number" min="1" step="1" max="100000" value={managerCapacity} onChange={(event) => setManagerCapacity(event.target.value)} aria-label="Manager player capacity" />
              <button type="submit" className="secondary" disabled={busy}>Set player capacity</button>
            </form>
            {me.role === "OWNER" && balanceUser.role === "MANAGER" ? (
              <CommissionRateControl
                userId={balanceUser.id}
                currentRate={Number(balanceUser.commissionRate)}
                label="Manager commission"
                description="What you pay this Manager, without them risking capital."
                onSaved={(rate) => { setBalanceUser({ ...balanceUser, commissionRate: rate }); load().catch(() => undefined); }}
              />
            ) : null}
            <div className="ledger-header"><h3>Transaction history</h3><button type="button" className="secondary" onClick={exportLedger} disabled={balanceLedger.length === 0}>Export CSV</button></div>
            <div className="statement-controls">
              <label>From<input type="date" value={statementFrom} onChange={(event) => setStatementFrom(event.target.value)} /></label>
              <label>To<input type="date" value={statementTo} onChange={(event) => setStatementTo(event.target.value)} /></label>
              <button type="button" className="secondary" onClick={exportStatement}>Export statement</button>
            </div>
            <div className="ledger-list">
              {balanceLedger.length === 0 ? <p className="muted">No transactions yet.</p> : balanceLedger.map((entry) => (
                <div className="ledger-row" key={entry.id}>
                  <div><strong>{entry.type === "DELEGATION" ? "Delegation" : "Adjustment"} <span className="muted">({entry.status ?? "APPROVED"})</span></strong><span className="muted">{entry.reason} · {entry.counterparty ?? entry.actor?.username ?? "System"}</span><a href={`/dashboard/finance/transaction/${entry.id}`}>View receipt</a></div>
                  <div><strong className={entry.amount < 0 ? "ledger-negative" : "ledger-positive"}>{entry.amount < 0 ? "-" : "+"}${Math.abs(entry.amount).toFixed(2)}</strong><time className="muted" dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleDateString()}</time></div>
                  {entry.status === "PENDING" && me.role !== "MANAGER" ? <div className="row"><button type="button" className="secondary" onClick={() => approveTransaction(entry.id, true)} disabled={busy}>Approve</button><button type="button" className="danger-button" onClick={() => approveTransaction(entry.id, false)} disabled={busy}>Reject</button></div> : null}
                </div>
              ))}
            </div>
            {balanceUser.parentId === me?.id || me?.role === "SUPER_ADMIN" ? (
              <form className="stack" onSubmit={onDelegateCredit}>
                <h3>Delegate credit</h3>
                <label>Amount<input type="number" min="0.01" max="1000000" step="0.01" required value={balanceAmount} onChange={(event) => setBalanceAmount(event.target.value)} placeholder="0.00" inputMode="decimal" /></label>
                <label>Reason<input type="text" minLength={3} maxLength={240} required value={balanceReason} onChange={(event) => setBalanceReason(event.target.value)} placeholder="Why is this credit being given?" /></label>
                <div className="modal-actions"><button type="button" className="secondary" onClick={() => setBalanceUser(null)} disabled={busy}>Cancel</button><button type="submit" disabled={busy}>{busy ? <LoadingSpinner label="Saving transaction" size="small" /> : "Delegate credit"}</button></div>
              </form>
            ) : null}
            {me?.role === "SUPER_ADMIN" ? (
              <form className="stack" onSubmit={onAdjustBalance}>
                <h3>Admin adjustment</h3>
                <p className="muted" style={{ margin: 0 }}>A direct correction with no counterparty — use for fixing errors, not routine funding.</p>
                <label>Signed amount<input type="number" min="-1000000" max="1000000" step="0.01" required value={adjustAmount} onChange={(event) => setAdjustAmount(event.target.value)} placeholder="-50.00" inputMode="decimal" /></label>
                <label>Reason<input type="text" minLength={3} maxLength={240} required value={adjustReason} onChange={(event) => setAdjustReason(event.target.value)} placeholder="Why is this adjustment being made?" /></label>
                <div className="modal-actions"><button type="submit" className="secondary" disabled={busy}>{busy ? <LoadingSpinner label="Saving adjustment" size="small" /> : "Apply adjustment"}</button></div>
              </form>
            ) : null}
          </section>
        </div>
      ) : null}
      {commissionUser ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setCommissionUser(null)}>
          <section className="modal card" role="dialog" aria-modal="true" aria-labelledby="commission-title">
            <div className="modal-header"><h2 id="commission-title">Owner commission</h2><button type="button" className="modal-close secondary" onClick={() => setCommissionUser(null)} aria-label="Close">×</button></div>
            <CommissionRateControl
              userId={commissionUser.id}
              currentRate={Number(commissionUser.commissionRate)}
              label={`Commission from ${commissionUser.username}`}
              description="The cut you take from this Owner's business."
              onSaved={(rate) => { setCommissionUser({ ...commissionUser, commissionRate: rate }); load().catch(() => undefined); }}
            />
          </section>
        </div>
      ) : null}
      {reassignUser ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setReassignUser(null)}>
          <section className="modal card" role="dialog" aria-modal="true" aria-labelledby="reassign-title">
            <div className="modal-header"><h2 id="reassign-title">Reassign player?</h2><button type="button" className="modal-close secondary" onClick={() => setReassignUser(null)} aria-label="Close">×</button></div>
            <p>Move <strong>{reassignUser.username}</strong> to a different manager? This action will be recorded and notify the affected accounts.</p>
            <form className="stack" onSubmit={onReassign}>
              <label>New manager              <select required value={reassignManagerId} onChange={(event) => loadReassignmentPreview(event.target.value, reassignUser)}>
                <option value="">Select a manager</option>
                {assignableManagers.filter((manager) => manager.id !== reassignUser.parentId).map((manager) => <option key={manager.id} value={manager.id}>{manager.username} · {users.filter((child) => child.parentId === manager.id && child.role === "PLAYER").length}/{manager.managerCapacity}</option>)}
              </select></label>
              {reassignmentPreview ? <div className={`impact-preview${reassignmentPreview.valid ? "" : " is-invalid"}`}><strong>{reassignmentPreview.valid ? "Ready to reassign" : "Cannot reassign"}</strong><span>{reassignmentPreview.valid ? `Move ${reassignmentPreview.player.username} to ${reassignmentPreview.destination.username}? ${reassignmentPreview.destination.remaining} capacity remaining.` : reassignmentPreview.reason}</span><span>Impact: {reassignmentPreview.impact.movedAccounts} player account affected.</span></div> : null}
              <div className="modal-actions"><button type="button" className="secondary" onClick={() => setReassignUser(null)} disabled={busy}>Cancel</button><button type="submit" disabled={busy || !reassignmentPreview?.valid}>{busy ? <LoadingSpinner label="Reassigning player" size="small" /> : "Confirm reassignment"}</button></div>
            </form>
          </section>
        </div>
      ) : null}
      {confirmation ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setConfirmation(null)}>
          <section className="modal card" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <div className="modal-header"><h2 id="confirm-title">{confirmation.action === "delete" ? "Delete user?" : "Suspend user?"}</h2><button type="button" className="modal-close secondary" onClick={() => setConfirmation(null)} aria-label="Close">×</button></div>
            <p>Are you sure you want to {confirmation.action} <strong>{confirmation.user.username}</strong>{confirmation.action === "delete" ? `? This cannot be undone. ${users.filter((user) => user.parentId === confirmation.user.id).length} direct child account(s) will block deletion until reassigned.` : "?"}</p>
            <div className="modal-actions"><button type="button" className="secondary" onClick={() => setConfirmation(null)} disabled={busy}>Cancel</button><button type="button" className={confirmation.action === "delete" ? "danger-button" : ""} onClick={() => confirmation.action === "delete" ? onDelete(confirmation.user) : onSuspend(confirmation.user.id)} disabled={busy}>{busy ? <LoadingSpinner label="Applying action" size="small" /> : confirmation.action === "delete" ? "Delete user" : "Suspend user"}</button></div>
          </section>
        </div>
      ) : null}
      {error ? <ErrorToast message={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}

function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="error-toast" role="alert">
      <span>{message}</span>
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss error">×</button>
    </div>
  );
}
