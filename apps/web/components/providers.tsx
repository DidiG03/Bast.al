"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { clerkLocalization } from "../lib/i18n/clerk";
import type { Lang } from "../lib/i18n/core";
import { I18nProvider } from "./i18n-provider";
import { SentryInit } from "./sentry-init";
import { ThemeProvider, type Theme } from "./theme-provider";

export function Providers({ children, initialTheme, lang }: { children: React.ReactNode; initialTheme: Theme | null; lang: Lang }) {
  // Clerk 6 supports this runtime flag, but its installed types omit it.
  return (
    <I18nProvider lang={lang}>
      <ThemeProvider initialTheme={initialTheme}>
        <SentryInit />
        <ClerkProvider
          publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
          signInUrl="/sign-in"
          signUpUrl="/sign-in"
          afterSignOutUrl="/sign-in"
          localization={clerkLocalization(lang)}
          {...{ disableKeyless: true }}
        >
          {children}
        </ClerkProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
