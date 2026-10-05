"use client";

import { useEffect, useRef } from "react";

/**
 * Runs `run` every `everyMs` while the page is on screen. A tab in the
 * background or a locked phone asks for nothing; coming back runs it at once
 * if a turn was missed, so what shows is never older than it would have been.
 */
export function usePolling(run: () => void, everyMs: number, enabled = true) {
  const latest = useRef(run);
  latest.current = run;

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let last = Date.now();
    const tick = () => {
      last = Date.now();
      latest.current();
    };
    const start = () => {
      if (timer === undefined) timer = window.setInterval(tick, everyMs);
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") return stop();
      if (Date.now() - last >= everyMs) tick();
      start();
    };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [everyMs, enabled]);
}
