"use client";

import { useEffect, useRef } from "react";

/**
 * Keyboard play for the casino. A game marks its buttons with the keys that
 * press them, as `KeyboardEvent.code`s: `data-key="Space"` on Spin,
 * `data-key="KeyH"` on Hit. A key then presses the button carrying it, so it
 * follows exactly the rules the button does: nothing happens while it's
 * disabled. Several buttons can share a key when only one shows at a time
 * (Start, then Cash out).
 *
 * Not while typing in a field, while `paused` (a sheet or panel is open), or
 * with a modifier held, so the browser's own shortcuts still work. Holding a
 * key down presses once, and Space never scrolls the page or presses the
 * button that has focus as well.
 */
export function useGameKeys(paused = false) {
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (pausedRef.current) return;
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-key]")).filter((button) => button.dataset.key?.split(" ").includes(event.code));
      if (buttons.length === 0) return;
      event.preventDefault();
      if (event.type !== "keydown" || event.repeat) return;
      buttons.find((button) => !button.disabled)?.click();
    };
    window.addEventListener("keydown", onKey);
    // Space's own press happens on keyup, on a focused button: stopped here too.
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);
}
