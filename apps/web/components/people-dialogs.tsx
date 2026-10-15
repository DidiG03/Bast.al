"use client";

import { useAuth } from "@clerk/nextjs";
import { FormEvent, useState, type ReactNode } from "react";
import { apiFetch, type ReassignmentPreview, type UserRow } from "../lib/api";
import { formatMoney } from "../lib/format";
import { ROLE_NAMES, childrenOf, moveDestinations, type Team } from "../lib/people";
import { useIdempotencyKey } from "../lib/use-idempotency-key";
import { useI18n } from "./i18n-provider";
import { LoadingSpinner } from "./loading-spinner";
import { useToast } from "./toaster";

/** A dialog with a title, a close button, and its content. Tapping outside closes it. */
export function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal card people-dialog${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="modal-close secondary" onClick={onClose} aria-label={t("Close")}>×</button>
        </div>
        {children}
      </section>
    </div>
  );
}

/** Runs an API call with the signed-in token. */
function useCall() {
  const { getToken } = useAuth();
  const { t } = useI18n();
  return async <T,>(path: string, init?: RequestInit & { idempotencyKey?: string }) => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    return apiFetch<T>(path, token, init);
  };
}

/**
 * Adds a Player or Manager under you. An Owner adding a Player picks which
 * Manager looks after them (or keeps them). On success the new account and
 * its password go to `onCreated`, to hand over.
 */
