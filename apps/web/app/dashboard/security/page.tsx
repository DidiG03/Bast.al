"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import { LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { useToast } from "../../../components/toaster";
import { UserMenu } from "../../../components/user-menu";
import { apiFetch, type SecurityOverview } from "../../../lib/api";
import { useI18n } from "../../../components/i18n-provider";
import { LanguagePicker } from "../../../components/language-toggle";
import { HelpTip } from "../../../components/help-tip";
import { msg } from "../../../lib/i18n/core";

/** "::ffff:1.2.3.4" is an IPv4 address written the IPv6 way. */
const plainIp = (ip: string) => (ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip);

/** Enough of an address to tell networks apart, not the whole of it: "79.106.•.•", "2a02:4780:…". */
const maskedIp = (ip: string) => (ip.includes(".") ? ip.split(".").slice(0, 2).concat("•", "•").join(".") : `${ip.split(":").slice(0, 2).join(":")}:…`);

/** Longer lists show this many rows until "Show all". */
const ROWS_SHOWN = 4;

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

/** What each sign-in alert is, in words. */
const ALERTS: Record<string, string> = {
  "auth.failure": msg("Suspicious sign-in attempt"),
  "auth.refused": msg("Sign-in refused"),
  "security.integrity_failure": msg("Request stopped by the security check"),
  "auth.new_device": msg("Sign-in from a new device or place"),
};

export default function SecurityPage() {
  const { getToken, sessionId: currentSessionId } = useAuth();
  const { t, tn, ts, date, lang } = useI18n();
  const [allSessions, setAllSessions] = useState(false);
  const [allHistory, setAllHistory] = useState(false);
  const [confirmOthers, setConfirmOthers] = useState(false);
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
    return isInternalIp(plain) ? t("Hosting network") : maskedIp(plain);
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
  async function load() {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    setData(await apiFetch<SecurityOverview>("/users/me/security", token));
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
      setConfirmOthers(false);
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
          <h1 style={{ margin: 0 }}>{t("My account")}</h1>
          <p className="muted report-subtitle">{t("Your password, the devices you're signed in on, and the language.")}</p>
        </div>
      </div>
      <section className="card account-settings">
        <div className="account-setting">
          <div>
            <strong>{t("Password")}<HelpTip text="Change your password here. Use one you don't use anywhere else." /></strong>
            <span className="muted">{t("Change your password or start a password reset.")}</span>
          </div>
          <a className="button-link" href="/security/recovery">{t("Open password recovery")}</a>
        </div>
        <div className="account-setting">
          <div>
            <strong>{t("Language")}<HelpTip text="Pick the language for this site. It only changes it on this device." /></strong>
            <span className="muted">{t("Choose the language Shtatat.al is shown in on this device.")}</span>
          </div>
          <LanguagePicker />
        </div>
        <div className="account-setting">
          <div>
            <strong>{t("Sign out")}<HelpTip text="Leave your account on this device. You will need your username and password to come back." /></strong>
            <span className="muted">{t("End your session on this device.")}</span>
          </div>
          <UserMenu />
        </div>
      </section>
      <section className="card stack">
        <div className="tree-header">
          <h2>{t("Active devices")}<HelpTip text="Phones and computers signed in to your account right now. If you see one that isn't yours, press Sign out next to it, then change your password." /></h2>
          <div className="row tree-header-actions">
            <span className="muted">{tn(data.sessions.length, "{count} session", "{count} sessions")}</span>
            {/* Signing every other device out is asked twice. */}
            {confirmOthers ? (
              <>
                <button type="button" className="danger-button" onClick={revokeOthers}>{tn(data.sessions.length - 1, "Sign out {count} device", "Sign out {count} devices")}</button>
                <button type="button" className="secondary" onClick={() => setConfirmOthers(false)}>{t("Cancel")}</button>
              </>
            ) : (
              <button type="button" className="secondary" onClick={() => setConfirmOthers(true)} disabled={data.sessions.length < 2}>{t("Sign out other devices")}</button>
            )}
          </div>
        </div>
        {data.sessions.length === 0 ? <p className="muted">{t("No active sessions found.")}</p> : null}
        {(allSessions ? data.sessions : data.sessions.slice(0, ROWS_SHOWN)).map((session) => (
          <div className="security-row" key={session.id}>
            <div>
              <strong>{deviceText(session.device, session.browser)}</strong>
              <span className="muted">
                {placeText(session.location)} · {ipText(session.ipAddress)} · {t("Last active {when}", { when: when(session.lastActiveAt) })}
              </span>
            </div>
            {/* The same slot on every row, so they line up: this device can't be signed out from here. */}
            {session.id === currentSessionId ? (
              <button type="button" className="secondary security-this-device" disabled>{t("This device")}</button>
            ) : (
              <button type="button" className="secondary" onClick={() => revoke(session.id)}>{t("Sign out")}</button>
            )}
          </div>
        ))}
        {data.sessions.length > ROWS_SHOWN ? (
          <button type="button" className="text-button security-show-all" onClick={() => setAllSessions((value) => !value)}>
            {allSessions ? t("Show fewer") : t("Show all ({count})", { count: data.sessions.length })}
          </button>
        ) : null}
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Sign-in history")}<HelpTip text="Every time your account was used: on which device, from where, and when. Check it for anything you don't recognise." /></h2>
        {data.loginHistory.length === 0 ? <p className="muted">{t("No successful sign-ins recorded yet.")}</p> : (allHistory ? data.loginHistory : data.loginHistory.slice(0, ROWS_SHOWN)).map((entry) => (
          <div className="security-row" key={entry.id}>
            <div>
              <strong>
                {deviceText(entry.device, entry.browser)}
                {entry.sessionId === currentSessionId ? (
                  <>
                    {" "}
                    <span className="security-badge">{t("This device")}</span>
                  </>
                ) : null}
              </strong>
              <span className="muted">
                {placeText(entry.location)} · {ipText(entry.ipAddress)} · {t("Signed in {when}", { when: when(entry.createdAt) })} · {t("Last seen {when}", { when: when(entry.lastSeenAt) })}
              </span>
            </div>
          </div>
        ))}
        {data.loginHistory.length > ROWS_SHOWN ? (
          <button type="button" className="text-button security-show-all" onClick={() => setAllHistory((value) => !value)}>
            {allHistory ? t("Show fewer") : t("Show all ({count})", { count: data.loginHistory.length })}
          </button>
        ) : null}
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Sign-in alerts")}<HelpTip text="Warnings about your account: refused sign-ins, requests the security check stopped, and sign-ins from a device or place you hadn't used before. Every sign-in is in Sign-in history above." /></h2>
        {data.activity.length === 0 ? <p className="muted">{t("No warnings. Every sign-in is listed in Sign-in history above.")}</p> : data.activity.map((entry) => {
          const where = entry.metadata as { device?: string | null; browser?: string | null; location?: string | null } | null;
          return (
            <div className="security-row" key={entry.id}>
              <div>
                <strong>{t(ALERTS[entry.action] ?? ALERTS["auth.failure"])}</strong>
                <span className="muted">
                  {entry.action === "auth.new_device" ? `${deviceText(where?.device ?? null, where?.browser ?? null)} · ${placeText(where?.location ?? null)} · ` : ""}
                  {ipText(entry.ipAddress)} · {when(entry.createdAt)}
                </span>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
