"use client";

import { useClerk } from "@clerk/nextjs";
import { useState } from "react";
import { useI18n } from "./i18n-provider";
import { LoadingSpinner } from "./loading-spinner";

/** How long sign-out waits for Clerk before going to the sign-in page anyway (which finishes it there). */
const SIGN_OUT_WAIT_MS = 3_000;

/**
 * A plain sign-out (Clerk's avatar menu would show the email). It says
 * "Signing out…" at once, and goes to the sign-in page as soon as Clerk has
 * ended the session, or after SIGN_OUT_WAIT_MS if Clerk is slow: the
 * sign-in page ends a session still open (`?signed-out=1`), so the page
 * never sits there looking signed in.
 */
export function UserMenu() {
  const { t } = useI18n();
  const { signOut } = useClerk();
  const [leaving, setLeaving] = useState(false);

  function leave() {
    if (leaving) return;
    setLeaving(true);
    const away = () => window.location.replace("/sign-in?signed-out=1");
    const timer = window.setTimeout(away, SIGN_OUT_WAIT_MS);
    void signOut()
      .catch(() => undefined)
      .finally(() => {
        window.clearTimeout(timer);
        away();
      });
  }

  return (
    <button type="button" className="secondary sign-out-button" aria-label={t("Sign out")} title={t("Sign out")} onClick={leave} disabled={leaving} aria-busy={leaving}>
      {leaving ? (
        <LoadingSpinner label="Signing out" size="small" />
      ) : (
        <svg aria-hidden="true" className="control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 17l5-5-5-5M15 12H3" />
          <path d="M21 19V5a2 2 0 0 0-2-2h-6" />
        </svg>
      )}
      <span className="control-label">{leaving ? t("Signing out…") : t("Sign out")}</span>
    </button>
  );
}
