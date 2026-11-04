"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { apiFetch, type TrackerView } from "../lib/api";
import { useI18n } from "./i18n-provider";
import { useTheme } from "./theme-provider";

/** How often an open tracker asks again, so switching it off (or the match ending) takes effect without a reload. */
const RECHECK_MS = 2 * 60_000;

/**
 * SportScore's live match tracker, above a live football match's markets.
 * Display only: nothing here feeds pauses, prices or bet acceptance. It loads
 * nothing until the panel is near the screen, and the API decides whether to
 * show it at all (the LIVE_TRACKER_ENABLED switch, a confident match id).
 * Their tracker fills the frame's height and needs at least 360px.
 */
export function LiveTracker({ eventId, name }: { eventId: string; name: string }) {
  const { getToken } = useAuth();
  const { t, lang } = useI18n();
  const { theme } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [view, setView] = useState<TrackerView | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const node = box.current;
    if (!node || near) return;
    if (typeof IntersectionObserver === "undefined") return setNear(true);
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setNear(true), { rootMargin: "200px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let stop = false;
    const load = async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const next = await apiFetch<TrackerView>(`/tracker/events/${encodeURIComponent(eventId)}?lang=${lang === "sq" ? "sq" : "en"}&theme=${theme === "dark" ? "dark" : "light"}`, token);
        if (!stop) setView((prev) => (prev?.show && next.show && prev.src === next.src ? prev : next));
      } catch {
        // A failed check never shows the tracker; it never affects the rest of the page either.
        if (!stop) setView({ show: false });
      }
    };
    void load();
    const timer = window.setInterval(load, RECHECK_MS);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [near, eventId, lang, theme, getToken]);

  // Until the API answers there is only an invisible marker, so a match without a tracker never shifts its markets.
  if (!view?.show) return view ? null : <div ref={box} className="live-tracker-probe" aria-hidden="true" />;
  return (
    <section className="live-tracker" aria-label={t("Live tracker")}>
      <div className={`live-tracker-frame${loaded ? " is-loaded" : ""}`}>
        <iframe
          key={view.src}
          src={view.src}
          title={`${t("Live tracker")}: ${name}`}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="fullscreen"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </section>
  );
}
