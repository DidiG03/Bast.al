"use client";

import { useI18n } from "./i18n-provider";

/**
 * The one spinner used everywhere. `small` sits inside buttons and rows;
 * `medium` fills a card or a modal while it loads. `label` is English;
 * screen readers get it in the reader's language.
 */
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

/**
 * A page (or a whole section) that isn't ready yet: the spinner, centred, in
 * place of the content. Pages show this until everything they need has
 * loaded, then the content, never half of it.
 */
export function PageLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading-state loading-state-page">
      <LoadingSpinner label={label} />
    </div>
  );
}
