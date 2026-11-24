"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { apiFetch, type TrackerView } from "../lib/api";
import { useI18n } from "./i18n-provider";
import { useTheme } from "./theme-provider";

/** How often an open tracker asks again, so switching it off (or the match ending) takes effect without a reload. */
const RECHECK_MS = 2 * 60_000;
/** A frame that hasn't loaded by then is retried once on its own, then offered to retry by hand. */
const LOAD_TIMEOUT_MS = 15_000;

/**
 * SportScore's live match tracker, above a live football match's markets.
 * Display only: nothing here feeds pauses, prices or bet acceptance. It loads
 * nothing until the panel is near the screen, and the API decides whether to
 * show it at all (the LIVE_TRACKER_ENABLED switch, a confident match id).
 * SportScore's terms ask for a visible dofollow "Powered by SportScore" link
 * on every page with the widget: it is shown whenever the frame is. Their
 * tracker fills the frame's height and needs at least 360px.
 */
export function LiveTracker({ eventId, name }: { eventId: string; name: string }) {
  const { getToken } = useAuth();
  const { t, lang } = useI18n();
  const { theme } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [view, setView] = useState<TrackerView | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** Bumped to load the frame again (a retry), which also restarts its timeout. */
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  /** The frame's box has a size: SportScore's script mounts into it, so the iframe only goes in once it's laid out. */
  const frameBox = useRef<HTMLDivElement>(null);
  const [laidOut, setLaidOut] = useState(false);

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
        // A failed recheck keeps a tracker already showing; a first one that fails shows nothing. It never affects the rest of the page.
        if (!stop) setView((prev) => (prev?.show ? prev : { show: false }));
      }
    };
    void load();
    const timer = window.setInterval(load, RECHECK_MS);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [near, eventId, lang, theme, getToken]);

  const src = view?.show ? view.src : null;
  // A new address, or a retry: loading again from the start.
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src, attempt]);
  // Only once the frame's box is on the page with a size (their script reads it when it starts).
  useEffect(() => {
    const node = frameBox.current;
    if (!src || !node) return;
    const check = () => setLaidOut(node.getBoundingClientRect().width > 0);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [src]);
  // Not loaded in time: one retry on its own, then a message with a button.
  useEffect(() => {
    if (!src || !laidOut || loaded) return;
    const timer = window.setTimeout(() => (attempt === 0 ? setAttempt(1) : setFailed(true)), LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [src, laidOut, loaded, attempt]);

  // Until the API answers there is only an invisible marker, so a match without a tracker never shifts its markets.
  if (!view) return <div ref={box} className="live-tracker-probe" aria-hidden="true" />;
  // The match should have one but none was found (yet): a short line, not a gap. It's asked again every 2 minutes.
  if (!view.show) return view.reason === "unavailable" ? <p className="live-tracker-note muted">{t("Live tracker unavailable just now.")}</p> : null;
  return (
    <section className="live-tracker" aria-label={t("Live tracker")}>
      <div ref={frameBox} className={`live-tracker-frame${loaded ? " is-loaded" : ""}${failed ? " is-failed" : ""}`} aria-busy={!loaded && !failed}>
        {!loaded && !failed ? <span className="live-tracker-loading muted">{t("Loading the live tracker…")}</span> : null}
        {failed ? (
          <div className="live-tracker-fallback" role="status">
            <p>{t("The live tracker isn't loading just now. The score and markets below are unaffected.")}</p>
            <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
              {t("Try again")}
            </button>
            <a href={view.src} target="_blank" rel="noopener" className="text-button">
              {t("Open the tracker in a new tab")}
            </a>
          </div>
        ) : laidOut ? (
          <iframe
            key={`${view.src}#${attempt}`}
            src={view.src}
            title={`${t("Live tracker")}: ${name}`}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="fullscreen"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        ) : null}
      </div>
      {loaded ? (
        // A frame that loaded but stays black (SportScore's own check can block a framed page): reload it, or open it on its own.
        <p className="live-tracker-tools">
          <button type="button" className="text-button live-tracker-reload" onClick={() => setAttempt((n) => n + 1)}>
            {t("Reload tracker")}
          </button>
          {" · "}
          <a href={view.src} target="_blank" rel="noopener" className="text-button">
            {t("Open the tracker in a new tab")}
          </a>
        </p>
      ) : null}
      {/* Required by SportScore's terms (sportscore.com/developers/terms/), since we use their data to pair the
          matches: a visible, crawlable, dofollow link on every page showing their widget. Never hide it. */}
      <p className="live-tracker-credit">
        <a href={view.attributionUrl} rel="dofollow noopener" target="_blank" title="Sports data by SportScore">
          Powered by SportScore
        </a>
      </p>
    </section>
  );
}
