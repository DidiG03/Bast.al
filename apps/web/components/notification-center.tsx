"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useRealtime } from "./realtime-provider";
import { apiFetch, type NotificationItem, type NotificationPreferences, type NotificationResponse } from "../lib/api";
import { serverNow } from "../lib/clock";
import { formatMoney } from "../lib/format";
import { noticeWhen } from "../lib/time";
import { msg } from "../lib/i18n/core";
import { pickLabel } from "../lib/picks";
import { topUpCreditLink } from "../lib/top-up";
import { useI18n, type I18n } from "./i18n-provider";
import { useToast } from "./toaster";

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

/** What the API says about a settled bet besides its words (see SettlementService.announce). */
type BetDetails = {
  bet: "single" | "accumulator" | "builder" | "system";
  outcome: "WON" | "LOST" | "VOID" | "CORRECTED" | "OPEN";
  amount: number;
  stake: number | null;
  event?: string | null;
  score?: string | null;
  pick?: string | null;
  market?: string | null;
  odds?: number | null;
  picks?: number | null;
  /** Why a voided bet was voided (e.g. "placed after a goal that hadn't shown yet"). */
  reason?: string | null;
};

/** A settled bet's details, or null for any other notification (and for those sent before the details were). */
function betDetails(item: NotificationItem): BetDetails | null {
  if (item.type !== "BET_SETTLED" || !item.metadata || typeof item.metadata !== "object") return null;
  const details = item.metadata as Partial<BetDetails>;
  return typeof details.outcome === "string" && typeof details.bet === "string" && typeof details.amount === "number" ? (details as BetDetails) : null;
}

/** `title` carries the amount for a toast; `short` leaves it to the amount beside it in the list. */
type BetNotice = { title: string; short: string; detail: string; amount: string; tone: "won" | "lost" | "void" };

const WON_TITLE: Record<BetDetails["bet"], string> = { single: msg("You won {amount}"), accumulator: msg("Your accumulator won {amount}"), builder: msg("Your bet builder won {amount}"), system: msg("Your system bet paid {amount}") };
const WON_SHORT: Record<BetDetails["bet"], string> = { single: msg("You won"), accumulator: msg("Your accumulator won"), builder: msg("Your bet builder won"), system: msg("Your system bet paid out") };
const LOST_TITLE: Record<BetDetails["bet"], string> = { single: msg("Bet lost"), accumulator: msg("Accumulator lost"), builder: msg("Bet builder lost"), system: msg("System bet lost") };
const VOID_TITLE: Record<BetDetails["bet"], string> = { single: msg("Bet voided"), accumulator: msg("Accumulator voided"), builder: msg("Bet builder voided"), system: msg("System bet voided") };

/**
 * A settled bet said the way a Player reads it: who won or lost, which pick
 * at what score, and the money: "You won 625.00 ALL · Tirana · Match winner ·
 * Tirana v Partizani 2–1". A corrected result keeps the API's own words.
 */
function betNotice(details: BetDetails, i18n: Pick<I18n, "t" | "tn" | "ts">): BetNotice | null {
  const { t, tn, ts } = i18n;
  if (details.outcome !== "WON" && details.outcome !== "LOST" && details.outcome !== "VOID") return null;
  const stake = details.stake !== null ? t("Stake {amount}", { amount: formatMoney(details.stake) }) : null;
  const parts =
    details.bet === "single"
      ? [
          details.picks && details.picks > 1 ? tn(details.picks, "{count} bet", "{count} bets") : details.pick ? pickLabel(details.pick, i18n) + (details.market ? ` · ${ts(details.market)}` : "") : null,
          details.event ? `${details.event}${details.score ? ` ${details.score}` : ""}` : null,
          stake,
        ]
      : [details.picks ? tn(details.picks, "{count} pick", "{count} picks") : null, details.odds ? `@ ${details.odds.toFixed(2)}` : null, stake];
  const detail = parts.filter(Boolean).join(" · ");
  if (details.outcome === "WON") return { title: t(WON_TITLE[details.bet], { amount: formatMoney(details.amount) }), short: t(WON_SHORT[details.bet]), detail, amount: `+${formatMoney(details.amount)}`, tone: "won" };
  if (details.outcome === "LOST") {
    const title = t(LOST_TITLE[details.bet]);
    return { title, short: title, detail, amount: details.stake !== null ? `−${formatMoney(details.stake)}` : "", tone: "lost" };
  }
  // A late void says why, and whether it gave the stake back or took winnings back (a won bet keeps only its stake).
  const title = details.reason ? t("Bet voided: {reason}", { reason: ts(details.reason) }) : t(VOID_TITLE[details.bet]);
  const money = details.amount < 0 ? t("Stake returned and {amount} winnings taken back", { amount: formatMoney(-details.amount) }) : t("Stake returned");
  const amount = details.amount < 0 ? `−${formatMoney(-details.amount)}` : `+${formatMoney(details.amount)}`;
  return { title, short: title, detail: [detail, money].filter(Boolean).join(" · "), amount, tone: "void" };
}

