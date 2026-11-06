"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

export type FullScreenMode = "off" | "browser" | "page";

/** The room left under a game, px: the page's bottom edge. */
const GAME_GAP = 14;
/** Less room than this under the title, px, and the game is as tall as the whole screen instead. */
const MIN_GAME_HEIGHT = 340;
/** However short the screen, a game is never squeezed below this, px. */
const MIN_SCREEN_GAME_HEIGHT = 260;
/** A game too tall for its height is shrunk to fit, but never below this share of its size. */
const MIN_GAME_SCALE = 0.72;
/** On a phone, a game is shrunk far less: past this its text and buttons get too small to read and tap, so it grows instead. */
const MIN_PHONE_GAME_SCALE = 0.9;
/** Overflow this small, px, is rounding (a shadow, a border, a zoomed half pixel), not something out of reach. */
const FIT_SLACK = 6;
/** A part of a game sticking out of its place by this much or less, px, is the design (a marquee's buttons). */
const MIN_SPILL = 16;

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

  // Out of full screen, the game is exactly as tall as the screen below the page's title (and above a phone's
  // tab bar): all of it in view, the page scrolling on to the last rounds. On a short screen it can take the whole
  // screen below the top bar, or grow past it, rather than leave anything out of reach. A game the page fixes over the whole
  // screen (a phone held sideways) is left to its CSS, as is full screen.
  useEffect(() => {
    let frame = 0;
    let watch: ResizeObserver | null = null;
    let inside: ResizeObserver | null = null;
    /** The height the game is given, px, and how far it's shrunk to fit it (1: not at all). */
    let given = 0;
    let scale = 1;
    /** The height a game's pictures size themselves by, px: the room it's given, even when it has to grow past that. */
    let sizing = 0;
    // Safari (every browser on an iPhone) sizes container units (cqw, cqh) wrong inside a zoomed element, so the
    // pictures that use them come out too small: there the game is scaled instead, its margins giving back the
    // room the scale doesn't, so it takes exactly the same place on the page.
    const scaleInstead = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Android/.test(navigator.userAgent);
    const apply = (element: T) => {
      element.style.height = `${given / scale}px`;
      // For a game's CSS: its height in its own pixels, to size a picture that would otherwise grow with the width.
      element.style.setProperty("--game-h", `${(sizing || given) / scale}px`);
      if (scale === 1) {
        for (const property of ["zoom", "transform", "transform-origin", "width", "margin-right", "margin-bottom"]) element.style.removeProperty(property);
      } else if (scaleInstead) {
        element.style.transformOrigin = "0 0";
        element.style.transform = `scale(${scale})`;
        element.style.width = `${100 / scale}%`;
        element.style.marginRight = `${100 - 100 / scale}%`;
        element.style.marginBottom = `${given - given / scale}px`;
      } else element.style.setProperty("zoom", `${scale}`);
    };
    /**
     * How tall the game's contents are, px: its own overflow, or a part of it (the stage, say) that its contents
     * spill out of. Only a part that shows what spills: one that hides or scrolls it (the reels' strip) is as tall
     * as it looks. And a few px sticking out (a marquee's buttons, the reels' markers) is the design.
     */
    const needs = (element: T) => {
      let spill = 0;
      for (const child of Array.from(element.children)) {
        if (getComputedStyle(child).overflowY === "visible") spill = Math.max(spill, child.scrollHeight - child.clientHeight);
      }
      return Math.max(element.scrollHeight, element.clientHeight + (spill > MIN_SPILL ? spill : 0));
    };
    const fits = (element: T) => needs(element) <= element.clientHeight + FIT_SLACK;
    /**
     * Shrinks the game, all of it alike, as far as what's in it needs to fit its height (not at all if it fits).
     * Worked out afresh each time, from full size: a few passes, since a game's pictures can size themselves
     * by its height.
     */
    const shrink = (element: T) => {
      const least = window.matchMedia("(max-width: 600px)").matches ? MIN_PHONE_GAME_SCALE : MIN_GAME_SCALE;
      scale = 1;
      sizing = 0;
      apply(element);
      for (let pass = 0; pass < 4; pass += 1) {
        const has = element.clientHeight;
        const want = needs(element);
        if (want <= has + FIT_SLACK || scale <= least) break;
        scale = Math.max(least, Math.floor(scale * (has / want) * 0.995 * 1000) / 1000);
        apply(element);
      }
    };
    /** The room the game can have, px: below the title, and the whole screen below the pinned top bar. */
    let room = { under: 0, whole: 0 };
    /**
     * Picks the game's height: the room below the title; if the game doesn't fit that even shrunk as far as it
     * goes, the whole screen below the top bar (the page scrolls the title away); and if not even that, as tall as
     * it needs, so nothing in it is ever out of reach (its pictures keep the size the screen gave them).
     */
    const settle = () => {
      const element = ref.current;
      if (!element || !room.whole) return;
      given = room.under >= MIN_GAME_HEIGHT ? room.under : room.whole;
      shrink(element);
      if (!fits(element) && room.whole > given) {
        given = room.whole;
        shrink(element);
      }
      if (!fits(element)) {
        sizing = given;
        given = Math.ceil(needs(element) * scale);
        apply(element);
      }
    };
    const fit = () => {
      const element = ref.current;
      if (!element) return;
      if (mode !== "off" || getComputedStyle(element).position === "fixed") {
        given = 0;
        scale = 1;
        sizing = 0;
        room = { under: 0, whole: 0 };
        for (const property of ["height", "zoom", "transform", "transform-origin", "width", "margin-right", "margin-bottom", "--game-h"]) element.style.removeProperty(property);
        return;
      }
      const top = element.getBoundingClientRect().top + window.scrollY;
      const tabs = document.querySelector<HTMLElement>(".mobile-bottom-nav");
      const below = tabs && getComputedStyle(tabs).display !== "none" ? tabs.getBoundingClientRect().height : 0;
      const screen = window.innerHeight - below - GAME_GAP;
      // The bar that stays pinned over the page's top, a short scroll down.
      const bar = document.querySelector<HTMLElement>(".dashboard-topbar");
      const pinned = bar && ["sticky", "fixed"].includes(getComputedStyle(bar).position) ? bar.getBoundingClientRect().height : 0;
      const under = Math.floor(screen - top);
      const whole = Math.floor(Math.max(MIN_SCREEN_GAME_HEIGHT, screen - pinned - GAME_GAP));
      if (under === room.under && whole === room.whole) return;
      room = { under, whole };
      settle();
    };
    /** The frame each piece of work is waiting for, so it runs once a frame however many changes came in. */
    const pending = new Map<() => void, number>();
    const later = (work: () => void) => {
      window.cancelAnimationFrame(pending.get(work) ?? 0);
      pending.set(work, window.requestAnimationFrame(() => {
        pending.delete(work);
        work();
      }));
    };
    const attach = () => {
      const element = ref.current;
      if (!element) {
        frame = window.requestAnimationFrame(attach);
        return;
      }
      fit();
      // The title above can change height (a note appears, a line wraps), and the screen can turn or resize.
      // Each change is fitted on the next frame, not inside the observer's own callback (which would resize what
      // it watches while the browser is still delivering, a "ResizeObserver loop" warning), and once per frame.
      watch = new ResizeObserver(() => later(fit));
      watch.observe(document.body);
      window.addEventListener("resize", fit);
      // What's in the game changes as it's loaded and played (other buttons in play, a result line): fitted again.
      inside = new ResizeObserver(() => later(settle));
      for (const child of Array.from(element.children)) inside.observe(child);
    };
    attach();
    return () => {
      window.cancelAnimationFrame(frame);
      pending.forEach((handle) => window.cancelAnimationFrame(handle));
      watch?.disconnect();
      inside?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [mode]);

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
