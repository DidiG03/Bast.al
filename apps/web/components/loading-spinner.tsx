"use client";

import { useI18n } from "./i18n-provider";

/** `label` is English; screen readers get it in the reader's language. */
export function LoadingSpinner({ label = "Loading", size = "medium" }: { label?: string; size?: "small" | "medium" }) {
  const { t } = useI18n();
  label = t(label);
  return (
    <span className={`loading-spinner loading-spinner-${size}`} role="status" aria-label={label}>
      <span className="loading-spinner-ring" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
