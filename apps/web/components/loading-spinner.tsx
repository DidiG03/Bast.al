"use client";

import { useEffect, useState } from "react";
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

/** After this long a load says so, with a way to try again. */
const SLOW_MS = 10_000;

/**
 * A list that isn't ready yet: grey rows shaped like the real ones, straight away, instead of a bare spinner.
 * After 10 seconds it says it's taking longer than usual and offers to try again.
 */
export function ListSkeleton({ label = "Loading", groups = 3, rows = 3, onRetry }: { label?: string; groups?: number; rows?: number; onRetry?: () => void }) {
  const { t } = useI18n();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="list-skeleton" role="status" aria-label={t(label)}>
      {slow ? (
        <div className="list-skeleton-slow">
          <span>{t("This is taking longer than usual.")}</span>
          <button type="button" className="secondary" onClick={onRetry ?? (() => window.location.reload())}>
            {t("Try again")}
          </button>
        </div>
      ) : null}
      {Array.from({ length: groups }, (_, group) => (
        <div key={group} className="list-skeleton-group" aria-hidden="true">
          <span className="skeleton-bar is-head" />
          {Array.from({ length: rows }, (_, row) => (
            <div key={row} className="list-skeleton-row">
              <span className="skeleton-bar is-name" />
              <span className="skeleton-bar is-odds" />
              <span className="skeleton-bar is-odds" />
              <span className="skeleton-bar is-odds" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
