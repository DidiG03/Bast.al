"use client";

import { SignIn } from "@clerk/nextjs";
import { useTheme } from "./theme-provider";

export function SignInForm() {
  const { theme } = useTheme();
  const dark = theme === "dark";

  return (
    <SignIn
      routing="path"
      path="/sign-in"
      signUpUrl="/sign-in"
      forceRedirectUrl="/dashboard"
      appearance={{
        variables: {
          colorPrimary: dark ? "#00c900" : "#008c16",
          colorTextOnPrimaryBackground: dark ? "#031208" : "#ffffff",
          colorBackground: dark ? "#102b20" : "#ffffff",
          colorText: dark ? "#f2f7f4" : "#14241b",
          colorTextSecondary: dark ? "#9bb2a6" : "#617269",
          colorInputBackground: dark ? "#071d14" : "#ffffff",
          colorInputText: dark ? "#f2f7f4" : "#14241b",
          colorNeutral: dark ? "#f2f7f4" : "#14241b",
          borderRadius: "0.6rem",
          fontSize: "1rem",
        },
        elements: {
          rootBox: { width: "100%", maxWidth: "25rem" },
          cardBox: { width: "100%", maxWidth: "100%" },
          formFieldInput: { minHeight: "2.75rem", fontSize: "16px" },
          formButtonPrimary: { minHeight: "2.75rem" },
        },
      }}
    />
  );
}
