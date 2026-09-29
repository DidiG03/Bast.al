"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { LoadingSpinner } from "../../../components/loading-spinner";
import { UserMenu } from "../../../components/user-menu";
import { apiFetch, type SecurityOverview } from "../../../lib/api";
import { useI18n } from "../../../components/i18n-provider";
import { LanguagePicker } from "../../../components/language-toggle";

export default function SecurityPage() {
  const { getToken } = useAuth();
  const { t, tn, date } = useI18n();
  const when = (value: string | number) => date(value, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const [data, setData] = useState<SecurityOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    setData(await apiFetch<SecurityOverview>("/users/me/security", token));
  }

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revoke(id: string) {
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      await apiFetch(`/users/me/sessions/${id}/revoke`, token, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't sign out that device"));
    }
  }

  async function revokeOthers() {
      try {
        const token = await getToken();
        if (!token) throw new Error(t("You're not signed in"));
        await apiFetch("/users/me/sessions/revoke-others", token, { method: "POST" });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : t("Couldn't sign out the other devices"));
    }
  }

  if (!data) {
    return error ? <p className="error">{error}</p> : <div className="loading-state"><LoadingSpinner label="Loading security" /><span className="muted">{t("Loading security…")}</span></div>;
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
        <div className="tree-header"><h2>{t("Active devices")}</h2><div className="row tree-header-actions"><span className="muted">{tn(data.sessions.length, "{count} session", "{count} sessions")}</span><button type="button" className="secondary" onClick={revokeOthers}>{t("Sign out other devices")}</button></div></div>
        {data.sessions.length === 0 ? <p className="muted">{t("No active sessions found.")}</p> : data.sessions.map((session) => (
          <div className="security-row" key={session.id}>
            <div><strong>{session.status === "active" ? t("Active") : session.status}</strong><span className="muted">{t("Last active {when}", { when: when(session.lastActiveAt) })}</span></div>
            <button type="button" className="secondary" onClick={() => revoke(session.id)}>{t("Sign out")}</button>
          </div>
        ))}
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Sign-in history")}</h2>
        {data.loginHistory.length === 0 ? <p className="muted">{t("No successful sign-ins recorded yet.")}</p> : data.loginHistory.map((entry) => (
          <div className="security-row" key={entry.id}>
            <div><strong>{entry.device ?? t("Unknown device")} · {entry.browser ?? t("Unknown browser")}</strong><span className="muted">{entry.ipAddress ?? t("Unknown IP")} · {entry.location ?? t("Unknown location")} · {t("Last seen {when}", { when: when(entry.lastSeenAt) })}</span></div>
          </div>
        ))}
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Sign-in alerts")}</h2>
        {data.activity.length === 0 ? <p className="muted">{t("No sign-in activity recorded.")}</p> : data.activity.map((entry) => (
          <div className="security-row" key={entry.id}>
            <div>
              <strong>{t(entry.action === "auth.failure" ? "Suspicious sign-in attempt" : "Successful sign-in")}</strong>
              <span className="muted">{entry.ipAddress ?? t("Unknown IP")} · {when(entry.createdAt)}</span>
            </div>
          </div>
        ))}
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Password")}</h2>
        <p className="muted">{t("Change your password or start a password reset.")}</p>
        <a className="button-link" href="/security/recovery">{t("Open password recovery")}</a>
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Language")}</h2>
        <p className="muted" style={{ margin: 0 }}>{t("Choose the language Bast.al is shown in on this device.")}</p>
        <LanguagePicker />
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Sign out")}</h2>
        <p className="muted" style={{ margin: 0 }}>{t("End your session on this device.")}</p>
        <UserMenu />
      </section>
    </div>
  );
}
