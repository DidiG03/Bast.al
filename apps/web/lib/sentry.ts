import * as Sentry from "@sentry/nextjs";

/**
 * Error reporting to Sentry, on when NEXT_PUBLIC_SENTRY_DSN is set (the same
 * project as the API's SENTRY_DSN is fine; the environment tells them apart).
 * Without it every call here does nothing, so local development and preview
 * builds never need a DSN.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
let started = false;

export function initSentry(runtime: "browser" | "server") {
  if (!dsn || started) return;
  started = true;
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0.1,
    initialScope: { tags: { app: "web", runtime } },
  });
}

/** Sends an error that an error page caught. `digest` links it to the server log line for the same failure. */
export function reportError(error: Error & { digest?: string }) {
  if (!dsn) return;
  initSentry(typeof window === "undefined" ? "server" : "browser");
  Sentry.captureException(error, error.digest ? { tags: { digest: error.digest } } : undefined);
}
