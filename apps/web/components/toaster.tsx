"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "./i18n-provider";

export type ToastKind = "success" | "error" | "warning" | "info";
type ToastOptions = { title?: string; onClick?: () => void; duration?: number };
type Toast = ToastOptions & { id: number; kind: ToastKind; message: string };

export type Toaster = {
  success: (message: string, options?: ToastOptions) => void;
  error: (message: string, options?: ToastOptions) => void;
  warning: (message: string, options?: ToastOptions) => void;
  info: (message: string, options?: ToastOptions) => void;
};

/** How long each kind stays up: errors longest, so there's time to read them. */
const DURATION: Record<ToastKind, number> = { success: 4000, info: 5000, warning: 6000, error: 8000 };
const MAX_VISIBLE = 4;

const noop = () => undefined;
const ToastContext = createContext<Toaster>({ success: noop, error: noop, warning: noop, info: noop });

/**
 * Every success, error and warning in the app is shown here, in the corner,
 * never inside the page. Messages are already in the reader's language.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, options: ToastOptions = {}) => {
      if (!message) return;
      const id = nextId.current++;
      setToasts((current) => {
        // The same message again (a retry, a double click) replaces the old one instead of stacking.
        const others = current.filter((toast) => {
          const same = toast.kind === kind && toast.message === message && toast.title === options.title;
          if (same) clearTimeout(timers.current.get(toast.id));
          return !same;
        });
        return [...others, { id, kind, message, ...options }].slice(-MAX_VISIBLE);
      });
      timers.current.set(id, setTimeout(() => dismiss(id), options.duration ?? DURATION[kind]));
    },
    [dismiss],
  );

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const api = useMemo<Toaster>(
    () => ({
      success: (message, options) => push("success", message, options),
      error: (message, options) => push("error", message, options),
      warning: (message, options) => push("warning", message, options),
      info: (message, options) => push("info", message, options),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): Toaster {
  return useContext(ToastContext);
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  const { t } = useI18n();
  const icon: Record<ToastKind, string> = { success: "✓", error: "!", warning: "!", info: "i" };
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === "error" || toast.kind === "warning" ? "alert" : "status"}>
          <span className="toast-icon" aria-hidden="true">
            {icon[toast.kind]}
          </span>
          {toast.onClick ? (
            <button
              type="button"
              className="toast-body toast-body-button"
              onClick={() => {
                toast.onClick?.();
                onDismiss(toast.id);
              }}
            >
              {toast.title ? <strong>{toast.title}</strong> : null}
              <span>{toast.message}</span>
            </button>
          ) : (
            <div className="toast-body">
              {toast.title ? <strong>{toast.title}</strong> : null}
              <span>{toast.message}</span>
            </div>
          )}
          <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label={t("Dismiss")}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
