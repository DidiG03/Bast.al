"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider, type Theme } from "./theme-provider";

export function Providers({ children, initialTheme }: { children: React.ReactNode; initialTheme: Theme | null }) {
  // Clerk 6 supports this runtime flag, but its installed types omit it.
  return (
    <ThemeProvider initialTheme={initialTheme}>
      <ClerkProvider
        publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
        signInUrl="/sign-in"
        signUpUrl="/sign-in"
        afterSignOutUrl="/sign-in"
        localization={{
          signIn: {
            start: { title: "Sign in", subtitle: "Use the account your team set up for you." },
            password: { title: "Enter your password", subtitle: "" },
          },
        }}
        {...{ disableKeyless: true }}
      >
        {children}
      </ClerkProvider>
    </ThemeProvider>
  );
}
