"use client";

import { SignOutButton } from "@clerk/nextjs";

/** Avatar/menu that would expose Clerk email — use a plain sign-out instead. */
export function UserMenu() {
  return (
    <SignOutButton redirectUrl="/sign-in">
      <button type="button" className="secondary sign-out-button" aria-label="Sign out" title="Sign out">
        <svg aria-hidden="true" className="control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 17l5-5-5-5M15 12H3" />
          <path d="M21 19V5a2 2 0 0 0-2-2h-6" />
        </svg>
        <span className="control-label">Sign out</span>
      </button>
    </SignOutButton>
  );
}
