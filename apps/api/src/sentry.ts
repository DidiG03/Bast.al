import * as Sentry from "@sentry/node";
export function initSentry() { if (process.env.SENTRY_DSN) Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV ?? "development", tracesSampleRate: 0.1 }); }
