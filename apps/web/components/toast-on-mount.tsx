"use client";

import { useEffect } from "react";
import { useToast, type ToastKind } from "./toaster";

/**
 * Lets a server-rendered page raise a toast (for example why the account
 * can't bet) instead of printing the message in the page. `message` is
 * already in the reader's language. Shown once per message.
 */
export function ToastOnMount({ kind, message }: { kind: ToastKind; message: string }) {
  const toast = useToast();
  useEffect(() => {
    toast[kind](message);
  }, [toast, kind, message]);
  return null;
}