/** Where this device remembers the newest bet result it has already shown, so a result pops up once. */
const shownKey = (userId: string) => `bastal-results-shown:${userId}`;
function readShown(userId: string): string | null {
  try {
    return window.localStorage.getItem(shownKey(userId));
  } catch {
    return null;
  }
}
function saveShown(userId: string, at: string) {
  try {
    const before = window.localStorage.getItem(shownKey(userId));
    if (!before || before < at) window.localStorage.setItem(shownKey(userId), at);
  } catch {
    // Private mode or storage blocked: results may pop up again next time, nothing worse.
  }
}
/** Results older than this aren't brought up again on a device that has never shown any. */
const AWAY_SUMMARY_MS = 24 * 3_600_000;

function BellIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
}

export function NotificationCenter() {
  const { getToken, userId, isLoaded } = useAuth();
  const router = useRouter();
  const i18n = useI18n();
  const { t, tn, ts } = i18n;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const toaster = useToast();
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);

  async function load() {
    const token = await getToken();
    if (!token) return null;
    const result = await apiFetch<NotificationResponse>("/notifications", token);
    setItems(result.items);
    setUnreadCount(result.unreadCount);
    return result;
  }

  /** A settled bet pops up: a win big and bright, a loss quiet; tapping it opens the bet. */
  function showBet(item: NotificationItem, notice: BetNotice) {
    const options = { title: notice.title, onClick: () => void deepLink(item) };
    if (notice.tone === "won") toaster.success(notice.detail, { ...options, celebrate: true, duration: 10_000 });
    else if (notice.tone === "lost") toaster.info(notice.detail, { ...options, loss: true, duration: 7_000 });
    else toaster.info(notice.detail, options);
  }

  // Bets that settled while the Player was away: one toast with what happened, once per device.
  function summarizeAway(list: NotificationItem[]) {
    if (!userId) return;
    const shown = readShown(userId);
    const since = shown ?? new Date(Date.now() - AWAY_SUMMARY_MS).toISOString();
    const missed = list.flatMap((item) => {
      const details = !item.readAt && item.createdAt > since ? betDetails(item) : null;
      const notice = details ? betNotice(details, i18n) : null;
      return details && notice ? [{ item, details, notice }] : [];
    });
    if (missed.length === 0) return;
    saveShown(userId, missed[0].item.createdAt);
    if (missed.length === 1) return showBet(missed[0].item, missed[0].notice);
    const won = missed.filter((entry) => entry.notice.tone === "won");
    const lost = missed.filter((entry) => entry.notice.tone === "lost");
    const winnings = won.reduce((sum, entry) => sum + entry.details.amount, 0);
    const parts = [
      won.length > 0 ? `${tn(won.length, "{count} bet won", "{count} bets won")} (+${formatMoney(winnings)})` : null,
      lost.length > 0 ? tn(lost.length, "{count} bet lost", "{count} bets lost") : null,
      missed.length > won.length + lost.length ? tn(missed.length - won.length - lost.length, "{count} bet voided", "{count} bets voided") : null,
    ].filter(Boolean);
    const open = () => router.push("/dashboard/bet?tab=settled");
    if (won.length > 0) toaster.success(parts.join(" · "), { title: t("While you were away"), onClick: open, celebrate: true, duration: 12_000 });
    else toaster.info(parts.join(" · "), { title: t("While you were away"), onClick: open, loss: lost.length > 0, duration: 9_000 });
  }

  // Once Clerk is ready: right after a reload (a language switch, say) there's no token yet, and loading then left the bell without its count.
  useEffect(() => {
    if (!isLoaded || !userId) return;
    load()
      .then((result) => (result ? summarizeAway(result.items) : undefined))
      .catch(() => toaster.error(t("Notifications aren't available right now")));
    // getToken is stable for the Clerk session and this intentionally runs once per signed-in account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, userId]);

  useRealtime((event) => {
    if (event.type === "notification.created") {
      const incoming = event.notification;
      setItems((current) => current.some((item) => item.id === incoming.id) ? current : [incoming, ...current].slice(0, 50));
      if (!incoming.readAt) setUnreadCount((count) => count + 1);
      const details = betDetails(incoming);
      const notice = details ? betNotice(details, i18n) : null;
      if (notice) {
        if (userId) saveShown(userId, incoming.createdAt);
        showBet(incoming, notice);
        return;
      }
      // New notifications pop up like every other message; a click opens the list.
      const show = incoming.severity === "CRITICAL" ? toaster.error : incoming.severity === "WARNING" ? toaster.warning : incoming.severity === "SUCCESS" ? toaster.success : toaster.info;
      // A settled bet opens the bet itself; a win gets a bigger, brighter toast that stays up longer.
      const win = incoming.type === "BET_SETTLED" && incoming.severity === "SUCCESS";
      show(ts(incoming.message), {
        title: ts(incoming.title),
        onClick: () => {
          if (incoming.type === "BET_SETTLED" && deepLink(incoming)) return;
          setOpen(true);
        },
        ...(win ? { celebrate: true, duration: 10_000 } : {}),
      });
    } else if (event.type === "notifications.changed" || event.type === "resync") {
      load().catch(() => undefined);
    }
  });

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
    catch { toaster.error(t("Couldn't load notification settings")); }
  }

  async function updatePreference(key: keyof NotificationPreferences, value: boolean) {
    const token = await getToken();
    if (!token || !preferences) return;
    try {
      await apiFetch("/notifications/preferences", token, { method: "PATCH", body: JSON.stringify({ [key]: value }) });
      setPreferences({ ...preferences, [key]: value });
    } catch { toaster.error(t("Couldn't save notification settings")); }
  }

  async function markRead(id: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await apiFetch(`/notifications/${id}/read`, token, { method: "POST" });
      setItems((current) => current.map((item) => item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
      setUnreadCount((count) => Math.max(0, count - (items.find((item) => item.id === id)?.readAt ? 0 : 1)));
    } catch {
      toaster.error(t("Couldn't update the notification"));
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
      toaster.error(t("Couldn't update the notifications"));
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

  /** A Player's top-up request: straight to their Credit form, with what they asked for filled in. */
  function creditLink(item: NotificationItem): string | null {
    return topUpCreditLink(item);
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
      {open ? <button type="button" className="notification-backdrop" aria-label={t("Close notifications")} tabIndex={-1} onClick={() => setOpen(false)} /> : null}
      {open ? (
        <section className="notification-panel card" aria-label={t("Notifications")}>
          <div className="notification-panel-header">
            <strong>{t("Notifications")}</strong>
            <span className="notification-panel-actions"><button type="button" className="text-button" onClick={openPreferences}>{t("Settings")}</button><button type="button" className="text-button" onClick={markAllRead} disabled={unreadCount === 0}>{t("Mark all read")}</button></span>
          </div>
          <div className="notification-list">
            {items.length === 0 ? <p className="muted notification-empty">{t("You're all caught up.")}</p> : items.map((item) => {
              const details = betDetails(item);
              const notice = details ? betNotice(details, i18n) : null;
              // The same "Today, 10:45" / "24 October, 10:45" as the Overview's latest updates.
              const when = <time dateTime={item.createdAt}>{noticeWhen(item.createdAt, new Date(serverNow()), i18n)}</time>;
              return (
              <div key={item.id} className={`notification-item${item.readAt ? "" : " is-unread"} notification-severity-${item.severity.toLowerCase()}${notice ? ` is-bet is-${notice.tone}` : ""}`}>
                <span className="notification-item-dot" />
                <button type="button" className="notification-item-content" onClick={() => { if (!item.readAt) markRead(item.id); if (deepLink(item)) setOpen(false); }}>
                  {notice ? (
                    <>
                      <span className={`notification-bet-icon is-${notice.tone}`} aria-hidden="true">{notice.tone === "won" ? "🏆" : notice.tone === "lost" ? "✕" : "↺"}</span>
                      <span>
                        <span className="notification-bet-head">
                          <strong>{notice.short}</strong>
                          {notice.amount ? <strong className={`notification-bet-amount is-${notice.tone}`}>{notice.amount}</strong> : null}
                        </span>
                        <span>{notice.detail}</span>
                        {when}
                      </span>
                    </>
                  ) : (
                    <span><strong>{ts(item.title)}</strong><span>{ts(item.message)}</span><small>{t(CATEGORY_LABELS[item.category] ?? item.category)} · {t(SEVERITY_LABELS[item.severity] ?? item.severity)}</small>{when}</span>
                  )}
                </button>
                <span className="notification-item-actions">{creditLink(item) ? <button type="button" className="is-primary" onClick={() => { if (!item.readAt) markRead(item.id); router.push(creditLink(item)!); setOpen(false); }}>{t("Give credit")}</button> : null}<button type="button" onClick={() => archive(item.id)}>{t("Archive")}</button><button type="button" onClick={() => remove(item.id)}>{t("Delete")}</button></span>
              </div>
              );
            })}
          </div>
          {preferencesOpen && preferences ? <div className="notification-preferences"><strong>{t("Notification settings")}</strong>{(["inAppEnabled", "emailEnabled", "financeEnabled", "accountEnabled", "securityEnabled", "systemEnabled"] as const).map((key) => <label key={key}><input type="checkbox" checked={preferences[key]} onChange={(event) => updatePreference(key, event.target.checked)} /> {t(PREFERENCE_LABELS[key])}</label>)}</div> : null}
        </section>
      ) : null}
    </div>
  );
}
