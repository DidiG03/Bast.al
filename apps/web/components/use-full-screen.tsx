"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

export type FullScreenMode = "off" | "browser" | "page";

/**
 * Full screen for a casino game: the browser's own where it allows a page
 * to (computers, Android); on an iPhone, where Safari doesn't, the game
 * expands over the whole page instead ("page", styled by the game's CSS).
 * Esc leaves either.
 */
export function useFullScreen<T extends HTMLElement>(): { ref: RefObject<T>; mode: FullScreenMode; toggle(): Promise<void> } {
  const ref = useRef<T>(null);
  const [mode, setMode] = useState<FullScreenMode>("off");
  useEffect(() => {
    const sync = () => setMode((current) => (document.fullscreenElement ? "browser" : current === "browser" ? "off" : current));
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMode((current) => (current === "page" ? "off" : current));
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  async function toggle() {
    if (mode === "browser") {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (mode === "page") {
      setMode("off");
      return;
    }
    const element = ref.current;
    if (element?.requestFullscreen && document.fullscreenEnabled) {
      // Some browsers (in-app ones, say) neither refuse nor go full screen; after a second, expand over the page instead.
      const answered = await Promise.race([
        element.requestFullscreen({ navigationUI: "hide" }).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      if (answered && document.fullscreenElement) return;
    }
    setMode("page");
  }

  return { ref, mode, toggle };
}

/** The full-screen button's icon: corners out, or in to leave. */
export function FullScreenIcon({ exit }: { exit: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      {exit ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
    </svg>
  );
}

/** A phone turning sideways, for the "turn your phone" helper. */
export function RotatePhoneIcon() {
  return (
    <svg className="slot-rotate-icon" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="22" y="6" width="20" height="36" rx="4" fill="none" stroke="currentColor" strokeWidth="3" />
      <rect x="14" y="36" width="36" height="20" rx="4" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.55" />
      <path d="M50 14a16 16 0 0 1 4 14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="M54 28l-4-3m4 3l3-4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Whether the phone or computer asks for less motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
