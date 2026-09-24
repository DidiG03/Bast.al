"use client";

import { SignIn } from "@clerk/nextjs";

export function SignInForm() {
  return (
    <SignIn
      routing="path"
      path="/sign-in"
      signUpUrl="/sign-in"
      forceRedirectUrl="/dashboard"
    />
  );
}
