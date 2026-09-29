"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useRealtime } from "./realtime-provider";
import { apiFetch, type NotificationItem, type NotificationPreferences, type NotificationResponse } from "../lib/api";
import { msg } from "../lib/i18n/core";
import { useI18n } from "./i18n-provider";

const PREFERENCE_LABELS: Record<keyof NotificationPreferences, string> = {
  inAppEnabled: msg("In the app"),
  emailEnabled: msg("By email"),
  financeEnabled: msg("Money"),
  accountEnabled: msg("Account"),
  securityEnabled: msg("Security"),
  systemEnabled: msg("System"),
};

const CATEGORY_LABELS: Record<string, string> = { FINANCE: msg("Money"), ACCOUNT: msg("Account"), SECURITY: msg("Security"), SYSTEM: msg("System") };
const SEVERITY_LABELS: Record<string, string> = { INFO: msg("Info"), SUCCESS: msg("Success"), WARNING: msg("Warning"), CRITICAL: msg("Critical") };

function BellIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
}

export function NotificationCenter() {
  const { getToken } = useAuth();
  const router = useRouter();
  const { t, ts, date } = useI18n();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [toast, setToast] = useState<NotificationItem | null>(null);

  async function load() {
    const token = await getToken();
    if (!token) return;
    const result = await apiFetch<NotificationResponse>("/notifications", token);
    setItems(result.items);
    setUnreadCount(result.unreadCount);
  }

  useEffect(() => {
    load().catch(() => setError(t("Notifications aren't available right now")));
    // getToken is stable for the Clerk session and this intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "notification.created") {
      const incoming = event.notification;
      setItems((current) => current.some((item) => item.id === incoming.id) ? current : [incoming, ...current].slice(0, 50));
      if (!incoming.readAt) setUnreadCount((count) => count + 1);
      setToast(incoming);
    } else if (event.type === "notifications.changed" || event.type === "resync") {
      load().catch(() => undefined);
    }
  });

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  async function openPreferences() {
    const token = await getToken();
    if (!token) return;
    try { setPreferences(await apiFetch<NotificationPreferences>("/notifications/preferences", token)); setPreferencesOpen(true); }
    catch { setError(t("Couldn't load notification settings")); }
  }

  async function updatePreference(key: keyof NotificationPreferences, value: boolean) {
    const token = await getToken();
    if (!token || !preferences) return;
    try {
      await apiFetch("/notifications/preferences", token, { method: "PATCH", body: JSON.stringify({ [key]: value }) });
      setPreferences({ ...preferences, [key]: value });
    } catch { setError(t("Couldn't save notification settings")); }
  }

  async function markRead(id: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await apiFetch(`/notifications/${id}/read`, token, { method: "POST" });
      setItems((current) => current.map((item) => item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
      setUnreadCount((count) => Math.max(0, count - (items.find((item) => item.id === id)?.readAt ? 0 : 1)));
    } catch {
      setError(t("Couldn't update the notification"));
    }
  }

  async function markAllRead() {
    const token = await getToken();
    if (!token) return;
    try {
      await apiFetch("/notifications/read-all", token, { method: "POST" });
      setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
      setUnreadCount(0);
    } catch {
      setError(t("Couldn't update the notifications"));
    }

  }

  async function archive(id: string) {
    const token = await getToken();
    if (!token) return;
    await apiFetch(`/notifications/${id}/archive`, token, { method: "POST" });
    setItems((current) => current.filter((item) => item.id !== id));
  }

  async function remove(id: string) {
    const token = await getToken();
    if (!token) return;
    await apiFetch(`/notifications/${id}`, token, { method: "DELETE" });
    setItems((current) => current.filter((item) => item.id !== id));
  }

  function deepLink(item: NotificationItem) {
    if (item.metadata && typeof item.metadata === "object" && "deepLink" in item.metadata && typeof item.metadata.deepLink === "string") {
      router.push(item.metadata.deepLink);
      return true;
    }
    return false;
  }

  return (
    <div className="notification-center">
      <button type="button" className="notification-trigger secondary" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={unreadCount ? t("Notifications, {count} unread", { count: unreadCount }) : t("Notifications")}>
        <BellIcon />
        {unreadCount > 0 ? <span className="notification-badge">{unreadCount > 99 ? "99+" : unreadCount}</span> : null}
        <span className="notification-trigger-label">{t("Notifications")}</span>
      </button>
      {toast && !open ? (
        <button type="button" className={`notification-toast card notification-severity-${toast.severity.toLowerCase()}`} role="status" onClick={() => { setToast(null); setOpen(true); }}>
          <strong>{ts(toast.title)}</strong>
          <span>{ts(toast.message)}</span>
        </button>
      ) : null}
      {open ? <button type="button" className="notification-backdrop" aria-label={t("Close notifications")} tabIndex={-1} onClick={() => setOpen(false)} /> : null}
      {open ? (
        <section className="notification-panel card" aria-label={t("Notifications")}>
          <div className="notification-panel-header">
            <strong>{t("Notifications")}</strong>
            <span className="notification-panel-actions"><button type="button" className="text-button" onClick={openPreferences}>{t("Settings")}</button><button type="button" className="text-button" onClick={markAllRead} disabled={unreadCount === 0}>{t("Mark all read")}</button></span>
          </div>
          {error ? <p className="notification-error">{error}</p> : null}
          <div className="notification-list">
            {items.length === 0 ? <p className="muted notification-empty">{t("You're all caught up.")}</p> : items.map((item) => (
              <div key={item.id} className={`notification-item${item.readAt ? "" : " is-unread"} notification-severity-${item.severity.toLowerCase()}`}>
                <span className="notification-item-dot" />
                <button type="button" className="notification-item-content" onClick={() => { if (!item.readAt) markRead(item.id); if (deepLink(item)) setOpen(false); }}><span><strong>{ts(item.title)}</strong><span>{ts(item.message)}</span><small>{t(CATEGORY_LABELS[item.category] ?? item.category)} · {t(SEVERITY_LABELS[item.severity] ?? item.severity)}</small><time dateTime={item.createdAt}>{date(item.createdAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time></span></button>
                <span className="notification-item-actions"><button type="button" onClick={() => archive(item.id)}>{t("Archive")}</button><button type="button" onClick={() => remove(item.id)}>{t("Delete")}</button></span>
              </div>
            ))}
          </div>
          {preferencesOpen && preferences ? <div className="notification-preferences"><strong>{t("Notification settings")}</strong>{(["inAppEnabled", "emailEnabled", "financeEnabled", "accountEnabled", "securityEnabled", "systemEnabled"] as const).map((key) => <label key={key}><input type="checkbox" checked={preferences[key]} onChange={(event) => updatePreference(key, event.target.checked)} /> {t(PREFERENCE_LABELS[key])}</label>)}</div> : null}
        </section>
      ) : null}
    </div>
  );
}