export function AddPersonDialog({ people, kind, onClose, onCreated }: { people: Team; kind: "PLAYER" | "MANAGER" | "OWNER"; onClose: () => void; onCreated: (user: UserRow, password: string) => void }) {
  const { t } = useI18n();
  const call = useCall();
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const managers = people.users.filter((user) => user.role === "MANAGER" && user.status === "ACTIVE");
  const title = kind === "PLAYER" ? t("Add a player") : kind === "MANAGER" ? t("Add a manager") : t("Add an owner");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const user = await call<UserRow>("/users", { method: "POST", body: JSON.stringify({ username, password, role: kind, ...(kind === "PLAYER" && parentId ? { parentId } : {}) }) });
      onCreated(user, password);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Create failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>
          {t("Username")}
          <input type="text" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]+" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoFocus />
          <span className="field-hint">{t("Letters, numbers and _ only. They sign in with it.")}</span>
        </label>
        <label>
          {t("Password")}
          <input type="text" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          <span className="field-hint">{t("At least 10 characters. You give it to them; they can change it later.")}</span>
        </label>
        {kind === "PLAYER" && people.me.role === "OWNER" && managers.length > 0 ? (
          <label>
            {t("Who looks after them?")}
            <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">{t("Me")}</option>
              {managers.map((manager) => (
                <option key={manager.id} value={manager.id}>{manager.username}</option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
          <button type="submit" disabled={busy}>{busy ? <LoadingSpinner label="Creating user" size="small" /> : title}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** The new account is ready: its username and password, to give to the person. */
export function AccountReadyDialog({ user, password, onClose, onOpen }: { user: UserRow; password: string; onClose: () => void; onOpen: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${t("Username")}: ${user.username}\n${t("Password")}: ${password}`);
      toast.success(t("Copied. Paste it in a message to them."));
    } catch {
      toast.error(t("Couldn't copy. Write them down instead."));
    }
  }
  return (
    <Dialog title={t("{name} is ready", { name: user.username })} onClose={onClose}>
      <p style={{ margin: 0 }}>{t("Give them these to sign in:")}</p>
      <dl className="account-ready">
        <dt>{t("Username")}</dt>
        <dd>{user.username}</dd>
        <dt>{t("Password")}</dt>
        <dd>{password}</dd>
      </dl>
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={copy}>{t("Copy")}</button>
        <button type="button" onClick={onOpen}>{user.role === "PLAYER" ? t("Give them credit") : t("Open their page")}</button>
      </div>
    </Dialog>
  );
}

/** A new username, or a new password. */
export function EditPersonDialog({ person, onClose, onDone }: { person: UserRow; onClose: () => void; onDone: (message: string) => void }) {
  const { t } = useI18n();
  const call = useCall();
  const toast = useToast();
  const [username, setUsername] = useState(person.username);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await call(`/users/${person.id}/update`, { method: "POST", body: JSON.stringify({ username, ...(password ? { password } : {}) }) });
      onDone(password ? t("Saved. Give {name} the new password.", { name: username }) : t("Changes saved."));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Update failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={t("Change name or password")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>{t("Username")}<input value={username} onChange={(e) => setUsername(e.target.value)} minLength={3} maxLength={32} pattern="[A-Za-z0-9_]+" required /></label>
        <label>
          {t("New password")}
          <input type="text" placeholder={t("Leave blank to keep the current password")} value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} autoComplete="off" />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
          <button type="submit" disabled={busy}>{busy ? <LoadingSpinner label="Saving changes" size="small" /> : t("Save changes")}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Moves money from someone right under you back to your own balance (Super Admin: out of circulation). */
export function TakeBackDialog({ person, onClose, onDone, retire = false }: { person: UserRow; onClose: () => void; onDone: (message: string) => void; retire?: boolean }) {
  const { t } = useI18n();
  const call = useCall();
  const toast = useToast();
  const moneyKey = useIdempotencyKey();
  const balance = Number(person.balance);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const path = `/users/${person.id}/reclaim`;
      // Stored in English like every ledger reason, and shown in the reader's language.
      const body = JSON.stringify({ amount: Number(amount), reason: "Taken back" });
      await call(path, { method: "POST", body, idempotencyKey: moneyKey.keyFor(path, body) });
      moneyKey.done();
      onDone(t("Took back {amount} from {name}.", { amount: formatMoney(Number(amount)), name: person.username }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Reclaiming credit failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={t("Take money back from {name}", { name: person.username })} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>{t("Their balance:")} <strong>{formatMoney(balance)}</strong>. {retire ? t("Super Admin holds no balance: it leaves circulation.") : t("It comes back to your balance.")}</p>
      <form className="stack" onSubmit={submit}>
        <label>{t("Amount")}<input type="number" min="0.01" max={balance} step="0.01" required value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" inputMode="decimal" autoFocus /></label>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={() => setAmount(String(balance))} disabled={busy || balance <= 0}>{t("All of it")}</button>
          <button type="submit" disabled={busy || balance <= 0}>{busy ? <LoadingSpinner label="Reclaiming credit" size="small" /> : t("Take back")}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Blocks or unblocks an account. Blocking a Manager blocks their Players too. */
export function BlockDialog({ people, person, onClose, onDone }: { people: Team; person: UserRow; onClose: () => void; onDone: (message: string) => void }) {
  const { t, tn } = useI18n();
  const call = useCall();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const blocking = person.status === "ACTIVE";
  const under = childrenOf(people, person.id).length;
  async function go() {
    setBusy(true);
    try {
      await call(`/users/${person.id}/${blocking ? "suspend" : "unsuspend"}`, { method: "POST" });
      onDone(blocking ? t("{name} is blocked and can't sign in.", { name: person.username }) : t("{name} can sign in again.", { name: person.username }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : blocking ? t("Suspend failed") : t("Reactivation failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={blocking ? t("Block {name}?", { name: person.username }) : t("Unblock {name}?", { name: person.username })} onClose={onClose}>
      <p style={{ margin: 0 }}>
        {blocking
          ? under > 0
            ? tn(under, "They can't sign in or bet until you unblock them. The {count} person under them is blocked too.", "They can't sign in or bet until you unblock them. The {count} people under them are blocked too.")
            : t("They can't sign in or bet until you unblock them. Their money stays where it is.")
          : t("They can sign in and bet again.")}
      </p>
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
        <button type="button" className={blocking ? "danger-button" : ""} onClick={go} disabled={busy}>
          {busy ? <LoadingSpinner label="Applying action" size="small" /> : blocking ? t("Block") : t("Unblock")}
        </button>
      </div>
    </Dialog>
  );
}

/** Deletes an account made by mistake. One that has bet or moved money can only be blocked. */
export function DeleteDialog({ person, onClose, onDone }: { person: UserRow; onClose: () => void; onDone: (message: string) => void }) {
  const { t } = useI18n();
  const call = useCall();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await call(`/users/${person.id}/delete`, { method: "POST" });
      onDone(t("{name} was deleted.", { name: person.username }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Delete failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={t("Delete {name}?", { name: person.username })} onClose={onClose}>
      <p style={{ margin: 0 }}>{t("Only for an account made by mistake. If they have ever bet or had money, block them instead: their history has to stay.")}</p>
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
        <button type="button" className="danger-button" onClick={go} disabled={busy}>{busy ? <LoadingSpinner label="Applying action" size="small" /> : t("Delete")}</button>
      </div>
    </Dialog>
  );
}

/** Moves a Player to another Manager (or to you). Shows what happens to their balance first. */
export function MoveDialog({ people, person, onClose, onDone }: { people: Team; person: UserRow; onClose: () => void; onDone: (message: string) => void }) {
  const { t, ts } = useI18n();
  const call = useCall();
  const toast = useToast();
  const [to, setTo] = useState("");
  const [preview, setPreview] = useState<ReassignmentPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const destinations = moveDestinations(people, person).filter((user) => user.id !== person.parentId);

  async function choose(id: string) {
    setTo(id);
    setPreview(null);
    if (!id) return;
    try {
      const next = await call<ReassignmentPreview>(`/users/${person.id}/reassignment-preview?managerId=${encodeURIComponent(id)}`);
      setPreview(next);
      if (!next.valid) toast.warning(ts(next.reason), { title: t("Can't move") });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not preview reassignment"));
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await call(`/users/${person.id}/reassign`, { method: "POST", body: JSON.stringify({ managerId: to }) });
      onDone(t("Player moved."));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Reassignment failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={t("Move {name} to another manager", { name: person.username })} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>
          {t("New manager")}
          <select required value={to} onChange={(event) => choose(event.target.value)}>
            <option value="">{t("Choose…")}</option>
            {destinations.map((user) => (
              <option key={user.id} value={user.id}>
                {user.id === people.me.id ? t("Me") : user.role === "OWNER" ? t("{name} (the Owner)", { name: user.username }) : `${user.username} · ${t(ROLE_NAMES[user.role])}`}
              </option>
            ))}
          </select>
        </label>
        {preview?.valid ? (
          <p className="impact-preview" style={{ margin: 0 }}>
            {preview.impact.returnedBalance > 0 && preview.impact.returnedTo
              ? t("Their {amount} goes back to {name}, and they start at 0.00 ALL. Their new manager gives them credit.", { amount: formatMoney(preview.impact.returnedBalance), name: preview.impact.returnedTo })
              : t("Their past bets stay where they were placed.")}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
          <button type="submit" disabled={busy || !preview?.valid}>{busy ? <LoadingSpinner label="Reassigning player" size="small" /> : t("Move")}</button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Super Admin only: corrects a balance directly, up or down, with a reason.
 * Nobody else's balance changes; it's for mistakes, not for giving credit.
 */
export function CorrectBalanceDialog({ person, onClose, onDone }: { person: UserRow; onClose: () => void; onDone: (message: string) => void }) {
  const { t } = useI18n();
  const call = useCall();
  const toast = useToast();
  const moneyKey = useIdempotencyKey();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const change = Number(amount);
  const after = Number(person.balance) + (Number.isFinite(change) ? change : 0);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const path = `/users/${person.id}/adjust-balance`;
      const body = JSON.stringify({ amount: change, reason: reason.trim() });
      await call(path, { method: "POST", body, idempotencyKey: moneyKey.keyFor(path, body) });
      moneyKey.done();
      onDone(t("{name}'s balance is now {amount}.", { name: person.username, amount: formatMoney(after) }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Adjustment failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={t("Correct {name}'s balance", { name: person.username })} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>
        {t("For fixing a mistake. It changes only this balance and is written to the audit log. To give credit, use Give credit instead.")}
      </p>
      <form className="stack" onSubmit={submit}>
        <label>
          {t("Amount")}
          <input type="number" min="-1000000" max="1000000" step="0.01" required value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="-50.00" inputMode="decimal" autoFocus />
          <span className="field-hint">{t("A minus number takes money away.")}</span>
        </label>
        <label>
          {t("Reason")}
          <input type="text" minLength={3} maxLength={240} required value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("Why is this adjustment being made?")} />
        </label>
        {amount && change !== 0 && Number.isFinite(change) ? (
          <p className="impact-preview" style={{ margin: 0 }}>
            {t("{from} becomes {to}.", { from: formatMoney(person.balance), to: formatMoney(after) })}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
          <button type="submit" disabled={busy || !change || reason.trim().length < 3}>{busy ? <LoadingSpinner label="Saving changes" size="small" /> : t("Correct balance")}</button>
        </div>
      </form>
    </Dialog>
  );
}
