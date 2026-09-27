"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, type NotificationItem, type NotificationPreferences, type NotificationResponse } from "../lib/api";

function BellIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
}

export function NotificationCenter() {
  const { getToken } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);

  async function load() {
    const token = await getToken();
    if (!token) return;
    const result = await apiFetch<NotificationResponse>("/notifications", token);
    setItems(result.items);
    setUnreadCount(result.unreadCount);
  }

  useEffect(() => {
    load().catch(() => setError("Notifications unavailable"));
    let cancelled = false;
    let controller: AbortController | undefined;
    async function connect() {
      const token = await getToken();
      if (!token || cancelled) return;
      controller = new AbortController();
      const response = await fetch("/api/backend/notifications/stream", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error("stream unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!cancelled) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        if (events.some((event) => event.includes("data:"))) load().catch(() => undefined);
      }
    }
    connect().catch(() => undefined);
    return () => { cancelled = true; controller?.abort(); };
    // getToken is stable for the Clerk session and this intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    catch { setError("Could not load notification preferences"); }
  }

  async function updatePreference(key: keyof NotificationPreferences, value: boolean) {
    const token = await getToken();
    if (!token || !preferences) return;
    try {
      await apiFetch("/notifications/preferences", token, { method: "PATCH", body: JSON.stringify({ [key]: value }) });
      setPreferences({ ...preferences, [key]: value });
    } catch { setError("Could not save notification preferences"); }
  }

  async function markRead(id: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await apiFetch(`/notifications/${id}/read`, token, { method: "POST" });
      setItems((current) => current.map((item) => item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
      setUnreadCount((count) => Math.max(0, count - (items.find((item) => item.id === id)?.readAt ? 0 : 1)));
    } catch {
      setError("Could not update notification");
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
      setError("Could not update notifications");
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
      <button type="button" className="notification-trigger secondary" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ""}`}>
        <BellIcon />
        {unreadCount > 0 ? <span className="notification-badge">{unreadCount > 99 ? "99+" : unreadCount}</span> : null}
        <span className="notification-trigger-label">Notifications</span>
      </button>
      {open ? <button type="button" className="notification-backdrop" aria-label="Close notifications" tabIndex={-1} onClick={() => setOpen(false)} /> : null}
      {open ? (
        <section className="notification-panel card" aria-label="Notification center">
          <div className="notification-panel-header">
            <strong>Notifications</strong>
            <span className="notification-panel-actions"><button type="button" className="text-button" onClick={openPreferences}>Preferences</button><button type="button" className="text-button" onClick={markAllRead} disabled={unreadCount === 0}>Mark all read</button></span>
          </div>
          {error ? <p className="notification-error">{error}</p> : null}
          <div className="notification-list">
            {items.length === 0 ? <p className="muted notification-empty">You’re all caught up.</p> : items.map((item) => (
              <div key={item.id} className={`notification-item${item.readAt ? "" : " is-unread"} notification-severity-${item.severity.toLowerCase()}`}>
                <span className="notification-item-dot" />
                <button type="button" className="notification-item-content" onClick={() => { if (!item.readAt) markRead(item.id); if (deepLink(item)) setOpen(false); }}><span><strong>{item.title}</strong><span>{item.message}</span><small>{item.category} · {item.severity}</small><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></span></button>
                <span className="notification-item-actions"><button type="button" onClick={() => archive(item.id)}>Archive</button><button type="button" onClick={() => remove(item.id)}>Delete</button></span>
              </div>
            ))}
          </div>
          {preferencesOpen && preferences ? <div className="notification-preferences"><strong>Notification preferences</strong>{(["inAppEnabled", "emailEnabled", "financeEnabled", "accountEnabled", "securityEnabled", "systemEnabled"] as const).map((key) => <label key={key}><input type="checkbox" checked={preferences[key]} onChange={(event) => updatePreference(key, event.target.checked)} /> {key.replace("Enabled", "")}</label>)}</div> : null}
        </section>
      ) : null}
    </div>
  );
}
