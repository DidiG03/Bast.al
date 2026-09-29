"use client";

import { SignIn } from "@clerk/nextjs";
import { useTheme } from "./theme-provider";

/** Clerk can't read CSS variables, so these mirror the admin palette in admin.css. */
const PALETTE = {
  light: { text: "#18181b", muted: "#71717a", surface: "#ffffff", input: "#ffffff", onPrimary: "#ffffff", danger: "#c93b3b" },
  dark: { text: "#ededef", muted: "#8e8e96", surface: "#19191c", input: "#19191c", onPrimary: "#0b0b0c", danger: "#ef7373" },
};

export function SignInForm() {
  const { theme } = useTheme();
  const colors = PALETTE[theme];

  return (
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
  );
}
