"use client";

import { ClerkLoading, SignIn, useAuth, useClerk } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { useI18n } from "./i18n-provider";
import { useTheme } from "./theme-provider";

/** After this long with the form still not drawn, a line says what's going on. */
const SLOW_FORM_MS = 8_000;

/** Clerk can't read CSS variables, so these mirror the admin palette in admin.css. */
const PALETTE = {
  light: { text: "#18181b", muted: "#71717a", surface: "#ffffff", input: "#ffffff", onPrimary: "#ffffff", danger: "#c93b3b" },
  dark: { text: "#ededef", muted: "#8e8e96", surface: "#19191c", input: "#19191c", onPrimary: "#0b0b0c", danger: "#ef7373" },
};

export function SignInForm() {
  const { theme } = useTheme();
  const { t } = useI18n();
  const colors = PALETTE[theme];
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const [slow, setSlow] = useState(false);
  // Sent here by Sign out before Clerk had finished (UserMenu, `?signed-out=1`): the session is ended here, and the
  // form isn't drawn meanwhile, or Clerk would take the still-open session straight back to the dashboard.
  const [pending, setPending] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("signed-out"));
  useEffect(() => {
    // Taken off the address, so a reload after signing in again doesn't end that new session.
    if (pending) window.history.replaceState(null, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!pending || !isLoaded) return;
    if (!isSignedIn) {
      setPending(false);
      return;
    }
    void signOut().catch(() => undefined).finally(() => setPending(false));
  }, [pending, isLoaded, isSignedIn, signOut]);
  useEffect(() => {
    if (isLoaded) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_FORM_MS);
    return () => window.clearTimeout(timer);
  }, [isLoaded]);

  if (pending && isLoaded && isSignedIn) return <p className="muted sign-in-note">{t("Signing out…")}</p>;

  return (
    <>
      {/* Clerk draws the form a second or two after the page: its shape holds the space meanwhile. */}
      <ClerkLoading>
        {slow ? <p className="muted sign-in-note">{t("The sign-in form is taking a while to load. Check your connection, or reload the page.")}</p> : null}
        <div className="sign-in-skeleton" aria-hidden="true">
          <span className="skeleton-bar is-title" />
          <span className="skeleton-bar is-line" />
          <span className="skeleton-bar is-label" />
          <span className="skeleton-bar is-field" />
          <span className="skeleton-bar is-label" />
          <span className="skeleton-bar is-field" />
          <span className="skeleton-bar is-button" />
        </div>
      </ClerkLoading>
      <SignIn
      routing="path"
      path="/sign-in"
      signUpUrl="/sign-in"
      forceRedirectUrl="/dashboard"
      appearance={{
        variables: {
          colorPrimary: colors.text,
          colorTextOnPrimaryBackground: colors.onPrimary,
          colorBackground: colors.surface,
          colorText: colors.text,
          colorTextSecondary: colors.muted,
          colorInputBackground: colors.input,
          colorInputText: colors.text,
          colorNeutral: colors.text,
          colorDanger: colors.danger,
          fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
          borderRadius: "0.5rem",
          fontSize: "0.9375rem",
        },
        elements: {
          rootBox: { width: "100%" },
          cardBox: { width: "100%", maxWidth: "100%", boxShadow: "none", border: "none", background: "transparent" },
          card: { boxShadow: "none", border: "none", padding: "0", background: "transparent" },
          header: { alignItems: "flex-start", textAlign: "left" },
          logoBox: { display: "none" },
          headerTitle: { fontSize: "1.6rem", fontWeight: 600, letterSpacing: "-0.02em" },
          headerSubtitle: { fontSize: "0.9rem" },
          footer: { background: "transparent", marginTop: "0.5rem" },
          formFieldInput: { minHeight: "2.75rem", fontSize: "16px" },
          formButtonPrimary: { minHeight: "2.75rem", fontWeight: 500, boxShadow: "none", textTransform: "none" },
        },
      }}
      />
    </>
  );
}
