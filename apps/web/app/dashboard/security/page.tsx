"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import { LoadingSpinner } from "../../../components/loading-spinner";
import { UserMenu } from "../../../components/user-menu";
import { apiFetch, type SecurityOverview } from "../../../lib/api";
import { useI18n } from "../../../components/i18n-provider";
import { LanguagePicker } from "../../../components/language-toggle";

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
        <h2 style={{ margin: 0 }}>{t("Sign-in history")}</h2>
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
        <h2 style={{ margin: 0 }}>{t("Sign-in alerts")}</h2>
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
