"use client";

import { useEffect, useRef } from "react";

/** Open dialogs that close on Escape, the newest last. Only the newest closes: a confirmation over a form, then the form. */
const open: Array<{ current: () => void }> = [];

function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || open.length === 0) return;
  event.preventDefault();
  open[open.length - 1].current();
}

/** Closes a dialog when Escape is pressed (the top one, when several are open). Backdrop clicks are the caller's. */
export function useDismiss(onClose: () => void) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const entry = latest;
    open.push(entry);
    if (open.length === 1) window.addEventListener("keydown", onKey);
    return () => {
      const index = open.lastIndexOf(entry);
      if (index >= 0) open.splice(index, 1);
      if (open.length === 0) window.removeEventListener("keydown", onKey);
    };
  }, []);
}

/** useDismiss for a dialog drawn inside a page's own markup: put it inside the dialog. */
export function EscapeCloses({ onClose }: { onClose: () => void }) {
  useDismiss(onClose);
  return null;
}
