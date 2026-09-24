"use client";

import { UserProfile } from "@clerk/nextjs";

export function UserProfilePanel() {
  return <UserProfile routing="hash" />;
}
