"use client";

import { useEffect } from "react";

/** Closes a dialog when Escape is pressed. Backdrop clicks are the caller's. */
export function useDismiss(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}
