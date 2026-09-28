"use client";

import { useMemo, useRef } from "react";
import { newIdempotencyKey } from "./api";

/**
 * Hands out one-time IDs for money actions. The same request (same path and
 * body) gets the same ID until it succeeds, so a double tap or a retry after a
 * dropped connection is recognised by the server as a repeat. Changing the
 * amount or recipient, or a success, starts a new ID.
 */
export function useIdempotencyKey() {
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  return useMemo(
    () => ({
      keyFor(path: string, body: string) {
        const fingerprint = `${path}\n${body}`;
        if (pending.current?.fingerprint !== fingerprint) {
          pending.current = { fingerprint, key: newIdempotencyKey() };
        }
        return pending.current.key;
      },
      done() {
        pending.current = null;
      },
    }),
    [],
  );
}
