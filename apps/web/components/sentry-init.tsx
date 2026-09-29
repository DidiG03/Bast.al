"use client";

import { useEffect } from "react";
import { initSentry } from "../lib/sentry";

/** Turns on error reporting in the browser, once. Renders nothing. */
export function SentryInit() {
  useEffect(() => initSentry("browser"), []);
  return null;
}
