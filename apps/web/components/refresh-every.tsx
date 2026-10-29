"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Draws a server-rendered page again every `ms` while it's on screen, and on coming back to it after that long, so
 * lists on it (the home page's Top events) don't drift from what can be bet on.
 */
export function RefreshEvery({ ms }: { ms: number }) {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < ms) return;
      last = Date.now();
      router.refresh();
    };
    const timer = window.setInterval(refresh, Math.min(ms, 15_000));
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [ms, router]);
  return null;
}
