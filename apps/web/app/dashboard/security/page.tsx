"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { useToast } from "../../../components/toaster";
import { UserMenu } from "../../../components/user-menu";
import { apiFetch, type DataResetPreview, type DataResetResult, type MeResponse, type SecurityOverview } from "../../../lib/api";
import { useI18n } from "../../../components/i18n-provider";
import { LanguagePicker } from "../../../components/language-toggle";
import { HelpTip } from "../../../components/help-tip";

/** "::ffff:1.2.3.4" is an IPv4 address written the IPv6 way. */
const plainIp = (ip: string) => (ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip);

/**
 * Addresses that belong to a network in between (a hosting proxy, the local
 * machine), not to the visitor. Older sign-ins were recorded with these
 * before the web app passed on the visitor's own address.
 */
function isInternalIp(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (ip === "::1" || ip === "unknown" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip)) return true;
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  return a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export default function SecurityPage() {
  const { getToken, sessionId: currentSessionId } = useAuth();
  const { t, tn, ts, date, lang } = useI18n();
  const regionNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([lang === "sq" ? "sq" : "en"], { type: "region" });
    } catch {
      return null;
    }
  }, [lang]);

  const ipText = (ip: string | null) => {
    if (!ip) return t("Unknown IP");
    const plain = plainIp(ip);
    return isInternalIp(plain) ? t("Hosting network") : plain;
  };

  /** "Tirana, AL" → "Tirana, Shqipëri" (or "Albania" in English); a bare "AL" → the country. */
  const placeText = (location: string | null) => {
    if (!location) return t("Unknown location");
    const match = /^(?:(.*),\s*)?([A-Z]{2})$/.exec(location.trim());
    if (!match) return location;
    let country = match[2];
    try {
      country = regionNames?.of(match[2]) ?? match[2];
    } catch {
      // Not a region code Intl knows; show it as it is.
    }
    return match[1] ? `${match[1]}, ${country}` : country;
  };

  const deviceText = (device: string | null, browser: string | null) =>
    device || browser ? `${ts(device ?? "Unknown device")} · ${ts(browser ?? "Unknown browser")}` : t("Unknown device");
  const when = (value: string | number) => date(value, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const [data, setData] = useState<SecurityOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const toast = useToast();
  // Super Admin only: deleting all test data before real users start.
  const [me, setMe] = useState<MeResponse | null>(null);
  const [reset, setReset] = useState<DataResetPreview | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetUsername, setResetUsername] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);

  async function load() {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const [overview, profile] = await Promise.all([apiFetch<SecurityOverview>("/users/me/security", token), apiFetch<MeResponse>("/users/me", token)]);
    setData(overview);
    setMe(profile);
    if (profile.role === "SUPER_ADMIN") setReset(await apiFetch<DataResetPreview>("/users/data-reset", token).catch(() => null));
  }

  function closeReset() {
    setResetOpen(false);
    setResetUsername("");
    setResetPassword("");
  }

  async function onReset(event: FormEvent) {
    event.preventDefault();
    setResetting(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const done = await apiFetch<DataResetResult>("/users/data-reset", token, { method: "POST", body: JSON.stringify({ username: resetUsername, password: resetPassword }) });
      closeReset();
      toast.success(tn(done.accounts, "Deleted {count} account and all the test data. The app is ready for real users.", "Deleted {count} accounts and all the test data. The app is ready for real users."));
      await load();
    } catch (err) {
      setResetPassword("");
      toast.error(err instanceof Error ? err.message : t("Couldn't delete the data"));
    } finally {
      setResetting(false);
    }
  }

  useEffect(() => {
    load().catch((err: Error) => {
      setFailed(true);
      toast.error(err.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revoke(id: string) {
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      await apiFetch(`/users/me/sessions/${id}/revoke`, token, { method: "POST" });
      await load();
      toast.success(t("That device was signed out."));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Couldn't sign out that device"));
    }
  }

  async function revokeOthers() {
      try {
        const token = await getToken();
        if (!token) throw new Error(t("You're not signed in"));
        await apiFetch("/users/me/sessions/revoke-others", token, { method: "POST" });
        await load();
        toast.success(t("Your other devices were signed out."));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("Couldn't sign out the other devices"));
    }
  }

  if (!data) {
    return failed ? null : <PageLoading label="Loading security" />;
  }

  return (
    <div className="stack security-page">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Security")}</h1>
          <p className="muted report-subtitle">{t("Manage your signed-in devices and review recent account activity.")}</p>
        </div>
      </div>
      <section className="card stack">
        <div className="tree-header"><h2>{t("Active devices")}<HelpTip text="Phones and computers signed in to your account right now. If you see one that isn't yours, press Sign out next to it, then change your password." /></h2><div className="row tree-header-actions"><span className="muted">{tn(data.sessions.length, "{count} session", "{count} sessions")}</span><button type="button" className="secondary" onClick={revokeOthers}>{t("Sign out other devices")}</button></div></div>
        {data.sessions.length === 0 ? <p className="muted">{t("No active sessions found.")}</p> : data.sessions.map((session) => (
          <div className="security-row" key={session.id}>
            <div>
              <strong>
                {deviceText(session.device, session.browser)}
                {session.id === currentSessionId ? <span className="security-badge">{t("This device")}</span> : null}
              </strong>
              <span className="muted">
                {placeText(session.location)} · {ipText(session.ipAddress)} · {t("Last active {when}", { when: when(session.lastActiveAt) })}
              </span>
            </div>
            {session.id === currentSessionId ? null : (
              <button type="button" className="secondary" onClick={() => revoke(session.id)}>{t("Sign out")}</button>
            )}
          </div>
        ))}
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Sign-in history")}<HelpTip text="Every time your account was used: on which device, from where, and when. Check it for anything you don't recognise." /></h2>
        {data.loginHistory.length === 0 ? <p className="muted">{t("No successful sign-ins recorded yet.")}</p> : data.loginHistory.map((entry) => (
          <div className="security-row" key={entry.id}>
            <div>
              <strong>
                {deviceText(entry.device, entry.browser)}
                {entry.sessionId === currentSessionId ? <span className="security-badge">{t("This device")}</span> : null}
              </strong>
              <span className="muted">
                {placeText(entry.location)} · {ipText(entry.ipAddress)} · {t("Signed in {when}", { when: when(entry.createdAt) })} · {t("Last seen {when}", { when: when(entry.lastSeenAt) })}
              </span>
            </div>
          </div>
        ))}
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Sign-in alerts")}<HelpTip text="Wrong-password tries and other warnings about your account. Many failed tries lock the account for a while, to keep it safe." /></h2>
        {data.activity.length === 0 ? <p className="muted">{t("No sign-in activity recorded.")}</p> : data.activity.map((entry) => (
          <div className="security-row" key={entry.id}>
            <div>
              <strong>{t(entry.action === "auth.failure" ? "Suspicious sign-in attempt" : "Successful sign-in")}</strong>
              <span className="muted">{ipText(entry.ipAddress)} · {when(entry.createdAt)}</span>
            </div>
          </div>
        ))}
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Password")}<HelpTip text="Change your password here. Use one you don't use anywhere else." /></h2>
        <p className="muted">{t("Change your password or start a password reset.")}</p>
        <a className="button-link" href="/security/recovery">{t("Open password recovery")}</a>
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Language")}<HelpTip text="Pick the language for this site. It only changes it on this device." /></h2>
        <p className="muted" style={{ margin: 0 }}>{t("Choose the language Bast.al is shown in on this device.")}</p>
        <LanguagePicker />
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Sign out")}<HelpTip text="Leave your account on this device. You will need your username and password to come back." /></h2>
        <p className="muted" style={{ margin: 0 }}>{t("End your session on this device.")}</p>
        <UserMenu />
      </section>
      {me?.role === "SUPER_ADMIN" && reset ? (
        <section className="card stack data-reset">
          <h2 style={{ margin: 0 }}>{t("Delete all test data")}<HelpTip text="For when you go live. Everything made while testing goes, so real users start from a clean app. Only you can do it, and you confirm it with your username and password." /></h2>
          <p className="muted" style={{ margin: 0 }}>
            {t("Deletes every Owner, Manager and Player with their sign-ins, and everything they did: bets, balances, the ledger, commissions, notifications and the audit log. Your Super Admin account, prices, margins, leagues and matches stay. This can't be undone.")}
          </p>
          {reset.enabled ? (
            <p style={{ margin: 0 }}>
              <strong>{tn(reset.accounts, "Right now: {count} account", "Right now: {count} accounts")}</strong>
              {" · "}
              {tn(reset.bets, "{count} bet", "{count} bets")}
              {" · "}
              {tn(reset.ledgerEntries, "{count} ledger entry", "{count} ledger entries")}
            </p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{t("This is turned off on this server.")}</p>
          )}
          <div>
            <button type="button" className="danger-button" onClick={() => setResetOpen(true)} disabled={!reset.enabled}>
              {t("Delete all test data")}
            </button>
          </div>
        </section>
      ) : null}
      {resetOpen && me && reset ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !resetting && closeReset()}>
          <section className="modal card" role="dialog" aria-modal="true" aria-labelledby="reset-title">
            <div className="modal-header">
              <h2 id="reset-title">{t("Delete all test data?")}</h2>
              <button type="button" className="modal-close secondary" onClick={closeReset} disabled={resetting} aria-label={t("Close")}>×</button>
            </div>
            <p>
              {tn(
                reset.accounts,
                "{count} account, with its sign-in, bets, balance and history, will be deleted for good. Only your Super Admin account stays.",
                "{count} accounts, with their sign-ins, bets, balances and history, will be deleted for good. Only your Super Admin account stays.",
              )}
            </p>
            <form className="stack" onSubmit={onReset}>
              <label>
                {t("Type your username, {name}, to confirm", { name: me.username })}
                <input value={resetUsername} onChange={(event) => setResetUsername(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required />
              </label>
              <label>
                {t("Your password")}
                <input type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} autoComplete="current-password" required />
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={closeReset} disabled={resetting}>{t("Cancel")}</button>
                <button type="submit" className="danger-button" disabled={resetting || resetUsername.trim().toLowerCase() !== me.username.toLowerCase() || !resetPassword}>
                  {resetting ? <LoadingSpinner label="Deleting all test data" size="small" /> : t("Delete everything")}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
