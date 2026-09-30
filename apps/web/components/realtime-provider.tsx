"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type { NotificationItem } from "../lib/api";

/** Mirrors the API's RealtimeEvent, plus `resync` which fires after a dropped stream comes back. */
export type RealtimeEvent =
  | { type: "notification.created"; notification: NotificationItem }
  | { type: "notifications.changed" }
  | { type: "balance.changed"; balance: number; balanceLimit: number }
  | { type: "bets.changed" }
  | { type: "resync" };

type Listener = (event: RealtimeEvent) => void;

const RealtimeContext = createContext<Set<Listener> | null>(null);

const MAX_BACKOFF_MS = 30_000;

/**
 * Holds one live stream per tab for the signed-in account and hands its
 * events to `useRealtime` subscribers. Pages still load their data on mount,
 * so if the stream can't connect everything keeps working as before; it just
 * isn't live. The stream reconnects on its own, and because events sent while
 * it was down are lost, every reconnect tells subscribers to refetch.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const listenersRef = useRef(new Set<Listener>());

  useEffect(() => {
    const listeners = listenersRef.current;
    const emit = (event: RealtimeEvent) =>
      listeners.forEach((listener) => listener(event));
    let stopped = false;
    let controller: AbortController | undefined;
    let retryTimer: number | undefined;
    let failures = 0;
    let connectedBefore = false;

    async function connect() {
      window.clearTimeout(retryTimer);
      controller?.abort();
      controller = new AbortController();
      try {
        const token = await getToken();
        if (stopped) return;
        if (!token) throw new Error("no session");
        const response = await fetch("/api/backend/realtime/stream", {
          headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok || !response.body)
          throw new Error(`stream unavailable (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder
            .decode(chunk.value, { stream: true })
            .replace(/\r\n?/g, "\n");
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const { type, data } = parseFrame(frame);
            if (type === "ready") {
              failures = 0;
              if (connectedBefore) emit({ type: "resync" });
              connectedBefore = true;
            } else if (type && type !== "ping" && data) {
              try {
                emit(JSON.parse(data) as RealtimeEvent);
              } catch {
                // Ignore a malformed frame rather than dropping the stream.
              }
            }
          }
        }
      } catch {
        failures += 1;
      }
      if (stopped) return;
      // The server closes each stream after a few minutes on purpose, so a
      // clean end reconnects at once; errors back off.
      const delay =
        failures === 0
          ? 0
          : Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (failures - 1));
      retryTimer = window.setTimeout(connect, delay + Math.random() * 500);
    }

    const reconnectNow = () => {
      failures = 0;
      connect();
    };
    const onVisible = () =>
      document.visibilityState === "visible" && failures > 0 && reconnectNow();
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", onVisible);
    connect();

    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      controller?.abort();
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // getToken is stable for the Clerk session; one stream per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <RealtimeContext.Provider value={listenersRef.current}>
      {children}
    </RealtimeContext.Provider>
  );
}

/** Calls `handler` for every live event. Safe outside the provider (it just never fires). */
export function useRealtime(handler: Listener) {
  const listeners = useContext(RealtimeContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!listeners) return;
    const listener: Listener = (event) => handlerRef.current(event);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [listeners]);
}

/** Re-renders the server-rendered parts of the dashboard when this account's balance or bets change. */
export function RealtimeRefresh() {
  const router = useRouter();
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useRealtime((event) => {
    if (event.type !== "balance.changed" && event.type !== "bets.changed" && event.type !== "resync") return;
    // Coalesce a burst of events into one refresh.
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => router.refresh(), 250);
  });
  return null;
}

function parseFrame(frame: string) {
  let type: string | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:"))
      data.push(line.slice(5).replace(/^ /, ""));
  }
  return {
    type: type ?? (data.length ? "message" : null),
    data: data.join("\n"),
  };
}
